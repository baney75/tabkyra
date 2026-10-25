// Remote MCP (DC-2, DC-9): every request needs a scoped, revocable token; a session sees
// only the tools its scopes grant; there's no wildcard; the server binds loopback only; and
// the tunnel commands call the user's own tailscale and cloudflared with the right args.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("skills.read grants skill_match and skill_read, and only that scope does", async () => {
	const withSkills = await connect(token("skill-reader", "skills.read"));
	try {
		const names = (await withSkills.listTools()).tools.map((t) => t.name).sort();
		assert.deepEqual(names, ["skill_match", "skill_read"]);
		const match = await withSkills.callTool({ name: "skill_match", arguments: { task: "background check on a roofing contractor" } });
		assert.notEqual(match.isError, true, JSON.stringify(match));
		assert.match(match.content[0].text, /^osint /);
		const read = await withSkills.callTool({ name: "skill_read", arguments: { name: "osint" } });
		assert.match(read.content[0].text, /^---\nname: osint\n/);
	} finally {
		await withSkills.close();
	}
	const without = await connect(token("browser-only", "browser.read,library.read"));
	try {
		const names = (await without.listTools()).tools.map((t) => t.name);
		assert.ok(!names.includes("skill_match") && !names.includes("skill_read"), names.join(","));
		const denied = await without.callTool({ name: "skill_read", arguments: { name: "osint" } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
		assert.equal(denied.isError, true);
	} finally {
		await without.close();
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
	// A PATH holding only node: a real cloudflared (Homebrew puts it beside node) can't be found.
	const bin = join(root, "node-only");
	mkdirSync(bin, { recursive: true });
	symlinkSync(process.execPath, join(bin, "node"));
	const r = cliRun(["tunnel", "cloudflare"], { PATH: bin });
	assert.equal(r.code, 1);
	assert.match(r.out, /cloudflared isn't installed/);
});

test("token names can't collide or look like ids", () => {
	token("unique-name", "browser.read");
	assert.equal(cliRun(["token", "create", "unique-name", "--scope", "browser.read"]).code, 2);
	assert.equal(cliRun(["token", "create", "3f9a01bc", "--scope", "browser.read"]).code, 2);
});

test("only an initialize request opens a session; unknown sessions get 404; serving never rewrites tokens.json", async () => {
	const secret = token("probe", "library.read");
	const file = join(env.HOME, ".config", "tabkyra", "tokens.json");
	const before = readFileSync(file, "utf8");
	const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${secret}` };
	const notInit = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
	assert.equal(notInit.status, 400);
	const unknown = await fetch(url, { method: "POST", headers: { ...headers, "mcp-session-id": "nope" }, body: "{}" });
	assert.equal(unknown.status, 404);
	const bad = await fetch(url, { method: "POST", headers, body: "{not json" });
	assert.equal(bad.status, 400);
	const client = await connect(secret);
	await client.listTools();
	await client.close();
	assert.equal(readFileSync(file, "utf8"), before, "tokens.json is only written by token commands");
});

test("a scoped session's instructions mention only its tools", async () => {
	const client = await connect(token("instr", "library.read"));
	try {
		const text = client.getInstructions() ?? "";
		assert.doesNotMatch(text, /Call status first|handle_dialog|tabs_show/);
		assert.match(text, /This session's tools: library_cite, library_search\./);
		assert.match(text, /untrusted data/);
	} finally {
		await client.close();
	}
});

test("tunnel ports are validated, and Funnel is refused when other paths share port 443", () => {
	assert.equal(cliRun(["tunnel", "tailscale", "--port", "87x7"]).code, 2);
	const bin = join(root, "bin-funnel");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "tailscale"),
		`#!/bin/sh\nif [ "$1" = status ]; then echo '{"Self":{"DNSName":"mac.tail1234.ts.net."}}'; exit 0; fi\nif [ "$1" = serve ] && [ "$2" = status ]; then echo '{"Web":{"mac.tail1234.ts.net:443":{"Handlers":{"/grafana":{}}}}}'; exit 0; fi\necho "$@" >> ${join(root, "funnel.log")}\n`,
	);
	chmodSync(join(bin, "tailscale"), 0o755);
	const r = cliRun(["tunnel", "tailscale", "--public"], { PATH: `${bin}:${dirname(process.execPath)}` });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /\/grafana/);
	assert.throws(() => readFileSync(join(root, "funnel.log"), "utf8"), "funnel was never called");
});

test("safety rules reach every scoped session, with a sign-in fallback when tabs_show is missing", async () => {
	const client = await connect(token("actor", "browser.read,browser.act"));
	try {
		const text = client.getInstructions() ?? "";
		assert.match(text, /Do not enter passwords or payment details\./);
		assert.match(text, /Ask the user before you act under their sign-in/);
		assert.match(text, /stop and ask the user to handle it in their browser/);
		assert.doesNotMatch(text, /call tabs_show/);
	} finally {
		await client.close();
	}
});

test("a token can hold at most 8 sessions, and a malformed record doesn't break auth", async () => {
	const secret = token("many", "library.read");
	const clients = [];
	try {
		for (let i = 0; i < 8; i++) clients.push(await connect(secret));
		await assert.rejects(connect(secret), /429|open sessions/);
	} finally {
		for (const c of clients) await c.close().catch(() => {});
	}
	const file = join(env.HOME, ".config", "tabkyra", "tokens.json");
	const data = JSON.parse(readFileSync(file, "utf8"));
	data.tokens.push({ id: "badbadba", name: "broken", scopes: ["library.read"], sha256: "zz", createdAt: "x" });
	writeFileSync(file, JSON.stringify(data));
	const c = await connect(token("after-bad", "library.read"));
	await c.close();
});

test("tailscale serve is refused while Funnel is on for 443; the cloudflare URL is never the API host", () => {
	const bin = join(root, "bin-funnel-on");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "tailscale"),
		`#!/bin/sh\nif [ "$1" = status ]; then echo '{"Self":{"DNSName":"mac.tail1234.ts.net."}}'; exit 0; fi\nif [ "$1" = serve ] && [ "$2" = status ]; then echo '{"AllowFunnel":{"mac.tail1234.ts.net:443":true}}'; exit 0; fi\necho "$@" >> ${join(root, "serve-on.log")}\n`,
	);
	chmodSync(join(bin, "tailscale"), 0o755);
	const r = cliRun(["tunnel", "tailscale"], { PATH: `${bin}:${dirname(process.execPath)}` });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Funnel is on/);
	const cf = join(root, "bin-cf");
	mkdirSync(cf, { recursive: true });
	symlinkSync(process.execPath, join(cf, "node"));
	writeFileSync(join(cf, "cloudflared"), `#!/bin/sh\necho 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'\nexec /bin/sleep 30\n`);
	chmodSync(join(cf, "cloudflared"), 0o755);
	const res = cliRun(["tunnel", "cloudflare"], { PATH: cf, TABKYRA_TUNNEL_TIMEOUT_MS: "1500" });
	assert.equal(res.code, 1, res.out);
	assert.match(res.out, /printed no URL in time, so it was stopped/);
	assert.doesNotMatch(res.out, /reachable at https:\/\/api\./);
	// The live child was stopped, and nothing is left for --off to find.
	const pidFile = join(env.HOME, ".config", "tabkyra", "cloudflared.pid");
	assert.throws(() => readFileSync(pidFile, "utf8"), "the pid file is removed");
});

test("scopes named like Object.prototype members are refused", () => {
	for (const scope of ["constructor", "toString", "__proto__"]) assert.equal(cliRun(["token", "create", `p-${scope.replace(/_/g, "")}`, "--scope", scope]).code, 2, scope);
});

test("tailscale changes nothing when serve status can't be read", () => {
	const bin = join(root, "bin-status-fail");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(bin, "tailscale"),
		`#!/bin/sh\nif [ "$1" = status ]; then echo '{"Self":{"DNSName":"mac.tail1234.ts.net."}}'; exit 0; fi\nif [ "$1" = serve ] && [ "$2" = status ]; then echo 'warning: something' >&2; exit 1; fi\necho "$@" >> ${join(root, "status-fail.log")}\n`,
	);
	chmodSync(join(bin, "tailscale"), 0o755);
	const r = cliRun(["tunnel", "tailscale"], { PATH: `${bin}:${dirname(process.execPath)}` });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Couldn't read tailscale serve status/);
	assert.throws(() => readFileSync(join(root, "status-fail.log"), "utf8"), "serve was never changed");
});

test("remote sessions read bundled skills only, never the user's local edits", async () => {
	const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
	const draft = join(root, "drafts", "dorks");
	mkdirSync(draft, { recursive: true });
	const text = readFileSync(join(skillsDir, "dorks", "SKILL.md"), "utf8");
	writeFileSync(join(draft, "SKILL.md"), text.replace("## When something goes wrong", "## When something goes wrong\n\n| Private local note | Only on this machine |"));
	const applied = cliRun(["skill", "apply", draft, "--yes"]);
	assert.equal(applied.code, 0, applied.out);
	const client = await connect(token("skills-reader", "skills.read"));
	try {
		const r = await client.callTool({ name: "skill_read", arguments: { name: "dorks" } });
		assert.doesNotMatch(r.content[0].text, /Private local note/);
		assert.equal(r.content[0].text.trim(), text.trim());
	} finally {
		await client.close();
	}
});
