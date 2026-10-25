/**
 * Remote MCP: `tabkyra serve` exposes the MCP server over Streamable HTTP for agents that
 * aren't on this machine (cloud agents, another device), and `tabkyra token` manages who
 * may use it. Off unless started. It binds to loopback only; reaching it from elsewhere
 * goes through a tunnel that terminates TLS (`tabkyra tunnel`, tunnel.ts).
 *
 * Every request needs a bearer token. Tokens are per client, scoped, revocable, and stored
 * only as SHA-256 hashes. There is no wildcard: a token lists its scopes, and a session sees
 * only the tools those scopes grant. A tool outside them isn't registered, so it can't be
 * listed or called.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.ts";

/** What each scope grants. Acting under the user's sign-in is its own scope, never implied. */
export const SCOPES: Record<string, { tools: string[]; what: string }> = {
	"browser.read": {
		tools: ["status", "tabs_context", "read_page", "find", "get_page_text", "get_page_html", "screenshot", "read_console", "read_network"],
		what: "See the agent's own tabs and read pages",
	},
	"browser.navigate": {
		tools: ["navigate", "tabs_create", "tabs_select", "tabs_close", "tabs_show", "wait"],
		what: "Open and close pages in the agent's own tab group (site permissions still apply)",
	},
	"browser.act": {
		tools: ["click", "type", "fill", "press", "hover", "scroll", "drag", "actions", "handle_dialog"],
		what: "Click and type: can submit forms and act under the user's sign-in",
	},
	"browser.script": {
		tools: ["run_js"],
		what: "Run JavaScript in pages the agent opened",
	},
	"library.read": { tools: ["library_search", "library_cite"], what: "Search and cite the source library" },
	"library.write": { tools: ["library_add"], what: "Add sources to the library (fetches from doi.org, OpenAlex, Crossref)" },
};

export interface TokenRecord {
	id: string;
	name: string;
	scopes: string[];
	sha256: string;
	createdAt: string;
	revokedAt?: string;
	lastUsedAt?: string;
}

function configDir(): string {
	return process.env.TABKYRA_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tabkyra");
}

function tokensFile(): string {
	return join(configDir(), "tokens.json");
}

export function loadTokens(): TokenRecord[] {
	if (!existsSync(tokensFile())) return [];
	const data = JSON.parse(readFileSync(tokensFile(), "utf8")) as { tokens?: TokenRecord[] };
	return Array.isArray(data.tokens) ? data.tokens : [];
}

function saveTokens(tokens: TokenRecord[]): void {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	const tmp = `${tokensFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ tokens }, null, "\t")}\n`, { mode: 0o600 });
	renameSync(tmp, tokensFile());
}

function hash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** A new token for `name` with exactly `scopes`. The secret is returned once and never stored. */
export function createToken(name: string, scopes: string[]): { record: TokenRecord; token: string } {
	if (!/^[\w.-]{1,40}$/.test(name)) throw new Error("Token name: letters, digits, dot, dash or underscore, up to 40.");
	if (scopes.length === 0) throw new Error(`Name at least one scope: ${Object.keys(SCOPES).join(", ")}. There is no wildcard.`);
	for (const s of scopes) if (!SCOPES[s]) throw new Error(`Unknown scope ${s}. Scopes: ${Object.keys(SCOPES).join(", ")}. There is no wildcard.`);
	const token = `tkr_${randomBytes(32).toString("base64url")}`;
	const record: TokenRecord = { id: randomUUID().slice(0, 8), name, scopes: [...new Set(scopes)], sha256: hash(token), createdAt: new Date().toISOString() };
	saveTokens([...loadTokens(), record]);
	return { record, token };
}

export function revokeToken(idOrName: string): number {
	const tokens = loadTokens();
	let n = 0;
	for (const t of tokens) {
		if ((t.id === idOrName || t.name === idOrName) && !t.revokedAt) {
			t.revokedAt = new Date().toISOString();
			n++;
		}
	}
	saveTokens(tokens);
	return n;
}

/** The live token record for a presented secret, compared in constant time. Reads the file each time, so a revoke applies at once. */
export function authenticate(header: string | undefined): TokenRecord | undefined {
	const m = /^Bearer (tkr_[A-Za-z0-9_-]{20,})$/.exec(header ?? "");
	if (!m) return undefined;
	const presented = Buffer.from(hash(m[1]), "hex");
	return loadTokens().find((t) => !t.revokedAt && timingSafeEqual(Buffer.from(t.sha256, "hex"), presented));
}

export function toolsFor(scopes: string[]): Set<string> {
	return new Set(scopes.flatMap((s) => SCOPES[s]?.tools ?? []));
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface ServeOptions {
	port: number;
	host: string;
	onListen?: (url: string) => void;
}

/** Serve MCP over Streamable HTTP on loopback. Each session is bound to the token that opened it. */
export async function serve(options: ServeOptions): Promise<{ close: () => Promise<void>; url: string }> {
	if (!LOOPBACK.has(options.host)) throw new Error(`tabkyra serve binds to loopback only (got ${options.host}). Use tabkyra tunnel to reach it from another device over TLS.`);
	const sessions = new Map<string, { transport: StreamableHTTPServerTransport; tokenId: string }>();

	const deny = (res: ServerResponse, status: number, message: string) => {
		res.writeHead(status, { "content-type": "application/json", ...(status === 401 ? { "www-authenticate": 'Bearer realm="tabkyra"' } : {}) });
		res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }));
	};

	const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		if (new URL(req.url ?? "/", "http://x").pathname !== "/mcp") return deny(res, 404, "Not found. The MCP endpoint is /mcp.");
		const token = authenticate(req.headers.authorization);
		if (!token) return deny(res, 401, "A valid, unrevoked bearer token is required (tabkyra token create).");
		const sessionId = req.headers["mcp-session-id"];
		const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
		if (existing) {
			// A session belongs to the token that opened it; another token can't ride on it.
			if (existing.tokenId !== token.id) return deny(res, 403, "This session belongs to another token.");
			return existing.transport.handleRequest(req, res);
		}
		if (req.method !== "POST") return deny(res, 400, "Start a session with an initialize POST.");
		const allowed = toolsFor(token.scopes);
		const { server, client } = createMcpServer({ name: `remote-${token.name}`, session: `remote-${token.id}`, allow: (tool) => allowed.has(tool) });
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (id) => {
				sessions.set(id, { transport, tokenId: token.id });
			},
		});
		transport.onclose = () => {
			if (transport.sessionId) sessions.delete(transport.sessionId);
			client.close?.();
		};
		await server.connect(transport);
		await transport.handleRequest(req, res);
		const tokens = loadTokens();
		const t = tokens.find((x) => x.id === token.id);
		if (t) {
			t.lastUsedAt = new Date().toISOString();
			saveTokens(tokens);
		}
	});

	await new Promise<void>((resolve) => http.listen(options.port, options.host, resolve));
	const address = http.address();
	const port = typeof address === "object" && address ? address.port : options.port;
	const url = `http://${options.host.includes(":") ? `[${options.host}]` : options.host}:${port}/mcp`;
	options.onListen?.(url);
	return {
		url,
		close: () =>
			new Promise<void>((resolve) => {
				for (const { transport } of sessions.values()) void transport.close();
				http.close(() => resolve());
			}),
	};
}
