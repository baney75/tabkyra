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

test("after an update the reload waits while a side panel run is going, then happens", async () => {
	await chrome.storage.session.set({ sidepanel_busy_1: 105 });
	ctx.port.deliver({ type: "update_progress", action: "update", phase: "done", message: "Built", at: Date.now(), reload: true, extensionBuild: "new-build" });
	await sleep(400);
	assert.equal(ctx.reloads(), 0, "no reload while the agent runs");
	const { "tabkyra.updateProgress": waiting } = await chrome.storage.local.get("tabkyra.updateProgress");
	assert.equal(waiting.phase, "waiting");
	assert.match(waiting.message, /agent run is going in a side panel/);

	await chrome.storage.session.set({ sidepanel_busy_1: false });
	await sleep(3600);
	assert.equal(ctx.reloads(), 1, "reloads once the run ended");
	const { "tabkyra.reloadPending": pending } = await chrome.storage.local.get("tabkyra.reloadPending");
	assert.equal(pending.extensionBuild, "new-build");
	assert.ok(pending.reloadedFrom, "remembers the build that reloaded, to check the result after");
});
