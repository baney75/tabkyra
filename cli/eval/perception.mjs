#!/usr/bin/env node
// Perception eval, no model: how well do Tabkyra's MCP tools let an agent SEE and act on hard
// pages? The script calls the tools directly against local fixture pages and scores 12 probes
// pass/fail from tool output and page state:
//
//   shadow-see, shadow-click, nested-fill, shadow-text   open shadow roots, nested (text: read_page and get_page_text)
//   frame-see, frame-click, xorigin-flag                 same-origin and cross-origin iframes
//   states                                               expanded, pressed, disabled, selected, checked
//   api-request, api-body                                a page's own fetch() seen over the network
//   embedded-map                                         embedded JSON and forms (inspect_page)
//   cost                                                 size of an interactive read of a small page
//
//   node cli/eval/perception.mjs --extension <built extension dir> [--out file.json]
//
// A measurement, not a gate: exit 0 even when probes fail, exit 1 only when the harness breaks.
// Needs the CLI build (cli/dist) and Playwright's Chromium.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cli, launchFixtureBrowser, sleep } from "./fixture-browser.mjs";

const arg = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : fallback;
};
const EXTENSION = arg("--extension");
const OUT = arg("--out");
/** A call that has not answered by now counts as a hang. */
const HANG_MS = 90000;
const RAW_MAX = 2000;

if (!EXTENSION) {
	console.error("usage: node cli/eval/perception.mjs --extension <built extension dir> [--out <file.json>]");
	process.exit(1);
}

// ---- fixture ---------------------------------------------------------------

const serve = (handler) =>
	new Promise((resolve) => {
		const server = createServer(handler);
		server.listen(0, "127.0.0.1", () => resolve(server));
	});

const html = (res, body) => {
	res.writeHead(200, { "content-type": "text/html" });
	res.end(`<!doctype html><meta charset="utf-8"><title>Fixture</title>${body}`);
};

const serverB = await serve((_req, res) => {
	html(res, `<p>Cross origin 6161</p>`);
});
const portB = serverB.address().port;

// The shadow strings are split so the page's script source (which get_page_text can return)
// never contains the literal text a probe looks for.
const pages = {
	"/shadow": `<x-card></x-card><script>
customElements.define("x-field", class extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" }).innerHTML = '<label for="em">Nested ' + "email</label>" + '<input id="em">';
	}
});
customElements.define("x-card", class extends HTMLElement {
	constructor() {
		super();
		const root = this.attachShadow({ mode: "open" });
		root.innerHTML = '<button id="sb">Shadow ' + "Save</button><p>Shadow para" + "graph 77" + "31</p><x-field></x-field>";
		root.getElementById("sb").addEventListener("click", () => {
			window.top.__clicked = "shadow";
		});
	}
});
</script>`,
	"/frames": `<h1>Frames</h1><iframe src="/inner" width="300" height="100"></iframe><iframe src="http://127.0.0.1:${portB}/x" width="300" height="100"></iframe>`,
	"/inner": `<button onclick="parent.__clicked='frame'">Frame Pay</button>`,
	"/states": `<button aria-expanded="true">Menu</button>
<button aria-pressed="true">Bold</button>
<button disabled>Submit order</button>
<div role="tablist"><div role="tab" aria-selected="true" tabindex="0">Billing</div></div>
<div role="switch" aria-checked="true" tabindex="0">Dark mode</div>`,
	"/api-page": `<p id="out">Loading</p><script>
fetch("/api/price").then((r) => r.json()).then((d) => {
	document.getElementById("out").textContent = "Price: " + d.price;
});
</script>`,
	"/embedded": `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"secret":"next-data-5150"}}}</script>
<form action="/subscribe" method="post"><input name="email"><button>Subscribe</button></form>`,
};

const serverA = await serve((req, res) => {
	const path = new URL(req.url, "http://x").pathname;
	if (path === "/api/price") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ sku: "A1", price: 4242, hidden: "api-only-9081" }));
		return;
	}
	if (pages[path] === undefined) {
		res.writeHead(404);
		res.end("not found");
		return;
	}
	html(res, pages[path]);
});
const site = `http://127.0.0.1:${serverA.address().port}`;

/** The throwaway browser and the MCP client, once started. */
let fx;
let client;

async function cleanup() {
	await client?.close().catch(() => {});
	await fx?.close().catch(() => {});
	serverA.close();
	serverB.close();
}
for (const event of ["uncaughtException", "unhandledRejection"])
	process.on(event, async (err) => {
		console.error(err);
		await cleanup();
		process.exit(1);
	});

// ---- MCP helpers ---------------------------------------------------------------

async function mcpClient(env, { cwd, name = "perception" } = {}) {
	const client = new Client({ name, version: "0.0.0" });
	const t0 = performance.now();
	await client.connect(
		new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, cwd, stderr: "ignore" }),
	);
	return { client, initMs: Math.round(performance.now() - t0) };
}

/** One tool call with a hang guard; never throws. */
async function call(client, name, args = {}) {
	const t0 = performance.now();
	let timer;
	const hang = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ hang: true }), HANG_MS);
	});
	const res = await Promise.race([
		client
			.callTool({ name, arguments: args }, undefined, { timeout: HANG_MS + 5000 })
			.catch((err) => ({ isError: true, content: [{ type: "text", text: `client error: ${err.message}` }] })),
		hang,
	]);
	clearTimeout(timer);
	const ms = Math.round(performance.now() - t0);
	if (res.hang) return { outcome: "hang", ms, text: "", full: "" };
	const text = (res.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	return { outcome: res.isError ? "error" : "ok", ms, text: text.slice(0, 300), full: text };
}

// ---- probe helpers -----------------------------------------------------------------

const go = async (path) => {
	const nav = await call(client, "navigate", { url: `${site}${path}` });
	if (nav.outcome !== "ok") throw new Error(`navigate ${path}: ${nav.outcome} ${nav.text}`);
	await sleep(500);
};

const interactive = () => call(client, "read_page", { filter: "interactive" });

/** The first ref (e12) on the line that mentions `name`. */
const refFor = (output, name) => {
	const line = output.split("\n").find((l) => l.includes(name));
	return line?.match(/\be\d+\b/)?.[0];
};

const lineWith = (output, name) => output.split("\n").find((l) => l.includes(name)) ?? "";

/** A page global or expression, read in the page's own world. */
const mainJs = async (code) => {
	const r = await call(client, "run_js", { code, world: "main" });
	// run_js answers with JSON: {"value": ...} from the bridge, or a bare value.
	let value = r.full.trim();
	try {
		const parsed = JSON.parse(value);
		value = parsed && typeof parsed === "object" && "value" in parsed ? parsed.value : parsed;
	} catch {
		value = value.replace(/^"|"$/g, "");
	}
	return { ...r, value: typeof value === "string" ? value : JSON.stringify(value) };
};

const results = [];
/** Raw output per probe, joined across the calls it made. */
let raw = [];
const keep = (...calls) => {
	for (const c of calls) raw.push(c.full);
};

async function probe(id, fn) {
	raw = [];
	let pass = false;
	let detail;
	try {
		({ pass, detail } = await fn());
	} catch (err) {
		detail = `harness error: ${err.message}`;
	}
	results.push({ id, pass: Boolean(pass), detail, output: raw.join("\n---\n").slice(0, RAW_MAX) });
}

// ---- run ---------------------------------------------------------------------------

let exitCode = 0;
try {
	fx = await launchFixtureBrowser({ extensionDir: EXTENSION });
	await fx.waitConnected();
	({ client } = await mcpClient({ ...fx.env, TABKYRA_SESSION: "perception" }));
	const { tools } = await client.listTools();
	const toolNames = new Set(tools.map((t) => t.name));
	keep(await call(client, "tabs_context"));

	let seen;
	await probe("shadow-see", async () => {
		await go("/shadow");
		seen = await interactive();
		keep(seen);
		return {
			pass: seen.full.includes("Shadow Save"),
			detail: seen.full.includes("Shadow Save") ? "button listed" : "Shadow Save not in interactive read",
		};
	});
	const shadowRead = seen;

	await probe("shadow-click", async () => {
		const ref = refFor(shadowRead.full, "Shadow Save");
		if (!ref) return { pass: false, detail: "no ref for Shadow Save" };
		const click = await call(client, "click", { ref });
		const js = await mainJs("window.__clicked");
		keep(click, js);
		return { pass: js.value === "shadow", detail: `click ${click.outcome}, __clicked=${js.value}` };
	});

	await probe("nested-fill", async () => {
		const ref = refFor(shadowRead.full, "Nested email");
		if (!ref) return { pass: false, detail: "no ref for Nested email" };
		const fill = await call(client, "fill", { ref, value: "a@b.co" });
		const js = await mainJs(
			`document.querySelector("x-card").shadowRoot.querySelector("x-field").shadowRoot.getElementById("em").value`,
		);
		keep(fill, js);
		return { pass: js.value === "a@b.co", detail: `fill ${fill.outcome}, value=${js.value}` };
	});

	await probe("shadow-text", async () => {
		const page = await call(client, "read_page", {});
		const text = await call(client, "get_page_text", {});
		keep(page, text);
		const inRead = page.full.includes("Shadow paragraph 7731");
		const inText = text.full.includes("Shadow paragraph 7731");
		return {
			pass: inRead && inText,
			detail: `read_page ${inRead ? "yes" : "no"}, get_page_text ${inText ? "yes" : "no"}`,
		};
	});

	let framesRead;
	await probe("frame-see", async () => {
		await go("/frames");
		framesRead = await interactive();
		keep(framesRead);
		const ok = framesRead.full.includes("Frame Pay");
		return { pass: ok, detail: ok ? "button listed" : "Frame Pay not in interactive read" };
	});

	await probe("frame-click", async () => {
		const ref = refFor(framesRead.full, "Frame Pay");
		if (!ref) return { pass: false, detail: "no ref for Frame Pay" };
		const click = await call(client, "click", { ref });
		const js = await mainJs("window.__clicked");
		keep(click, js);
		return { pass: js.value === "frame", detail: `click ${click.outcome}, __clicked=${js.value}` };
	});

	await probe("xorigin-flag", async () => {
		const page = await interactive();
		keep(page);
		const byHost = page.full.includes(`127.0.0.1:${portB}`);
		const byWord = /iframe/i.test(page.full);
		return { pass: byHost || byWord, detail: `host ${byHost ? "yes" : "no"}, word iframe ${byWord ? "yes" : "no"}` };
	});

	await probe("states", async () => {
		await go("/states");
		const page = await interactive();
		keep(page);
		const want = [
			["Menu", "expanded"],
			["Bold", "pressed"],
			["Submit order", "disabled"],
			["Billing", "selected"],
			["Dark mode", "checked"],
		];
		const missing = want
			.filter(([name, state]) => !lineWith(page.full, name).includes(state))
			.map(([name, state]) => `${name}:${state}`);
		return {
			pass: missing.length === 0,
			detail: missing.length ? `missing ${missing.join(", ")}` : "all five states shown",
		};
	});

	await probe("cost", async () => {
		const page = await interactive();
		keep(page);
		const bytes = Buffer.byteLength(page.full);
		return { pass: bytes < 4000, detail: `${bytes} bytes` };
	});

	let network;
	await probe("api-request", async () => {
		// Read before navigating: the first call starts capture.
		keep(await call(client, "read_network", { urlPattern: "/api/price" }));
		await go("/api-page");
		const waited = await call(client, "wait", { text: "Price: 4242", timeoutMs: 10000 });
		network = await call(client, "read_network", { urlPattern: "/api/price" });
		keep(waited, network);
		const ok = network.full.includes("/api/price") && network.full.includes("200");
		return {
			pass: ok,
			detail: ok ? "request and status 200 listed" : `wait ${waited.outcome}; request or 200 missing`,
		};
	});

	await probe("api-body", async () => {
		const id = network?.full.match(/"?(?:requestId|request_id|id)"?\s*[:=]\s*"?([\w.-]+)"?/i)?.[1];
		if (!id) return { pass: false, detail: `no request id in output: ${(network?.full ?? "").slice(0, 300)}` };
		const body = await call(client, "read_network", { requestId: id });
		keep(body);
		const ok = body.full.includes("api-only-9081");
		return { pass: ok, detail: ok ? `body for ${id}` : `no body for ${id}` };
	});

	await probe("embedded-map", async () => {
		if (!toolNames.has("inspect_page")) return { pass: false, detail: "no inspect_page tool" };
		await go("/embedded");
		const page = await call(client, "inspect_page", {});
		keep(page);
		const ok = page.full.includes("__NEXT_DATA__") && page.full.includes("/subscribe");
		return { pass: ok, detail: ok ? "script data and form action listed" : "__NEXT_DATA__ or /subscribe missing" };
	});

	// Report in the order the task lists the probes.
	const order = [
		"shadow-see",
		"shadow-click",
		"nested-fill",
		"shadow-text",
		"frame-see",
		"frame-click",
		"xorigin-flag",
		"states",
		"api-request",
		"api-body",
		"embedded-map",
		"cost",
	];
	results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

	const width = Math.max(...results.map((r) => r.id.length));
	for (const r of results)
		console.log(`${r.id.padEnd(width)}  ${r.pass ? "pass" : "FAIL"}  ${r.detail.replace(/\s+/g, " ").slice(0, 160)}`);
	const score = results.filter((r) => r.pass).length;
	console.log(`score: ${score}/${order.length}`);
	if (OUT)
		writeFileSync(
			OUT,
			`${JSON.stringify({ at: new Date().toISOString(), extension: EXTENSION, score, total: order.length, probes: results }, null, 2)}\n`,
		);
} catch (err) {
	console.error(err);
	exitCode = 1;
} finally {
	await cleanup();
}
process.exit(exitCode);
