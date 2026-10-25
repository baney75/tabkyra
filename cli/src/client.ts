/**
 * Socket client: dials the native host's unix socket, checks its ownership, and
 * exposes request/response plus events. One instance per harness process.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { ClientToHost, HostToClient, RpcError } from "../../src/bridge/protocol.ts";
import { MAX_FRAME_FROM_EXTENSION } from "../../src/bridge/protocol.ts";
import { encodeFrame, FrameParser } from "./framing.ts";
import { assertSecurePath, socketDir } from "./paths.ts";
import { VERSION } from "./version.ts";

/** What every tool says when no browser is reachable: the agent can only ask the user. */
export const NOT_CONNECTED =
	"Tabkyra isn't connected. Ask the user to open Helium/Chrome with the Tabkyra extension loaded, or run `tabkyra doctor`.";

export class BridgeRpcError extends Error {
	constructor(readonly rpc: RpcError) {
		super(rpc.message);
	}
}

export interface ClientOptions {
	name: string;
	session?: string;
	/** Fires for permission prompts and other pushed events. */
	onEvent?: (event: string, data: Record<string, unknown>) => void;
	onExtensionStatus?: (connected: boolean) => void;
	requestTimeoutMs?: number;
}

/** Live sockets, newest host first. */
export function listSockets(): string[] {
	const dir = socketDir();
	if (process.platform === "win32") return [dir];
	if (!existsSync(dir)) return [];
	assertSecurePath(dir, "dir");
	return readdirSync(dir)
		.filter((n) => n.endsWith(".sock"))
		.map((n) => join(dir, n))
		.filter((p) => {
			const pid = Number.parseInt(p.slice(p.lastIndexOf("/") + 1), 10);
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		})
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export function isConnectionError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	const code = (err as { code?: string } | undefined)?.code;
	return (
		message === "Bridge connection closed" ||
		message === "Not connected" ||
		message === NOT_CONNECTED ||
		code === "ECONNREFUSED" ||
		code === "ENOENT" ||
		code === "EPIPE" ||
		code === "ECONNRESET"
	);
}

export class BridgeClient {
	private socket?: Socket;
	private seq = 0;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	clientId?: string;
	extensionConnected = false;
	/** Set after the first welcome; only a bridge that once worked is worth waiting for. */
	private everConnected = false;

	constructor(private readonly options: ClientOptions) {}

	get connected(): boolean {
		return this.socket !== undefined && !this.socket.destroyed;
	}

	/** Dial the host and wait for its welcome; gives up after `timeoutMs` (a wedged host). */
	async connect(path?: string, timeoutMs = 5000): Promise<void> {
		if (path) return this.dial(path, timeoutMs);
		// Several hosts can be alive (two browsers, a stale one): use the newest whose
		// extension is connected, the same socket `tabkyra doctor` and `setup` report on.
		const sockets = listSockets();
		if (sockets.length === 0) {
			throw new Error(NOT_CONNECTED);
		}
		let fallback: string | undefined;
		let lastError: unknown;
		for (const socket of sockets) {
			try {
				await this.dial(socket, timeoutMs);
				if (this.extensionConnected) return;
				fallback ??= socket;
				this.close();
			} catch (err) {
				lastError = err;
			}
		}
		if (fallback) return this.dial(fallback, timeoutMs);
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	private async dial(target: string, timeoutMs: number): Promise<void> {
		if (process.platform !== "win32") assertSecurePath(target, "socket");
		await new Promise<void>((resolve, reject) => {
			const socket = connect(target);
			const parser = new FrameParser(MAX_FRAME_FROM_EXTENSION);
			let welcomed = false;
			const timer = setTimeout(() => {
				if (welcomed) return;
				reject(new Error(`The bridge at ${target} did not answer within ${timeoutMs} ms`));
				socket.destroy();
			}, timeoutMs);
			socket.once("error", (err) => {
				clearTimeout(timer);
				if (!welcomed) reject(err);
			});
			socket.on("data", (chunk) => {
				let messages: unknown[];
				try {
					messages = parser.push(chunk);
				} catch (err) {
					socket.destroy(err as Error);
					return;
				}
				for (const m of messages) {
					const msg = m as HostToClient;
					if (msg.type === "welcome") {
						welcomed = true;
						clearTimeout(timer);
						this.everConnected = true;
						this.clientId = msg.clientId;
						this.extensionConnected = msg.extensionConnected;
						resolve();
					} else this.onMessage(msg);
				}
			});
			socket.on("close", () => {
				clearTimeout(timer);
				// Closed before the welcome: the promise would otherwise never settle.
				if (!welcomed) reject(new Error("Bridge connection closed"));
				for (const p of this.pending.values()) {
					clearTimeout(p.timer);
					p.reject(new Error("Bridge connection closed"));
				}
				this.pending.clear();
				if (this.socket === socket) this.socket = undefined;
			});
			this.socket = socket;
			const hello: ClientToHost = {
				type: "hello",
				client: { name: this.options.name, session: this.options.session, version: VERSION },
			};
			socket.write(encodeFrame(hello));
		});
	}

	private onMessage(msg: HostToClient): void {
		if (msg.type === "response") {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.error) p.reject(new BridgeRpcError(msg.error));
			else p.resolve(msg.result);
		} else if (msg.type === "event") {
			this.options.onEvent?.(msg.event, msg.data);
		} else if (msg.type === "extension_status") {
			this.extensionConnected = msg.connected;
			this.options.onExtensionStatus?.(msg.connected);
		}
	}

	/**
	 * Call with one transparent retry when the bridge itself dropped (extension reload,
	 * service worker restart, host respawn). The session key is stable, so the retry
	 * lands on the same tabs. RPC errors from the extension are never retried.
	 */
	async call<T = unknown>(
		method: string,
		params: Record<string, unknown> = {},
		timeoutMs?: number,
		options: { retry?: boolean } = {},
	): Promise<T> {
		try {
			return await this.callOnce<T>(method, params, timeoutMs);
		} catch (err) {
			if (err instanceof BridgeRpcError || !isConnectionError(err)) throw err;
			// Status checks report a drop as it is instead of waiting for a reconnect.
			if (options.retry === false) throw new Error(NOT_CONNECTED);
			// Nothing was ever reachable: say so now instead of polling for 40 s.
			if (!this.everConnected) throw new Error(NOT_CONNECTED);
			this.close();
			await this.reconnect(40000);
			return this.callOnce<T>(method, params, timeoutMs);
		}
	}

	/** Wait for a live host socket (the browser respawns it after a reload) and dial it. */
	private async reconnect(budgetMs: number): Promise<void> {
		const deadline = Date.now() + budgetMs;
		let lastError: unknown;
		while (Date.now() < deadline) {
			try {
				await this.connect();
				if (this.extensionConnected) return;
				// Host is up but the extension has not said hello yet; give it a moment.
				await new Promise((r) => setTimeout(r, 500));
				if (this.extensionConnected) return;
			} catch (err) {
				lastError = err;
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		if (!this.connected) throw lastError instanceof Error ? lastError : new Error("Bridge unavailable");
	}

	private async callOnce<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
		if (!this.connected) await this.connect();
		const socket = this.socket;
		if (!socket) throw new Error("Not connected");
		const id = ++this.seq;
		const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 120000;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out after ${timeout} ms`));
			}, timeout);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			const req: ClientToHost = { type: "request", id, method, params };
			socket.write(encodeFrame(req));
		});
	}

	close(): void {
		this.socket?.destroy();
		this.socket = undefined;
	}
}
