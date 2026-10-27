// End to end: the built extension in a throwaway Chromium profile, the native host the
// browser spawns, and the MCP server, driven by a real MCP client. Opens a local page,
// snapshots it, types, clicks, and reads the result back.
//
// Needs `npm run build` at the repo root (dist-chrome) and a Playwright Chromium
// (`npx playwright-core install chromium`). Uses its own HOME, profile and socket
// directory, so it never touches an installed browser or a running bridge.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const extensionDir = join(here, "..", "..", "dist-chrome");

// From the `key` in static/manifest.chrome.json; cli/test/install.test.mjs checks the derivation.
const EXTENSION_ID = "kenehmggpggpiolepbjojeenmeapgfoc";

const PAGE = `<!doctype html><title>Tabkyra e2e</title>
<label for="name">Name</label> <input id="name" placeholder="Your name">
<button id="go" onclick="document.getElementById('out').textContent = 'Hello, ' + document.getElementById('name').value + '!'">Greet</button>
<p id="out">waiting</p>`;

const ONLOAD_PAGE = `<!doctype html><title>Tabkyra onload</title><p id="x">before</p>
<script>alert('Welcome back!'); document.getElementById('x').textContent = 'after';</script>`;

const TYPING_PAGE = `<!doctype html><title>Tabkyra typing</title>
<form id="f"><input id="q" onkeydown="if(!window.asked){window.asked=true;confirm('Start a new search?')}"></form>
<p id="sent">not sent</p>
<script>document.getElementById('f').onsubmit=(e)=>{e.preventDefault();document.getElementById('sent').textContent='sent';};</script>`;

const DIALOG_PAGE = `<!doctype html><title>Tabkyra dialog</title>
<button id="del" onclick="document.getElementById('res').textContent = confirm('Really delete?') ? 'deleted' : 'kept'">Delete</button>
<p id="res">untouched</p>`;

const COUNTER_PAGE = `<!doctype html><title>Tabkyra counter</title>
<button id="hit" onclick="fetch('/hit',{method:'POST'}).then(r=>r.text()).then(t=>document.getElementById('n').textContent=t)">Hit</button><p id="n">0</p>`;
/** Clicks that reached the page's server: a replayed click shows up here twice. */
let hits = 0;

let home;
let socketDir;
let browser;
let server;
let mcp;
let pageUrl;
let devtools;

function env() {
	return {
		...process.env,
		HOME: home,
		TABKYRA_SOCKET_DIR: socketDir,
		TABKYRA_AUTO_ALLOW: "1",
		TABKYRA_CLIENT_NAME: "e2e",
		TABKYRA_SESSION: "e2e",
	};
}

async function tool(name, args = {}) {
	const result = await mcp.callTool({ name, arguments: args });
	const text = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	assert.ok(!result.isError, `${name} failed: ${text}`);
	return text;
}

/** One CDP command over a target's websocket. */
async function cdp(wsUrl, method, params = {}) {
	const ws = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	try {
		const reply = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000);
			ws.onmessage = (m) => {
				const msg = JSON.parse(m.data);
				if (msg.id !== 1) return;
				clearTimeout(timer);
				resolve(msg);
			};
			ws.send(JSON.stringify({ id: 1, method, params }));
		});
		if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
		return reply.result;
	} finally {
		ws.close();
	}
}

/** The live native host's pid (its socket is named after it). */
function hostPid() {
	for (const name of readdirSync(socketDir)) {
		const pid = Number.parseInt(name, 10);
		try {
			process.kill(pid, 0);
			return pid;
		} catch {
			/* stale */
		}
	}
	return undefined;
}

/** Reload the extension the way `tabkyra reload` does, retrying while a fresh host waits for its hello. */
async function reloadExtension() {
	const old = hostPid();
	await until(() => (execFileSync(process.execPath, [cli, "reload"], { env: env(), stdio: "ignore" }), true), 30_000, "the extension to take a reload");
	return old;
}

async function gone(pid) {
	await until(() => {
		try {
			process.kill(pid, 0);
			return false;
		} catch {
			return true;
		}
	}, 10_000, `host ${pid} to exit`);
}

async function connected() {
	await until(
		() => {
			try {
				return JSON.parse(execFileSync(process.execPath, [cli, "status", "--json"], { env: env(), encoding: "utf8" })).connected;
			} catch {
				return false;
			}
		},
		45_000,
		"the extension to reconnect",
	);
}

async function until(fn, ms, what) {
	const end = Date.now() + ms;
	let last;
	while (Date.now() < end) {
		try {
			const value = await fn();
			if (value) return value;
		} catch (err) {
			last = err;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

before(async () => {
	home = mkdtempSync(join(tmpdir(), "tabkyra-e2e-home-"));
	// Unix socket paths are capped near 104 bytes on macOS, so keep this one short.
	socketDir = mkdtempSync("/tmp/tke2e-");
	const profile =
		process.platform === "darwin"
			? join(home, "Library", "Application Support", "Chromium")
			: join(home, ".config", "chromium");
	mkdirSync(profile, { recursive: true });

	server = createServer((req, res) => {
		if (req.method === "POST" && req.url === "/hit") {
			hits++;
			res.end(String(hits));
			return;
		}
		res.writeHead(200, { "content-type": "text/html" });
		if (req.url === "/counter") return res.end(COUNTER_PAGE);
		res.end(req.url === "/dialog" ? DIALOG_PAGE : req.url === "/onload" ? ONLOAD_PAGE : req.url === "/typing" ? TYPING_PAGE : PAGE);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	pageUrl = `http://127.0.0.1:${server.address().port}/`;

	// `install` writes the host manifest into the profile's NativeMessagingHosts.
	execFileSync(process.execPath, [cli, "install"], { env: env(), stdio: "ignore" });

	// Launch Playwright's Chromium without Playwright's CDP session: the extension drives
	// tabs through chrome.debugger, and a second automation client attached to every
	// target gets in its way. Targets are listed over the DevTools HTTP endpoint instead.
	browser = spawn(
		chromium.executablePath(),
		[
			`--user-data-dir=${profile}`,
			"--headless=new",
			"--no-first-run",
			"--no-default-browser-check",
			// Keep the macOS keychain prompt and every window off the user's screen.
			"--use-mock-keychain",
			"--password-store=basic",
			"--remote-debugging-port=0",
			`--disable-extensions-except=${extensionDir}`,
			`--load-extension=${extensionDir}`,
			"about:blank",
		],
		{ env: env(), stdio: ["ignore", "ignore", "pipe"] },
	);
	let stderr = "";
	browser.stderr.on("data", (d) => {
		stderr += d;
	});
	devtools = await until(() => stderr.match(/DevTools listening on ws:\/\/([^/]+)\//)?.[1], 20_000, "Chromium to start");
	// Developer mode, set the way the extensions page does: without it this Chromium disables an
	// unpacked extension when it reloads, and the reload tests would unload Tabkyra for good.
	const version = await (await fetch(`http://${devtools}/json/version`)).json();
	const { targetId } = await cdp(version.webSocketDebuggerUrl, "Target.createTarget", { url: "chrome://extensions" });
	const page = await until(
		async () => (await (await fetch(`http://${devtools}/json/list`)).json()).find((t) => t.id === targetId && t.url.startsWith("chrome://extensions")),
		10_000,
		"chrome://extensions",
	);
	await until(
		async () =>
			(await cdp(page.webSocketDebuggerUrl, "Runtime.evaluate", { expression: "chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }).then(() => true)", awaitPromise: true, returnByValue: true })).result?.value,
		10_000,
		"developer mode",
	);
	await cdp(version.webSocketDebuggerUrl, "Target.closeTarget", { targetId });

	mcp = new Client({ name: "tabkyra-e2e", version: "0.0.0" });
	await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: env(), stderr: "inherit" }));
});

after(async () => {
	await mcp?.close().catch(() => {});
	browser?.kill();
	if (browser) await new Promise((r) => browser.once("exit", r));
	server?.close();
	if (home) rmSync(home, { recursive: true, force: true });
	if (socketDir) rmSync(socketDir, { recursive: true, force: true });
});

test("extension loads with the id the host manifest allows", async () => {
	const worker = await until(
		async () => {
			const targets = await (await fetch(`http://${devtools}/json/list`)).json();
			// Chromium's own component extensions run workers too; ours is the one named in
			// the host manifest, so a match here means the key produced the expected id.
			return targets.find((t) => t.type === "service_worker" && t.url === `chrome-extension://${EXTENSION_ID}/background.js`);
		},
		20_000,
		"the extension service worker",
	);
	assert.ok(worker);
});

test("MCP server lists the browser tools under the tabkyra name", async () => {
	assert.equal(mcp.getServerVersion()?.name, "tabkyra");
	const { tools } = await mcp.listTools();
	const names = tools.map((t) => t.name);
	for (const name of ["navigate", "read_page", "click", "type", "get_page_text"]) assert.ok(names.includes(name), name);
});

test("open a page, snapshot, type, click and read back through MCP", async () => {
	// The extension dials the host on start and on its keepalive alarm; wait for it.
	const nav = await until(
		async () => {
			const result = await mcp.callTool({ name: "navigate", arguments: { url: pageUrl } });
			return result.isError ? undefined : result.content.map((c) => c.text).join("\n");
		},
		45_000,
		"the extension to connect and open the page",
	);
	assert.match(nav, /Tabkyra e2e/);

	const status = JSON.parse(await tool("status"));
	assert.equal(status.connected, true);
	assert.equal(status.tabGroup, "Tabkyra · e2e");
	assert.equal(status.permissionMode, "ask");
	assert.ok(status.tabs.some((t) => t.current && t.url.startsWith(pageUrl)), JSON.stringify(status.tabs));

	const snapshot = await tool("read_page", { filter: "interactive" });
	const inputRef = snapshot.match(/\[(e\d+)\][^\n]*textbox/i)?.[1] ?? snapshot.match(/(e\d+)[^\n]*(textbox|input)/i)?.[1];
	const buttonRef = snapshot.match(/\[(e\d+)\][^\n]*Greet/)?.[1] ?? snapshot.match(/(e\d+)[^\n]*Greet/)?.[1];
	assert.ok(inputRef, `no textbox ref in snapshot:\n${snapshot}`);
	assert.ok(buttonRef, `no Greet button ref in snapshot:\n${snapshot}`);

	await tool("type", { ref: inputRef, text: "Donovan" });
	await tool("click", { ref: buttonRef });

	const text = await until(
		async () => {
			const t = await tool("get_page_text");
			return t.includes("Hello, Donovan!") ? t : undefined;
		},
		10_000,
		"the greeting",
	);
	assert.match(text, /Hello, Donovan!/);
});

test("a confirm() box fails the call at once with its text, and handle_dialog answers it", async () => {
	await tool("navigate", { url: `${pageUrl}dialog` });
	const started = Date.now();
	const blocked = await mcp.callTool({ name: "click", arguments: { selector: "#del" } });
	const message = blocked.content.map((c) => c.text).join("\n");
	assert.ok(blocked.isError, message);
	assert.match(message, /dialog_open: A confirm dialog is open on tab \d+: "Really delete\?"/);
	assert.ok(Date.now() - started < 10_000, "the call must not wait for the 90 s handler timeout");
	// While it is open, page calls fail the same way instead of hanging.
	const frozen = await mcp.callTool({ name: "get_page_text", arguments: {} });
	assert.ok(frozen.isError);
	assert.match(frozen.content[0].text, /dialog_open/);

	const answered = JSON.parse(await tool("handle_dialog", { accept: false }));
	assert.equal(answered.type, "confirm");
	assert.equal(answered.accepted, false);
	assert.match(await tool("get_page_text"), /kept/);

	await mcp.callTool({ name: "click", arguments: { selector: "#del" } });
	await tool("handle_dialog", { accept: true });
	assert.match(await tool("get_page_text"), /deleted/);
	const none = await mcp.callTool({ name: "handle_dialog", arguments: { accept: true } });
	assert.ok(none.isError);
	assert.match(none.content[0].text, /No dialog is open/);
});

test("an alert() fired while the page loads is reported, not a 90 s hang", async () => {
	const started = Date.now();
	const nav = await mcp.callTool({ name: "navigate", arguments: { url: `${pageUrl}onload` } });
	let message = nav.content.map((c) => c.text).join("\n");
	if (!nav.isError) {
		const read = await mcp.callTool({ name: "get_page_text", arguments: {} });
		assert.ok(read.isError, read.content[0].text);
		message = read.content[0].text;
	}
	assert.match(message, /dialog_open: An alert dialog is open on tab \d+: "Welcome back!"/);
	assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
	await tool("handle_dialog", { accept: true });
	assert.match(await tool("get_page_text"), /after/);
});

test("a call that ran into a dialog sends no more input once it is answered", async () => {
	await tool("navigate", { url: `${pageUrl}typing` });
	const typed = await mcp.callTool({ name: "type", arguments: { selector: "#q", text: "hello world", submit: true } });
	assert.ok(typed.isError);
	assert.match(typed.content[0].text, /dialog_open/);
	await tool("handle_dialog", { accept: false });
	// Give a still-running handler time to misbehave.
	await new Promise((r) => setTimeout(r, 1500));
	const value = await tool("run_js", { code: "document.getElementById('q').value + '|' + document.getElementById('sent').textContent" });
	assert.match(value, /\|not sent/, `the old call kept typing or submitted: ${value}`);
	assert.doesNotMatch(value, /ello world/, `the old call kept typing: ${value}`);
});

test("a click in flight when the extension reloads runs once, and the agent is told it may have run", async () => {
	await tool("navigate", { url: `${pageUrl}counter` });
	await connected();
	const before = hits;
	// The click runs first; the reload lands while the step after it is still going.
	const pending = mcp.callTool({ name: "actions", arguments: { steps: [{ click: { selector: "#hit" } }, { wait: 3000 }] } }, undefined, { timeout: 120_000 });
	await new Promise((r) => setTimeout(r, 800));
	await reloadExtension();
	const started = Date.now();
	const result = await pending;
	const message = result.content.map((c) => c.text).join("\n");
	assert.equal(result.isError, true, message);
	assert.match(message, /^interrupted: The browser connection dropped while actions was running .*may have run/);
	assert.ok(Date.now() - started < 30_000, "the interrupted call must not wait out a timeout");
	await connected();
	await new Promise((r) => setTimeout(r, 1500));
	assert.equal(hits - before, 1, "the click ran twice: a cut-off request was replayed");
	// The session kept its tab across the reload.
	assert.match(await tool("tabs_context"), /\/counter/);
});

test("a read sent while the extension is reloading waits for it and succeeds", async () => {
	await tool("navigate", { url: `${pageUrl}counter` });
	await connected();
	await gone(await reloadExtension());
	const started = Date.now();
	const text = await tool("read_page", { filter: "interactive" });
	assert.match(text, /Hit/);
	assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
});

test("a read after the native host is killed reconnects to the host the browser respawns", async () => {
	await connected();
	process.kill(hostPid(), "SIGKILL");
	const started = Date.now();
	const text = await tool("get_page_text");
	assert.match(text, /Hit/);
	assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
});
