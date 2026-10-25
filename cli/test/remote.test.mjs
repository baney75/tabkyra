// Remote MCP (DC-2, DC-9): every request needs a scoped, revocable token; a session sees
// only the tools its scopes grant; there's no wildcard; the server binds loopback only; and
// the tunnel commands call the user's own tailscale and cloudflared with the right args.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const root = mkdtempSync(join(tmpdir(), "tabkyra-remote-"));
const env = { HOME: join(root, "home"), PATH: dirname(process.execPath), NO_COLOR: "1", TABKYRA_SOCKET_DIR: join(root, "sock") };
mkdirSync(env.HOME, { recursive: true });
mkdirSync(env.TABKYRA_SOCKET_DIR, { mode: 0o700 });
let server;
let url;

function cliRun(args, extraEnv = {}) {
	const r = spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8" });
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function token(name, scopes) {
	const r = cliRun(["token", "create", name, "--scope", scopes]);
	assert.equal(r.code, 0, r.out);
	return /tkr_[A-Za-z0-9_-]+/.exec(r.out)[0];
}

before(async () => {
	server = spawn(process.execPath, [cli, "serve", "--port", "0"], { env });
	url = await new Promise((resolve, reject) => {
		let out = "";
		server.stdout.on("data", (d) => {
			out += d;
			const m = /http:\/\/127\.0\.0\.1:\d+\/mcp/.exec(out);
			if (m) resolve(m[0]);
		});
		server.on("exit", (code) => reject(new Error(`serve exited ${code}: ${out}`)));
		setTimeout(() => reject(new Error(`serve printed no URL: ${out}`)), 15_000);
	});
});

after(() => {
	server?.kill();
	rmSync(root, { recursive: true, force: true });
});

async function connect(secret) {
	const client = new Client({ name: "remote-test", version: "0.0.0" });
	await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: secret ? { Authorization: `Bearer ${secret}` } : {} } }));
	return client;
}

test("token create refuses no scope, unknown scopes and wildcards", () => {
	for (const scopes of ["", "*", "all", "browser.*", "browser.read,admin"]) {
		const r = cliRun(["token", "create", "bad", "--scope", scopes]);
		assert.equal(r.code, 2, `${scopes}: ${r.out}`);
	}
	const secret = token("hash-check", "browser.read");
	const stored = readFileSync(join(env.HOME, ".config", "tabkyra", "tokens.json"), "utf8");
	assert.ok(!stored.includes(secret), "the secret itself is never written");
	assert.doesNotMatch(stored, /tkr_/, "only hashes are stored");
});

test("a request without a valid token is refused", async () => {
	await assert.rejects(connect(undefined), /401|bearer|token/i);
	await assert.rejects(connect("tkr_notarealtokennotarealtoken"), /401|bearer|token/i);
	const raw = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	assert.equal(raw.status, 401);
});

test("a session lists and calls only the tools its scopes grant", async () => {
	const secret = token("reader", "library.read");
	const client = await connect(secret);
	try {
		const names = (await client.listTools()).tools.map((t) => t.name).sort();
		assert.deepEqual(names, ["library_cite", "library_search"]);
		const denied = await client.callTool({ name: "click", arguments: { ref: "e1" } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
		assert.equal(denied.isError, true, "a tool outside the scopes can't be called");
		const allowed = await client.callTool({ name: "library_search", arguments: { query: "" } });
		assert.notEqual(allowed.isError, true, JSON.stringify(allowed));
	} finally {
		await client.close();
	}
});

test("a revoked token is refused at once, and another token can't reuse a session", async () => {
	const a = token("alpha", "browser.read");
	const b = token("beta", "library.read");
	const client = await connect(a);
	const sessionId = client.transport.sessionId;
	const hijack = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${b}`, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
	});
	assert.equal(hijack.status, 403);
	assert.equal(cliRun(["token", "revoke", "alpha"]).code, 0);
	await assert.rejects(client.listTools(), /401|token/i);
	await client.close().catch(() => {});
	assert.match(cliRun(["token", "list"]).out, /alpha\s+revoked/);
});

test("tunnel tailscale serves the tailnet path; --public uses funnel; --off stops it", () => {
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	const log = join(root, "tailscale.log");
	writeFileSync(
		join(bin, "tailscale"),
		`#!/bin/sh\necho "$@" >> ${log}\nif [ "$1" = status ]; then echo '{"Self":{"DNSName":"mac.tail1234.ts.net."}}'; fi\n`,
	);
	chmodSync(join(bin, "tailscale"), 0o755);
	const path = `${bin}:${dirname(process.execPath)}`;
	const on = cliRun(["tunnel", "tailscale", "--port", "8787"], { PATH: path });
	assert.equal(on.code, 0, on.out);
	assert.match(on.out, /https:\/\/mac\.tail1234\.ts\.net\/tabkyra\/mcp/);
	const pub = cliRun(["tunnel", "tailscale", "--public"], { PATH: path });
	assert.match(pub.out, /anyone on the internet/);
	cliRun(["tunnel", "tailscale", "--off"], { PATH: path });
	const calls = readFileSync(log, "utf8");
	assert.match(calls, /^serve --bg --yes --https=443 --set-path=\/tabkyra http:\/\/127\.0\.0\.1:8787$/m);
	assert.match(calls, /^funnel --bg --yes --https=443 --set-path=\/tabkyra http:\/\/127\.0\.0\.1:8787$/m);
	assert.match(calls, /^serve --https=443 --set-path=\/tabkyra off$/m);
});

test("tunnel cloudflare without cloudflared says how to get it and exposes nothing", () => {
	const r = cliRun(["tunnel", "cloudflare"]);
	assert.equal(r.code, 1);
	assert.match(r.out, /cloudflared isn't installed/);
});
