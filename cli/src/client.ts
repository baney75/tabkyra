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
/** How long one call waits, in all, for a dropped bridge to come back (tests shorten it). */
const RECONNECT_BUDGET_MS = Number(process.env.TABKYRA_RECONNECT_BUDGET_MS) || 40000;

/** Bridge methods under the MCP tool names agents know them by. */
const TOOL_NAMES: Record<string, string> = { evaluate: "run_js", dialog: "handle_dialog", snapshot: "read_page", text: "get_page_text", html: "get_page_html" };

/** What an agent is told when a side-effecting call was cut off: it may have run. */
export function interruptedMessage(method: string): string {
	const tool = TOOL_NAMES[method] ?? method.replace(".", "_");
	return `The browser connection dropped while ${tool} was running (the Tabkyra extension reloaded or restarted), so it may have run. Check the page with read_page before you repeat it; Tabkyra reconnects on your next call.`;
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

/** A welcomed socket, before the client takes it. */
interface Dialed {
	socket: Socket;
	clientId: string;
	extensionConnected: boolean;
}

export class BridgeClient {
	private socket?: Socket;
	private seq = 0;
	/** Requests waiting for a reply, each with the socket it went out on. */
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; socket: Socket }>();
	/** One reconnect at a time: concurrent calls that lost the bridge wait on the same one. */
	private reconnecting?: Promise<void>;
	/** One connect at a time: a call that finds no socket waits on a dial already under way. */
	private connecting?: Promise<void>;
	clientId?: string;
	extensionConnected = false;
	/** Set once the extension has been connected; only a bridge that once worked is worth waiting for. */
	private everConnected = false;

	constructor(private readonly options: ClientOptions) {}

	get connected(): boolean {
		return this.socket !== undefined && !this.socket.destroyed;
	}

	/**
	 * Dial the host and wait for its welcome; gives up after `timeoutMs` (a wedged host). The
	 * socket becomes the client's only once it is welcomed and chosen, so no call writes to a
	 * socket that is about to be dropped. Concurrent connects share one attempt.
	 */
	connect(path?: string, timeoutMs = 5000): Promise<void> {
		this.connecting ??= this.connectNow(path, timeoutMs).finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	private async connectNow(path: string | undefined, timeoutMs: number): Promise<void> {
		if (path) return this.adopt(await this.dial(path, timeoutMs));
		// Several hosts can be alive (two browsers, a stale one): use the newest whose
		// extension is connected, the same socket `tabkyra doctor` and `setup` report on.
		const sockets = listSockets();
		if (sockets.length === 0) throw new Error(NOT_CONNECTED);
		let fallback: Dialed | undefined;
		let lastError: unknown;
		for (const target of sockets) {
			try {
				const dialed = await this.dial(target, timeoutMs);
				if (dialed.extensionConnected) {
					fallback?.socket.destroy();
					return this.adopt(dialed);
				}
				// A host whose extension hasn't said hello yet: keep the first such, drop the rest.
				if (fallback) dialed.socket.destroy();
				else fallback = dialed;
			} catch (err) {
				lastError = err;
			}
		}
		if (fallback) return this.adopt(fallback);
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	/** Make a welcomed socket the client's one socket, closing the one before it. */
	private adopt(dialed: Dialed): void {
		if (this.socket && this.socket !== dialed.socket) this.socket.destroy();
		this.socket = dialed.socket;
		this.clientId = dialed.clientId;
		this.extensionConnected = dialed.extensionConnected;
		if (dialed.extensionConnected) this.everConnected = true;
	}

	private async dial(target: string, timeoutMs: number): Promise<Dialed> {
		if (process.platform !== "win32") assertSecurePath(target, "socket");
		return new Promise<Dialed>((resolve, reject) => {
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
						resolve({ socket, clientId: msg.clientId, extensionConnected: msg.extensionConnected });
					} else this.onMessage(msg, socket);
				}
				// The good frames are delivered first; a bad one still ends this connection.
				if (error) socket.destroy(error);
			});
			socket.on("close", () => {
				clearTimeout(timer);
				// Closed before the welcome: the promise would otherwise never settle.
				if (!welcomed) reject(new Error("Bridge connection closed"));
				// Only what went out on this socket was cut off; requests on a newer one are fine.
				for (const [id, p] of this.pending) {
					if (p.socket !== socket) continue;
					clearTimeout(p.timer);
					this.pending.delete(id);
					p.reject(new Error("Bridge connection closed"));
				}
				if (this.socket === socket) this.socket = undefined;
			});
			const hello: ClientToHost = {
				type: "hello",
				client: { name: this.options.name, session: this.options.session, version: VERSION },
			};
			socket.write(encodeFrame(hello));
		});
	}

	private onMessage(msg: HostToClient, from: Socket): void {
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
			// Only the client's own host speaks for the extension.
			if (from !== this.socket) return;
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
		// One budget for the call's waits, however many times the bridge drops under it. It starts
		// at the first drop: the time the request itself ran (a long wait) isn't charged to it.
		let deadline: number | undefined;
		for (let attempt = 1; ; attempt++) {
			const sent: { socket?: Socket } = {};
			try {
				return await this.callOnce<T>(method, params, timeoutMs, sent);
			} catch (err) {
				const notSent = err instanceof NotSentError || (err instanceof BridgeRpcError && err.rpc.code === ERR.NOT_SENT);
				const interrupted = err instanceof BridgeRpcError && err.rpc.code === ERR.INTERRUPTED;
				if (err instanceof BridgeRpcError && !notSent && !interrupted) throw err;
				if (!notSent && !interrupted && !isConnectionError(err)) throw err;
				const resend = notSent || isIdempotent(method, params);
				// Input cut off in flight is never replayed: say so now, without waiting for the bridge
				// (the next call reconnects on its own).
				if (!resend) throw new BridgeRpcError({ code: ERR.INTERRUPTED, message: interruptedMessage(method) });
				// Status checks report a drop as it is instead of waiting for a reconnect.
				if (options.retry === false) throw new Error(NOT_CONNECTED);
				// Nothing was ever reachable: say so now instead of polling.
				if (!this.everConnected) throw new Error(NOT_CONNECTED);
				// A bridge that keeps dropping is reported, not chased.
				if (attempt >= MAX_ATTEMPTS)
					throw new BridgeRpcError({
						code: ERR.INTERRUPTED,
						message: `The browser connection dropped ${attempt} times in a row during ${TOOL_NAMES[method] ?? method.replace(".", "_")}. Run \`tabkyra doctor\` or ask the user to check the browser, then try again.`,
					});
				// Drop the socket this request used, unless another call already replaced it.
				if (!sent.socket || this.socket === sent.socket) this.close();
				deadline ??= Date.now() + RECONNECT_BUDGET_MS;
				const back = await this.reconnect(deadline - Date.now()).then(
					() => this.extensionConnected,
					() => false,
				);
				if (!back) {
					// The drop outlasted the budget: report it, and don't wait again on the next call.
					this.close();
					this.everConnected = false;
					throw new Error(NOT_CONNECTED);
				}
			}
		}
	}

	/**
	 * Wait for a live host whose extension is connected (the browser respawns the host after a
	 * reload) and dial it. Concurrent callers share one attempt.
	 */
	private reconnect(budgetMs: number): Promise<void> {
		if (this.connected && this.extensionConnected) return Promise.resolve();
		// The shared attempt runs on its own full budget; each caller waits only as long as its own.
		this.reconnecting ??= this.reconnectOnce(RECONNECT_BUDGET_MS).finally(() => {
			this.reconnecting = undefined;
		});
		let timer: NodeJS.Timeout | undefined;
		const mine = new Promise<void>((_, reject) => {
			timer = setTimeout(() => reject(new Error("Bridge unavailable")), Math.max(0, budgetMs));
		});
		return Promise.race([this.reconnecting, mine]).finally(() => clearTimeout(timer));
	}

	private async reconnectOnce(budgetMs: number): Promise<void> {
		const deadline = Date.now() + Math.max(0, budgetMs);
		let lastError: unknown;
		while (Date.now() < deadline) {
			try {
				if (!this.connected) await this.connect();
				if (this.extensionConnected) return;
			} catch (err) {
				lastError = err;
			}
			// Host is up but the extension has not said hello yet, or no host yet: give it a moment.
			await new Promise((r) => setTimeout(r, 500));
			if (this.connected && this.extensionConnected) return;
		}
		throw lastError instanceof Error ? lastError : new Error("Bridge unavailable");
	}

	private async callOnce<T>(method: string, params: Record<string, unknown>, timeoutMs?: number, sent: { socket?: Socket } = {}): Promise<T> {
		if (!this.connected) {
			try {
				await this.connect();
			} catch (err) {
				throw isConnectionError(err) ? new NotSentError(err) : err;
			}
		}
		const socket = this.socket;
		if (!socket || socket.destroyed) throw new NotSentError(new Error("Not connected"));
		sent.socket = socket;
		const id = ++this.seq;
		const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? 120000;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out after ${timeout} ms`));
			}, timeout);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, socket });
			const req: ClientToHost = { type: "request", id, method, params };
			socket.write(encodeFrame(req));
		});
	}

	close(): void {
		this.socket?.destroy();
		this.socket = undefined;
	}
}
