// The service worker's side of updates (src/update/worker.ts): the side panel's buttons become
// bare {type, action} frames to the native host, only from Tabkyra's own pages, and the reload
// after an update waits while an agent runs.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));

async function start() {
	const fake = installFakeChrome();
	chrome.runtime.getURL = (p) => `chrome-extension://fake/${p}`;
	let reloads = 0;
	chrome.runtime.reload = () => {
		reloads++;
	};
	// The hello reads build-info.json over fetch; there is none here.
	globalThis.fetch = async () => ({ ok: false });
	const native = await import("../src/bridge/native.ts");
	const worker = await import("../src/update/worker.ts");
	globalThis.setTimeout = (fn, ms, ...args) => {
		const t = realSetTimeout(fn, ms, ...args);
		if (ms >= 10000) t.unref();
		return t;
	};
	try {
		native.startBridge();
		worker.startUpdateWorker();
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
	const port = fake.ports[0];
	const ask = (message, url) =>
		new Promise((resolve) => {
			for (const fn of chrome.runtime.onMessage.listeners) fn(message, { id: "fake", url }, resolve);
		});
	return { fake, port, ask, reloads: () => reloads };
}

const ctx = await start();
const panelUrl = "chrome-extension://fake/sidepanel.html";

test("Update now sends only the action name to the native host", async () => {
	const before = ctx.port.sent.length;
	assert.deepEqual(await ctx.ask({ type: "tabkyra-update", action: "update" }, panelUrl), { ok: true });
	const sent = ctx.port.sent.slice(before).filter((m) => m.type === "update_action");
	assert.deepEqual(sent, [{ type: "update_action", action: "update" }]);
});

test("unknown actions and web pages are refused before anything reaches the host", async () => {
	const before = ctx.port.sent.length;
	const bad = await ctx.ask({ type: "tabkyra-update", action: "update --channel nightly" }, panelUrl);
	assert.equal(bad.ok, false);
	// A content script's sender.url is the page, not the extension.
	const page = await ctx.ask({ type: "tabkyra-update", action: "update" }, "https://example.com/");
	assert.equal(page.ok, false);
	assert.equal(ctx.port.sent.slice(before).filter((m) => m.type === "update_action").length, 0);
});

const progressNow = async () => (await chrome.storage.local.get("tabkyra.updateProgress"))["tabkyra.updateProgress"];
const pendingNow = async () => (await chrome.storage.local.get("tabkyra.updatePending"))["tabkyra.updatePending"];
const actionsSent = (from) => ctx.port.sent.slice(from).filter((m) => m.type === "update_action").map((m) => m.action);

const busy = (on) => chrome.storage.session.set({ sidepanel_busy_1: on ? 105 : false, sidepanel_busy_beat_1: Date.now() });

test("a staged update is activated only when no side panel run is going, then reloads", async () => {
	await busy(true);
	const from = ctx.port.sent.length;
	ctx.port.deliver({ type: "update_progress", action: "update", phase: "done", message: "Built", at: Date.now(), staged: true });
	await sleep(400);
	assert.deepEqual(actionsSent(from), [], "nothing is installed while the agent runs");
	const waiting = await progressNow();
	assert.equal(waiting.phase, "waiting");
	assert.match(waiting.message, /agent run is going in a side panel/);
	assert.equal((await chrome.storage.session.get("tabkyra.updateInstalling"))["tabkyra.updateInstalling"], undefined, "no gate while waiting");

	await busy(false);
	await sleep(3600);
	assert.deepEqual(actionsSent(from), ["activate"], "activates once the run ended");
	assert.equal(ctx.reloads(), 0, "no reload before the install is done");

	// While it installs, the gate holds: new bridge requests are refused, the panel sees it too.
	assert.ok((await chrome.storage.session.get("tabkyra.updateInstalling"))["tabkyra.updateInstalling"], "the gate is held");
	ctx.port.deliver({ type: "client_connected", clientId: "c9", client: { name: "claude", session: "s9" } });
	await sleep(50);
	ctx.port.deliver({ type: "request", clientId: "c9", id: 77, method: "tabs.context", params: {} });
	await sleep(300);
	const refused = ctx.port.sent.find((m) => m.type === "response" && m.clientId === "c9" && m.id === 77);
	assert.match(refused?.error?.message ?? "", /installing an update/);

	ctx.port.deliver({ type: "update_progress", action: "activate", phase: "done", message: "Installed", at: Date.now(), reload: true, extensionBuild: "new-build" });
	await sleep(400);
	assert.equal(ctx.reloads(), 1, "reloads right after the install");
	const pending = await pendingNow();
	assert.equal(pending.extensionBuild, "new-build");
	assert.ok(pending.reloadedFrom, "remembers the build that reloaded, to check the result after");
});

test("a failed install drops the gate and nothing reloads", async () => {
	await chrome.storage.local.remove("tabkyra.updatePending");
	await busy(false);
	const before = ctx.reloads();
	ctx.port.deliver({ type: "update_progress", action: "update", phase: "done", message: "Built", at: Date.now(), staged: true });
	await sleep(400);
	ctx.port.deliver({ type: "update_progress", action: "activate", phase: "failed", message: "disk full", at: Date.now() });
	await sleep(300);
	assert.equal((await chrome.storage.session.get("tabkyra.updateInstalling"))["tabkyra.updateInstalling"], undefined);
	assert.equal(await pendingNow(), undefined);
	assert.equal(ctx.reloads(), before);
});

test("a busy flag without a fresh heartbeat (its panel crashed) doesn't hold the reload", async () => {
	await chrome.storage.local.remove("tabkyra.updatePending");
	await chrome.storage.session.set({ sidepanel_busy_1: false, sidepanel_busy_7: 300, sidepanel_busy_beat_7: Date.now() - 120000 });
	const before = ctx.reloads();
	assert.deepEqual(await ctx.ask({ type: "tabkyra-update", action: "reload" }, panelUrl), { ok: true });
	await sleep(600);
	assert.equal(ctx.reloads(), before + 1);
	await chrome.storage.session.set({ sidepanel_busy_7: false });
});

test("Roll back waits for idle in the worker before the host swaps anything", async () => {
	await chrome.storage.local.remove("tabkyra.updatePending");
	await busy(true);
	const from = ctx.port.sent.length;
	await ctx.ask({ type: "tabkyra-update", action: "rollback" }, panelUrl);
	await sleep(400);
	assert.deepEqual(actionsSent(from), []);
	await busy(false);
	await sleep(3600);
	assert.deepEqual(actionsSent(from), ["rollback"]);
	// "activate" is the worker's own step; the panel can't send it directly.
	const bad = await ctx.ask({ type: "tabkyra-update", action: "activate" }, panelUrl);
	assert.equal(bad.ok, false);
});
