// End to end: the built extension in a throwaway Chromium profile, the native host the
// browser spawns, and the MCP server, driven by a real MCP client. Opens a local page,
// snapshots it, types, clicks, and reads the result back.
//
// Needs `npm run build` at the repo root (dist-chrome) and a Playwright Chromium
// (`npx playwright-core install chromium`). Uses its own HOME, profile and socket
// directory, so it never touches an installed browser or a running bridge.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

	server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end(PAGE);
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
