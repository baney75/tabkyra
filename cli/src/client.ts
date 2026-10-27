/**
 * Socket client: dials the native host's unix socket, checks its ownership, and
 * exposes request/response plus events. One instance per harness process.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { ClientToHost, HostToClient, RpcError } from "../../src/bridge/protocol.ts";
import { ERR, isIdempotent, MAX_FRAME_FROM_EXTENSION } from "../../src/bridge/protocol.ts";
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

/** A connection failure before the request was written: it never reached the browser. */
class NotSentError extends Error {
	constructor(readonly cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		const code = (cause as { code?: string } | undefined)?.code;
		if (code) (this as { code?: string }).code = code;
	}
}

/** Sends of one request, counting the first, when it is safe to resend. */
const MAX_ATTEMPTS = 3;

/** Bridge methods under the MCP tool names agents know them by. */
const TOOL_NAMES: Record<string, string> = { evaluate: "run_js", dialog: "handle_dialog", snapshot: "read_page", text: "get_page_text", html: "get_page_html" };

/** What an agent is told when a side-effecting call was cut off: it may have run. */
export function interruptedMessage(method: string, reconnected: boolean): string {
	const tool = TOOL_NAMES[method] ?? method.replace(".", "_");
	return (
		`The browser connection dropped while ${tool} was running (the Tabkyra extension reloaded or restarted), so it may have run. ` +
		(reconnected ? "The connection is back: check the page (read_page) before repeating it." : "Check the page once Tabkyra reconnects, before repeating it.")
	);
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
	/** Set once the extension has been connected; only a bridge that once worked is worth waiting for. */
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
				const { messages, error } = parser.push(chunk);
				for (const m of messages) {
					const msg = m as HostToClient;
					if (msg.type === "welcome") {
						welcomed = true;
						clearTimeout(timer);
						this.clientId = msg.clientId;
						this.extensionConnected = msg.extensionConnected;
						if (msg.extensionConnected) this.everConnected = true;
						resolve();
					} else this.onMessage(msg);
				}
				// The good frames are delivered first; a bad one still ends this connection.
				if (error) socket.destroy(error);
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
			if (msg.connected) this.everConnected = true;
			this.options.onExtensionStatus?.(msg.connected);
		}
	}

	/**
	 * Call, surviving a dropped bridge (extension reload, service worker restart, host respawn).
	 * The session key is stable, so a resent request lands on the same tabs. A request that never
	 * left (no socket yet, or the host refused it as `not_sent`) is sent once the bridge is back.
	 * A request cut off in flight may have run: a read (isIdempotent) is resent, anything else
	 * fails with `interrupted` and is never replayed. Other RPC errors are never retried.
	 */
	async call<T = unknown>(
		method: string,
		params: Record<string, unknown> = {},
		timeoutMs?: number,
		options: { retry?: boolean } = {},
	): Promise<T> {
		for (let attempt = 1; ; attempt++) {
			try {
				return await this.callOnce<T>(method, params, timeoutMs);
			} catch (err) {
				const notSent = err instanceof NotSentError || (err instanceof BridgeRpcError && err.rpc.code === ERR.NOT_SENT);
				const interrupted = err instanceof BridgeRpcError && err.rpc.code === ERR.INTERRUPTED;
				if (err instanceof BridgeRpcError && !notSent && !interrupted) throw err;
				if (!notSent && !interrupted && !isConnectionError(err)) throw err;
				const resend = notSent || isIdempotent(method, params);
				const cutOff = () => new BridgeRpcError({ code: ERR.INTERRUPTED, message: interruptedMessage(method, false) });
				// Status checks report a drop as it is instead of waiting for a reconnect.
				if (options.retry === false) throw resend ? new Error(NOT_CONNECTED) : cutOff();
				// Nothing was ever reachable: say so now instead of polling for 40 s.
				if (!this.everConnected) throw resend ? new Error(NOT_CONNECTED) : cutOff();
				this.close();
				let back = true;
				try {
					await this.reconnect(40000);
				} catch {
					back = false;
				}
				// A host came back but the extension didn't: a request now would only time out.
				if (back && !this.extensionConnected) {
					this.close();
					back = false;
				}
				if (!back) {
					// The drop outlasted the wait: report it, and don't wait again on the next call.
					this.everConnected = false;
					if (resend) throw new Error(NOT_CONNECTED);
					throw new BridgeRpcError({ code: ERR.INTERRUPTED, message: `${interruptedMessage(method, false)} ${NOT_CONNECTED}` });
				}
				if (!resend) throw new BridgeRpcError({ code: ERR.INTERRUPTED, message: interruptedMessage(method, true) });
				// A bridge that keeps dropping is reported, not chased forever.
				if (attempt >= MAX_ATTEMPTS)
					throw new BridgeRpcError({
						code: ERR.INTERRUPTED,
						message: `The browser connection dropped ${attempt} times in a row during ${TOOL_NAMES[method] ?? method.replace(".", "_")}. Run \`tabkyra doctor\` or ask the user to check the browser, then try again.`,
					});
			}
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
		if (!this.connected) {
			try {
				await this.connect();
			} catch (err) {
				throw isConnectionError(err) ? new NotSentError(err) : err;
			}
		}
		const socket = this.socket;
		if (!socket || socket.destroyed) throw new NotSentError(new Error("Not connected"));
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
