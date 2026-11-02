/**
 * `tabkyra hub serve`: one connector URL for many devices (D32). The hub answers the same OAuth
 * endpoints and consent page as `serve --public-url`, authenticates /mcp the same way, and then
 * proxies each MCP session to one of the owner's devices, which dial in over a WebSocket (/link)
 * from behind their own NATs. It needs no browser. Single-owner, like every install (D31).
 *
 * What crosses the hop: the caller's scopes and name, in two headers the hub always sets itself
 * (anything a public client sends under x-tabkyra-hub-* is dropped), and the MCP request. The
 * device narrows its own cap by those scopes (remote.ts), so a caller never gets more than both
 * the owner's grant and that device's cap allow. Device credentials and connect codes are stored
 * as SHA-256 only.
 */

import "./cjs-shim.ts";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import {
	authenticateDevice,
	type DeviceRecord,
	HubStateError,
	type LiveDevice,
	loadDevices,
	mintConnectCode,
	redeemConnectCode,
	touchDevice,
	writeLive,
} from "./hub-state.ts";
import {
	type DeviceFrame,
	FORWARD_REQUEST_HEADERS,
	FORWARD_RESPONSE_HEADERS,
	type Headers,
	MAX_BODY_BYTES,
	MAX_FRAME_BYTES,
	MAX_INFLIGHT_PER_DEVICE,
	parseDeviceFrame,
	PING_MS,
	type ReqFrame,
	SILENT_MS,
	type StatusFrame,
} from "./link-protocol.ts";
import { handleOAuth, readBody, requestSource, sendJson } from "./oauth-http.ts";
import { liveGrantIds, mintApprovalCode, type OAuthConfig, resourceMetadataUrl, verifyAccessToken } from "./oauth.ts";
import { authenticate, HUB_CALLER_HEADER, HUB_SCOPES_HEADER, loadTokens, SCOPES, safeCallerName } from "./remote.ts";
import { pageCss } from "./theme.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const SESSION_IDLE_MS = 30 * 60_000;
const MAX_SESSIONS_PER_CALLER = 8;
const HEAD_TIMEOUT_MS = 120_000;
const SESSION_ID = /^[\x21-\x7e]{1,128}$/;

export interface HubOptions {
	port: number;
	host?: string;
	publicUrl: string;
	redirectHosts?: string[];
	allowedHosts?: string[];
	onListen?: (url: string) => void;
}

interface Pending {
	res?: ServerResponse;
	headSent: boolean;
	done: boolean;
	timer: NodeJS.Timeout;
	onHead?: (status: number, headers: Headers) => void;
	onDone?: () => void;
}

interface Link {
	instance: number;
	device: DeviceRecord;
	ws: WebSocket;
	lastSeen: number;
	connectedAt: number;
	status: Omit<StatusFrame, "t">;
	inflight: Map<string, Pending>;
	/** initialize requests sent and not yet finished: load the device hasn't reported. */
	initsPending: number;
}

interface HubSession {
	deviceId: string;
	linkInstance: number;
	callerId: string;
	lastSeen: number;
}

interface Caller {
	id: string;
	name: string;
	scopes: string[];
}

/** Counts failures per source over 15 minutes, with a global cap that bounds guessing even when sources are forged. */
class FailureLimiter {
	private failures: { at: number; source: string }[] = [];
	constructor(
		private readonly perSource: number,
		private readonly global: number,
	) {}
	private prune(): void {
		const cutoff = Date.now() - 15 * 60_000;
		while (this.failures.length && this.failures[0].at < cutoff) this.failures.shift();
	}
	blocked(source: string): boolean {
		this.prune();
		return this.failures.filter((f) => f.source === source).length >= this.perSource || this.failures.length >= this.global;
	}
	fail(source: string): void {
		this.prune();
		this.failures.push({ at: Date.now(), source });
	}
}

export interface HubHandle {
	url: string;
	port: number;
	close: () => Promise<void>;
}

const bearer = (header: string | undefined) => /^Bearer (\S+)$/.exec(header ?? "")?.[1];

export async function startHub(options: HubOptions): Promise<HubHandle> {
	const host = options.host ?? "127.0.0.1";
	if (!LOOPBACK_HOSTS.has(host)) throw new Error(`tabkyra hub serve binds to loopback only (got ${host}). Put an HTTPS front door in front of it.`);
	const oauth: OAuthConfig = { publicUrl: options.publicUrl, redirectHosts: options.redirectHosts ?? [], scopes: SCOPES };
	const links = new Map<string, Link>();
	// The live snapshot (hub devices) shows each device's sessions, so a change to this map refreshes it.
	const sessions = new (class extends Map<string, HubSession> {
		override set(key: string, value: HubSession): this {
			super.set(key, value);
			snapshotSoon();
			return this;
		}
		override delete(key: string): boolean {
			const had = super.delete(key);
			if (had) snapshotSoon();
			return had;
		}
	})();
	const callerInits = new Map<string, number>();
	const enrollLimit = new FailureLimiter(5, 20);
	const authLimit = new FailureLimiter(30, 300);
	let counter = 0;
	let instances = 0;
	const challenge = `Bearer realm="tabkyra", resource_metadata="${resourceMetadataUrl(oauth)}"`;

	const deny = (res: ServerResponse, status: number, message: string): void => {
		if (res.headersSent) {
			res.end();
			return;
		}
		res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(status === 401 ? { "www-authenticate": challenge } : {}) });
		res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }));
	};

	const http: Server = createServer((req, res) => {
		handle(req, res).catch((err) => {
			process.stderr.write(`[tabkyra hub] ${err instanceof Error ? err.message : String(err)}\n`);
			if (!res.headersSent) deny(res, 500, "Internal error.");
			else res.end();
		});
	});
	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

	const port = () => {
		const address = http.address();
		return typeof address === "object" && address ? address.port : options.port;
	};
	const hostAllowed = (req: IncomingMessage) => {
		const given = String(req.headers.host ?? "").toLowerCase();
		const allowed = new Set([new URL(options.publicUrl).host, `127.0.0.1:${port()}`, `localhost:${port()}`, `[::1]:${port()}`, ...(options.allowedHosts ?? []).map((h) => h.toLowerCase())]);
		return allowed.has(given);
	};

	/** A static token, or a live OAuth access token. A link-kind token is never a caller here. */
	function caller(header: string | undefined): Caller | undefined {
		const record = authenticate(header);
		if (record) return record.kind === "link" ? undefined : { id: record.id, name: record.name, scopes: record.scopes };
		const given = bearer(header);
		return given ? verifyAccessToken(oauth, given) : undefined;
	}

	// ---------- Links ----------

	function finish(link: Link, id: string): void {
		const p = link.inflight.get(id);
		if (!p || p.done) return;
		p.done = true;
		clearTimeout(p.timer);
		link.inflight.delete(id);
		p.onDone?.();
	}

	function failPending(link: Link, id: string, status: number, message: string): void {
		const p = link.inflight.get(id);
		if (!p || p.done) return;
		if (p.res && !p.headSent) deny(p.res, status, message);
		else p.res?.destroy();
		finish(link, id);
	}

	function sendTo(link: Link, frame: unknown, onError?: () => void): void {
		if (link.ws.readyState !== WebSocket.OPEN) return onError?.();
		link.ws.send(JSON.stringify(frame), (err) => {
			if (err) onError?.();
		});
	}

	/** Send one request over a link and stream the answer back to `res`. */
	function forward(link: Link, request: { method: ReqFrame["method"]; headers: Headers; body: string; res?: ServerResponse; onHead?: Pending["onHead"]; onDone?: () => void }): void {
		const id = `r${++counter}`;
		const timer = setTimeout(() => failPending(link, id, 504, "The device didn't answer in time."), HEAD_TIMEOUT_MS);
		timer.unref();
		const p: Pending = { res: request.res, headSent: false, done: false, timer, onHead: request.onHead, onDone: request.onDone };
		link.inflight.set(id, p);
		request.res?.on("close", () => {
			// The public client went away before the answer ended: tell the device to stop.
			if (p.done) return;
			sendTo(link, { t: "cancel", id });
			finish(link, id);
		});
		const frame: ReqFrame = { t: "req", id, method: request.method, path: "/mcp", headers: request.headers, body: request.body };
		sendTo(link, frame, () => failPending(link, id, 502, "The device link dropped."));
	}

	function onDeviceFrame(link: Link, frame: DeviceFrame): void {
		if (frame.t === "status") {
			const versionChanged = link.status.version !== frame.version;
			link.status = { extensionConnected: frame.extensionConnected, sessions: frame.sessions, busy: frame.busy, version: frame.version, browser: frame.browser };
			if (versionChanged) touchDevice(link.device.id, { version: frame.version });
			snapshotSoon();
			return;
		}
		const p = link.inflight.get(frame.id);
		if (!p || p.done) return;
		if (frame.t === "head") {
			if (p.headSent) return;
			p.headSent = true;
			// A device that rejects the hub's own credential is a setup fault, not the caller's 401.
			const status = frame.status === 401 ? 502 : frame.status;
			p.onHead?.(status, frame.headers);
			if (p.res) {
				const out: Record<string, string> = {};
				for (const k of FORWARD_RESPONSE_HEADERS) if (frame.headers[k]) out[k] = frame.headers[k];
				if (status === 502 && frame.status === 401) {
					deny(p.res, 502, "This device refused the hub's link token. Run tabkyra link off and link again on it.");
					finish(link, frame.id);
					return;
				}
				if (out["content-type"]?.startsWith("text/event-stream")) {
					out["x-accel-buffering"] = "no";
					out["cache-control"] ??= "no-cache";
				}
				p.res.writeHead(status, out);
				p.res.flushHeaders();
			}
			return;
		}
		if (frame.t === "chunk") {
			if (p.headSent) p.res?.write(frame.data);
			return;
		}
		if (frame.t === "end") {
			if (!p.headSent) failPending(link, frame.id, 502, "The device answered with nothing.");
			else {
				p.res?.end();
				finish(link, frame.id);
			}
			return;
		}
		if (frame.t === "error") failPending(link, frame.id, 502, `The device reported an error: ${frame.message}`);
	}

	function dropLink(link: Link, reason: string): void {
		if (links.get(link.device.id) === link) links.delete(link.device.id);
		for (const id of [...link.inflight.keys()]) failPending(link, id, 502, reason);
		for (const [sid, s] of sessions) if (s.deviceId === link.device.id && s.linkInstance === link.instance) sessions.delete(sid);
		try {
			touchDevice(link.device.id, { lastSeen: new Date().toISOString() });
		} catch {
			/* informational */
		}
		snapshotSoon();
	}

	function onLink(ws: WebSocket, device: DeviceRecord): void {
		const previous = links.get(device.id);
		const link: Link = {
			instance: ++instances,
			device,
			ws,
			lastSeen: Date.now(),
			connectedAt: Date.now(),
			status: { extensionConnected: false, sessions: 0, busy: false, version: "", browser: null },
			inflight: new Map(),
			initsPending: 0,
		};
		// One live link per device: a new one replaces the old.
		if (previous) {
			links.delete(device.id);
			previous.ws.close(4000, "replaced");
			dropLink(previous, "The device reconnected.");
		}
		links.set(device.id, link);
		touchDevice(device.id, { lastSeen: new Date().toISOString() });
		ws.on("message", (data: RawData, isBinary: boolean) => {
			if (isBinary) return ws.close(1003, "text frames only");
			link.lastSeen = Date.now();
			const frame = parseDeviceFrame(data.toString("utf8"));
			if (frame) onDeviceFrame(link, frame);
		});
		ws.on("pong", () => {
			link.lastSeen = Date.now();
		});
		ws.on("close", () => dropLink(link, "The device went offline."));
		ws.on("error", () => ws.terminate());
		snapshotSoon();
	}

	// ---------- Routing ----------

	function pickLink(): Link | undefined {
		const prefer = loadDevices().prefer;
		const all = [...links.values()].filter((l) => l.ws.readyState === WebSocket.OPEN && l.inflight.size < MAX_INFLIGHT_PER_DEVICE);
		const withExtension = all.filter((l) => l.status.extensionConnected);
		const pool = withExtension.length ? withExtension : all;
		const known = (l: Link) => [...sessions.values()].filter((s) => s.deviceId === l.device.id).length;
		const load = (l: Link) => Math.max(l.status.sessions, known(l)) + l.initsPending;
		const rank = (l: Link) => {
			const i = prefer.indexOf(l.device.name);
			return i < 0 ? Number.MAX_SAFE_INTEGER : i;
		};
		return [...pool].sort((a, b) => Number(a.status.busy) - Number(b.status.busy) || load(a) - load(b) || rank(a) - rank(b) || b.lastSeen - a.lastSeen)[0];
	}

	function offlineMessage(): string {
		const devices = loadDevices().devices;
		if (!devices.length) return "No device is linked to this hub. Run tabkyra hub code, then tabkyra link on a device.";
		const lines = devices.map((d) => `${d.name}: ${links.has(d.id) ? "online" : d.lastSeen ? `offline, last seen ${d.lastSeen}` : "never connected"}`);
		return `No device is online. ${lines.join("; ")}.`;
	}

	function requestHeaders(req: IncomingMessage, who: Caller): Headers {
		const out: Headers = {};
		// Built from a short list, so nothing a public client sends under x-tabkyra-hub-* (or anything else) can pass.
		for (const name of FORWARD_REQUEST_HEADERS) {
			const v = req.headers[name];
			if (typeof v === "string" && v && !/[\r\n\0]/.test(v)) out[name] = v;
		}
		out[HUB_SCOPES_HEADER] = who.scopes.filter((s) => Object.hasOwn(SCOPES, s)).join(",");
		out[HUB_CALLER_HEADER] = safeCallerName(who.name) || "caller";
		return out;
	}

	async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const who = caller(req.headers.authorization);
		if (!who) return deny(res, 401, "Connect with OAuth or a valid, unrevoked bearer token.");
		const method = req.method ?? "GET";
		if (method !== "GET" && method !== "POST" && method !== "DELETE") return deny(res, 405, "Method not allowed.");
		const sessionId = req.headers["mcp-session-id"];
		if (typeof sessionId === "string") {
			const session = sessions.get(sessionId);
			if (!session) return deny(res, 404, "Unknown or expired session. Start a new one with an initialize request.");
			// A session belongs to the caller that opened it; another can't ride on it.
			if (session.callerId !== who.id) return deny(res, 403, "This session belongs to another token.");
			const link = links.get(session.deviceId);
			if (!link || link.instance !== session.linkInstance) {
				sessions.delete(sessionId);
				return deny(res, 404, "Unknown or expired session. Start a new one with an initialize request.");
			}
			if (link.inflight.size >= MAX_INFLIGHT_PER_DEVICE) return deny(res, 429, "This device is handling too many requests. Try again in a moment.");
			session.lastSeen = Date.now();
			let body = "";
			try {
				body = method === "POST" ? await readBody(req, MAX_BODY_BYTES) : "";
			} catch {
				return deny(res, 413, "Request body too large.");
			}
			return forward(link, {
				method,
				headers: requestHeaders(req, who),
				body,
				res,
				onHead: (status) => {
					if (method === "DELETE" && (status < 300 || status === 404)) sessions.delete(sessionId);
					if (status === 404) sessions.delete(sessionId);
				},
			});
		}
		if (method !== "POST") return deny(res, 400, "Start a session with an initialize POST.");
		let body: string;
		let parsed: unknown;
		try {
			body = await readBody(req, MAX_BODY_BYTES);
			parsed = JSON.parse(body);
		} catch {
			return deny(res, 400, "The request body isn't valid JSON.");
		}
		// Only an initialize request creates a session.
		if (!isInitializeRequest(parsed)) return deny(res, 400, "Start a session with an initialize request.");
		const open = [...sessions.values()].filter((s) => s.callerId === who.id).length + (callerInits.get(who.id) ?? 0);
		if (open >= MAX_SESSIONS_PER_CALLER) return deny(res, 429, `This token already has ${MAX_SESSIONS_PER_CALLER} open sessions. Close one first.`);
		const link = pickLink();
		if (!link) return deny(res, 503, offlineMessage());
		link.initsPending++;
		callerInits.set(who.id, (callerInits.get(who.id) ?? 0) + 1);
		forward(link, {
			method: "POST",
			headers: requestHeaders(req, who),
			body,
			res,
			onHead: (status, headers) => {
				const id = headers["mcp-session-id"];
				// A device can't take over a session id the hub already routes.
				if (status >= 200 && status < 300 && id && SESSION_ID.test(id) && !sessions.has(id)) {
					sessions.set(id, { deviceId: link.device.id, linkInstance: link.instance, callerId: who.id, lastSeen: Date.now() });
				}
			},
			onDone: () => {
				link.initsPending = Math.max(0, link.initsPending - 1);
				callerInits.set(who.id, Math.max(0, (callerInits.get(who.id) ?? 1) - 1));
			},
		});
	}

	// ---------- Enrollment and codes ----------

	async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
		try {
			const value = JSON.parse(await readBody(req, 8_000)) as unknown;
			if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
		} catch {
			/* fall through */
		}
		sendJson(res, 400, { error: "invalid_request", error_description: "The body must be a small JSON object." });
		return undefined;
	}

	async function handleEnroll(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
		const source = requestSource(req);
		// The code carries 40 bits; the caps bound guessing even when the source header is forged.
		if (enrollLimit.blocked(source)) return sendJson(res, 429, { error: "temporarily_unavailable", error_description: "Too many wrong connect codes. Wait 15 minutes." });
		const body = await readJsonBody(req, res);
		if (!body) return;
		const code = typeof body.code === "string" ? body.code : "";
		const name = typeof body.name === "string" ? body.name.trim() : "";
		try {
			const made = redeemConnectCode(code, name || "device");
			if (!made) {
				enrollLimit.fail(source);
				return sendJson(res, 401, { error: "invalid_code", error_description: "That connect code is wrong, expired or already used. Run tabkyra hub code for a new one." });
			}
			if (typeof body.version === "string") touchDevice(made.record.id, { version: body.version.slice(0, 40) });
			return sendJson(res, 200, { deviceId: made.record.id, secret: made.credential.slice(made.record.id.length + 1), manage: made.record.manage, name: made.record.name });
		} catch (err) {
			if (err instanceof HubStateError) return sendJson(res, err.status, { error: "invalid_request", error_description: err.message });
			throw err;
		}
	}

	async function handleCode(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
		const source = requestSource(req);
		if (authLimit.blocked(source)) return sendJson(res, 429, { error: "temporarily_unavailable", error_description: "Too many failed attempts. Wait 15 minutes." });
		const device = authenticateDevice(bearer(req.headers.authorization));
		if (!device) {
			authLimit.fail(source);
			return sendJson(res, 401, { error: "invalid_token", error_description: "This device's credential is not valid." });
		}
		// Only a manager device mints codes.
		if (!device.manage) return sendJson(res, 403, { error: "forbidden", error_description: "This device is not a manager. Link it with a code from tabkyra hub code --manage." });
		const body = await readJsonBody(req, res);
		if (!body) return;
		try {
			if (body.kind === "approval") {
				const { code, expiresAt } = mintApprovalCode();
				return sendJson(res, 200, { kind: "approval", code, expiresAt, url: `${options.publicUrl}/mcp` });
			}
			if (body.kind === "connect") {
				const { code, expiresAt } = mintConnectCode({ name: typeof body.name === "string" && body.name ? body.name : undefined, manage: body.manage === true });
				return sendJson(res, 200, { kind: "connect", code, expiresAt });
			}
		} catch (err) {
			if (err instanceof HubStateError) return sendJson(res, err.status, { error: "invalid_request", error_description: err.message });
			if (err instanceof Error) return sendJson(res, 429, { error: "temporarily_unavailable", error_description: err.message });
			throw err;
		}
		sendJson(res, 400, { error: "invalid_request", error_description: "kind is connect or approval." });
	}

	function homePage(res: ServerResponse): void {
		const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tabkyra hub</title><style>${pageCss()}</style></head><body><main><h1>Tabkyra hub</h1><p class="muted">This address connects an assistant to the owner's own browsers. Add <code>${options.publicUrl.replace(/[&<>"']/g, "")}/mcp</code> as a custom connector in claude.ai, ChatGPT or grok.com, then approve it with the owner's passcode or a connect code.</p></main></body></html>`;
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-frame-options": "DENY",
			"referrer-policy": "no-referrer",
			"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
		});
		res.end(html);
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const path = new URL(req.url ?? "/", "http://x").pathname;
		// Only the public name and loopback are ours; anything else is a misdirected or rebound request.
		if (!hostAllowed(req)) return deny(res, 421, "Misdirected request.");
		if (await handleOAuth(oauth, req, res, path)) return;
		if (path === "/" && req.method === "GET") return homePage(res);
		if (path === "/link/enroll") return handleEnroll(req, res);
		if (path === "/link/code") return handleCode(req, res);
		if (path === "/mcp") return handleMcp(req, res);
		deny(res, 404, "Not found. The MCP endpoint is /mcp.");
	}

	http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const refuse = (line: string) => {
			socket.end(`HTTP/1.1 ${line}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
		};
		const path = new URL(req.url ?? "/", "http://x").pathname;
		if (!hostAllowed(req)) return refuse("421 Misdirected Request");
		if (path !== "/link") return refuse("404 Not Found");
		const source = requestSource(req);
		if (authLimit.blocked(source)) return refuse("429 Too Many Requests");
		const device = authenticateDevice(bearer(req.headers.authorization));
		if (!device) {
			authLimit.fail(source);
			return refuse("401 Unauthorized");
		}
		wss.handleUpgrade(req, socket, head, (ws) => onLink(ws, device));
	});

	// ---------- Timers ----------

	const live = (): LiveDevice[] =>
		loadDevices().devices.map((d) => {
			const l = links.get(d.id);
			return {
				id: d.id,
				name: d.name,
				online: Boolean(l),
				extensionConnected: l?.status.extensionConnected ?? false,
				sessions: l ? Math.max(l.status.sessions, [...sessions.values()].filter((s) => s.deviceId === d.id).length) : 0,
				busy: l?.status.busy ?? false,
				lastSeen: l ? new Date(l.lastSeen).toISOString() : (d.lastSeen ?? null),
				version: l?.status.version || d.version || null,
				browser: l?.status.browser ?? null,
			};
		});
	let snapshotTimer: NodeJS.Timeout | undefined;
	const writeSnapshot = () => {
		snapshotTimer = undefined;
		try {
			writeLive({ pid: process.pid, updatedAt: Date.now(), devices: live() });
		} catch {
			/* informational */
		}
	};
	function snapshotSoon(): void {
		snapshotTimer ??= setTimeout(writeSnapshot, 200);
	}

	const timers: NodeJS.Timeout[] = [];
	// Ping every link; drop one silent for a minute.
	timers.push(
		setInterval(() => {
			for (const link of links.values()) {
				if (Date.now() - link.lastSeen > SILENT_MS) link.ws.terminate();
				else if (link.ws.readyState === WebSocket.OPEN) link.ws.ping();
			}
		}, PING_MS),
	);
	// A device removed with `tabkyra hub remove` (another process) loses its link within a second.
	timers.push(
		setInterval(() => {
			const known = new Map(loadDevices().devices.map((d) => [d.id, d.sha256]));
			for (const link of [...links.values()]) {
				if (known.get(link.device.id) === link.device.sha256) continue;
				// Gone from the list at once; the socket closes now, or is cut a second later if the device doesn't answer.
				dropLink(link, "The device was removed.");
				link.ws.close(4001, "removed");
				setTimeout(() => link.ws.terminate(), 1000).unref();
			}
		}, 1000),
	);
	// Forget idle sessions and those whose caller was revoked.
	timers.push(
		setInterval(() => {
			let liveIds = new Set<string>();
			try {
				liveIds = new Set([...loadTokens().filter((t) => !t.revokedAt).map((t) => t.id), ...liveGrantIds()]);
			} catch {
				/* unreadable: treat every caller as revoked */
			}
			for (const [sid, s] of sessions) {
				if (Date.now() - s.lastSeen <= SESSION_IDLE_MS && liveIds.has(s.callerId)) continue;
				sessions.delete(sid);
				const link = links.get(s.deviceId);
				if (link && link.instance === s.linkInstance) forward(link, { method: "DELETE", headers: { "mcp-session-id": sid, [HUB_SCOPES_HEADER]: "", [HUB_CALLER_HEADER]: "hub" }, body: "" });
			}
		}, 60_000),
	);
	timers.push(setInterval(writeSnapshot, 5000));
	for (const t of timers) t.unref();

	await new Promise<void>((resolve, reject) => {
		http.once("error", reject);
		http.listen(options.port, host, resolve);
	});
	writeSnapshot();
	const url = `http://${host.includes(":") ? `[${host}]` : host}:${port()}`;
	options.onListen?.(url);
	return {
		url,
		port: port(),
		close: () =>
			new Promise<void>((resolve) => {
				for (const t of timers) clearInterval(t);
				if (snapshotTimer) clearTimeout(snapshotTimer);
				for (const link of links.values()) link.ws.terminate();
				wss.close();
				http.closeAllConnections();
				http.close(() => resolve());
			}),
	};
}
