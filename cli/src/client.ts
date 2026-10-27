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
	path: string;
	clientId: string;
}

/** Waits between resends of a request a live host refused as not_sent (it never ran). */
const NOT_SENT_BACKOFF_MS = [250, 500, 1000, 2000];

export class BridgeClient {
	private socket?: Socket;
	/** The socket file the client's socket was dialed at. */
	private socketPath?: string;
	private seq = 0;
	/** Requests waiting for a reply, each with the socket it went out on. */
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; socket: Socket }>();
	/** One reconnect at a time: concurrent calls that lost the bridge wait on the same one. */
	private reconnecting?: Promise<void>;
	/** One connect at a time: a call that finds no socket waits on a dial already under way. */
	private connecting?: Promise<void>;
	/**
	 * What each socket's host last said about its extension and browser, from the welcome on: a
	 * status can arrive before the client adopts the socket, and must not be lost.
	 */
	private socketExtension = new WeakMap<Socket, boolean>();
	private socketBrowser = new WeakMap<Socket, string>();
	/**
	 * The browser this client works in, once known. Resends and reconnects stay with it: with
	 * two browsers running Tabkyra, a request is never resent to the other one.
	 */
	private browserId?: string;
	clientId?: string;
	extensionConnected = false;
	/** Set once the extension has been connected; only a bridge that once worked is worth waiting for. */
	private everConnected = false;

	constructor(private readonly options: ClientOptions) {}

	/** A socket the client can write to now. A half-closed one (the host ended it) doesn't count. */
	get connected(): boolean {
		return this.socket !== undefined && !this.socket.destroyed && this.socket.writable;
	}

	/** Whether a socket's host reached an extension in this client's browser. */
	private ready(socket: Socket): boolean {
		if (!this.socketExtension.get(socket)) return false;
		const browser = this.socketBrowser.get(socket);
		return !this.browserId || !browser || browser === this.browserId;
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
		// Several hosts can be alive (two browsers, a stale one): use the newest whose extension
		// is connected (in this client's browser, once it has one), the same socket `tabkyra
		// doctor` and `setup` report on.
		const sockets = listSockets();
		if (sockets.length === 0) throw new Error(NOT_CONNECTED);
		let fallback: Dialed | undefined;
		let lastError: unknown;
		for (const target of sockets) {
			try {
				const dialed = await this.dial(target, timeoutMs);
				if (this.ready(dialed.socket)) {
					if (fallback && fallback.socket !== this.socket) fallback.socket.destroy();
					return this.adopt(dialed);
				}
				const browser = this.socketBrowser.get(dialed.socket);
				// Another browser's host is never a fallback; one whose extension hasn't said hello
				// yet may be ours.
				if (fallback || (this.browserId && browser && browser !== this.browserId)) dialed.socket.destroy();
				else fallback = dialed;
			} catch (err) {
				lastError = err;
			}
		}
		if (fallback) return this.adopt(fallback);
		throw lastError instanceof Error ? lastError : new Error(String(lastError ?? NOT_CONNECTED));
	}

	/** Make a welcomed socket the client's one socket, retiring the one before it. */
	private adopt(dialed: Dialed): void {
		if (this.socket && this.socket !== dialed.socket) this.retire(this.socket);
		this.socket = dialed.socket;
		this.socketPath = dialed.path;
		this.clientId = dialed.clientId;
		this.extensionConnected = this.ready(dialed.socket);
		if (this.extensionConnected) {
			this.everConnected = true;
			this.browserId ??= this.socketBrowser.get(dialed.socket);
		}
	}

	/**
	 * Stop using a socket without cutting off what is still waiting on it: replies (or the host's
	 * own close) settle those; the socket is destroyed once nothing waits, or after 5 s.
	 */
	private retire(socket: Socket): void {
		if (this.socket === socket) this.socket = undefined;
		const waiting = [...this.pending.values()].some((p) => p.socket === socket);
		if (!waiting) socket.destroy();
		else setTimeout(() => socket.destroy(), 5000).unref();
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
						this.socketExtension.set(socket, msg.extensionConnected);
						if (msg.browserId) this.socketBrowser.set(socket, msg.browserId);
						resolve({ socket, path: target, clientId: msg.clientId });
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
			this.socketExtension.set(from, msg.connected);
			if (msg.browserId) this.socketBrowser.set(from, msg.browserId);
			// Only the client's own host speaks for the extension; another socket's status waits
			// in socketExtension until (and unless) that socket is adopted.
			if (from !== this.socket) return;
			this.extensionConnected = this.ready(from);
			if (this.extensionConnected) {
				this.everConnected = true;
				this.browserId ??= this.socketBrowser.get(from);
			}
			this.options.onExtensionStatus?.(msg.connected);
		}
	}

	/**
	 * Call, surviving a dropped bridge (extension reload, service worker restart, host respawn).
	 * The session key is stable, so a resent request lands on the same tabs, in the same browser.
	 * A request that never ran is sent again: one that never left (no writable socket) once the
	 * bridge is back, one a live host refused as `not_sent` after a short backoff. A request cut
	 * off in flight may have run: a read (isIdempotent) is resent, anything else fails with
	 * `interrupted` at once and is never replayed. Other RPC errors are never retried.
	 */
	async call<T = unknown>(
		method: string,
		params: Record<string, unknown> = {},
		timeoutMs?: number,
		options: { retry?: boolean } = {},
	): Promise<T> {
		// One budget for the call's waits, however many times the bridge drops or refuses. It starts
		// at the first trouble: the time the request itself ran (a long wait) isn't charged to it.
		let deadline: number | undefined;
		let drops = 0;
		let refusals = 0;
		for (;;) {
			const sent: { socket?: Socket } = {};
			try {
				return await this.callOnce<T>(method, params, timeoutMs, sent);
			} catch (err) {
				const refused = err instanceof BridgeRpcError && err.rpc.code === ERR.NOT_SENT;
				const unsent = err instanceof NotSentError;
				const interrupted = err instanceof BridgeRpcError && err.rpc.code === ERR.INTERRUPTED;
				if (err instanceof BridgeRpcError && !refused && !interrupted) throw err;
				if (!refused && !unsent && !interrupted && !isConnectionError(err)) throw err;
				const resend = refused || unsent || isIdempotent(method, params);
				// Input cut off in flight is never replayed: say so now, without waiting for the bridge
				// (the next call reconnects on its own).
				if (!resend) throw new BridgeRpcError({ code: ERR.INTERRUPTED, message: interruptedMessage(method) });
				// Status checks report trouble as it is instead of waiting.
				if (options.retry === false) throw refused ? err : new Error(NOT_CONNECTED);
				deadline ??= Date.now() + RECONNECT_BUDGET_MS;
				if (refused) {
					// The host is up and said the request didn't run (an update is installing, or the
					// host is stopping): wait a little and send it again, on whatever socket is live then.
					const wait = NOT_SENT_BACKOFF_MS[Math.min(refusals++, NOT_SENT_BACKOFF_MS.length - 1)];
					if (Date.now() + wait > deadline) throw err;
					await new Promise((r) => setTimeout(r, wait));
					continue;
				}
				// Nothing was ever reachable: say so now instead of polling.
				if (!this.everConnected) throw new Error(NOT_CONNECTED);
				if (!unsent) {
					// Cut off in flight (a read): a bridge that keeps dropping is reported, not chased.
					drops++;
					if (drops >= MAX_ATTEMPTS)
						throw new BridgeRpcError({
							code: ERR.INTERRUPTED,
							message: `The browser connection dropped ${drops} times in a row during ${TOOL_NAMES[method] ?? method.replace(".", "_")}. Run \`tabkyra doctor\` or ask the user to check the browser, then try again.`,
						});
					// Stop using the socket this request went out on (unless another call already moved on).
					if (sent.socket && this.socket === sent.socket) this.retire(sent.socket);
				}
				const back = await this.reconnect(deadline - Date.now()).then(
					() => this.extensionConnected,
					() => false,
				);
				if (!back) {
					// The drop outlasted the budget: report it, and don't wait again on the next call.
					if (this.socket) this.retire(this.socket);
					this.everConnected = false;
					throw new Error(NOT_CONNECTED);
				}
			}
		}
	}

	/**
	 * Wait for a live host whose extension (in this client's browser) is connected and dial it.
	 * Concurrent callers share one attempt; each waits only as long as its own budget.
	 */
	private reconnect(budgetMs: number): Promise<void> {
		if (this.connected && this.extensionConnected) return Promise.resolve();
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
				else if (!this.extensionConnected && listSockets().some((p) => p !== this.socketPath)) {
					// Still on a host whose extension never said hello (a stale one) while another host
					// is up: look again, rather than wait on the stale one for the whole budget.
					await this.connectNow(undefined, 5000);
				}
				if (this.connected && this.extensionConnected) return;
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
		// A half-closed socket (the host ended it) can't take a request: it was never sent.
		if (!socket || socket.destroyed || !socket.writable) throw new NotSentError(new Error("Not connected"));
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
