// The browser_sessions table is written by two extension contexts at once: the side panel and
// the service worker (bridge, foreground guard, prune). Each `?ctx=` import below is a separate
// instance of session.ts with its own in-memory sessions, as each context has. Storage must stay
// the source of truth: no writer may put back an older copy of a session and lose a tab.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const load = (ctx) => import(`../src/browser/session.ts?ctx=${ctx}-${Math.random()}`);

test("first save: setLabel and rename fired together leave one record, renamed", async () => {
	let bad = 0;
	for (let run = 0; run < 30; run++) {
		const fake = installFakeChrome();
		const { BrowserSession } = await load("panel");
		const home = fake.addTab({ active: true });
		const s = await BrowserSession.open(`tab-${home}`, "chat", 1);
		await s.setHomeTab(home);
		await s.adopt(home, true);
		// The pattern sidepanel.ts used: both calls from one event, neither awaited.
		await Promise.all([s.setLabel("My task"), BrowserSession.rename(`tab-${home}`, "saved-1")]);
		const t = fake.table();
		if (Object.keys(t).join() !== "saved-1" || t["saved-1"].label !== "My task" || s.id !== "saved-1") bad++;
	}
	assert.equal(bad, 0, `${bad}/30 runs left a stale record, lost the label or kept the old id`);
});

test("a tab the user takes back after the first save is no longer agent-owned", async () => {
	let owned = 0;
	for (let run = 0; run < 30; run++) {
		const fake = installFakeChrome();
		const { BrowserSession } = await load("panel");
		const home = fake.addTab({ active: true });
		const s = await BrowserSession.open(`tab-${home}`, "chat", 1);
		await s.setHomeTab(home);
		await s.adopt(home, true);
		await Promise.all([s.setLabel("My task"), BrowserSession.rename(`tab-${home}`, "saved-1")]);
		const again = await BrowserSession.open("saved-1", "My task", 1);
		await again.setHomeTab(home);
		await again.adopt(home, false);
		await again.release(home);
		// The foreground guard in the worker decides from storage which tabs are agent-owned.
		const worker = await load("worker");
		if ((await worker.allOwnedTabIds()).has(home)) owned++;
	}
	assert.equal(owned, 0, `${owned}/30 runs: the released tab still counts as agent-owned`);
});

test("a rename in the panel is followed by a worker still holding the old id", async () => {
	let zombies = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const panel = await load("panel");
		const worker = await load("worker");
		const home = fake.addTab({ active: true });
		const p = await panel.BrowserSession.open(`tab-${home}`, "chat", 1);
		await p.setHomeTab(home);
		await p.adopt(home, true);
		// The guard opened the session under its unsaved id just before the first save.
		const w = await worker.BrowserSession.open(`tab-${home}`, "chat", 1);
		const popup = fake.addTab({ url: "https://example.com/popup" });
		await Promise.all([panel.BrowserSession.rename(`tab-${home}`, "saved-1"), w.adopt(popup, true)]);
		const t = fake.table();
		if (Object.keys(t).join() !== "saved-1" || !t["saved-1"].tabIds.includes(popup)) zombies++;
	}
	assert.equal(zombies, 0, `${zombies}/20 runs recreated the old record or lost the popup`);
});

test("a popup the worker adopts for a panel session survives the panel's next tab and the worker's prune", async () => {
	const fake = installFakeChrome();
	const panel = await load("panel");
	const worker = await load("worker");
	const home = fake.addTab({ active: true });
	const p = await panel.BrowserSession.open("saved-1", "chat", 1);
	await p.setHomeTab(home);
	await p.adopt(home, true);
	// The foreground guard (worker) adopts a popup opened from the panel's tab.
	const popup = fake.addTab({ url: "https://example.com/popup" });
	const w = await worker.BrowserSession.open("saved-1", "chat", 1);
	await w.adopt(popup, true);
	// The panel's agent opens a new tab, then the worker's periodic prune runs.
	const created = await p.createTab("https://example.com/next");
	const afterCreate = fake.table()["saved-1"].tabIds;
	await worker.pruneSessions(new Set());
	const afterPrune = fake.table()["saved-1"].tabIds;
	assert.ok(afterCreate.includes(popup), `popup lost by the panel's createTab: ${afterCreate}`);
	assert.ok(afterPrune.includes(created.id), `panel's tab lost by the worker's prune: ${afterPrune}`);
	assert.ok(afterPrune.includes(popup), `popup lost by the worker's prune: ${afterPrune}`);
});

test("panel and worker adding tabs to one session at once keep both", async () => {
	let lost = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const panel = await load("panel");
		const worker = await load("worker");
		const p = await panel.BrowserSession.open("saved-1", "chat", 1);
		const w = await worker.BrowserSession.open("saved-1", "chat", 1);
		const popup = fake.addTab({ url: "https://example.com/popup" });
		const [created] = await Promise.all([p.createTab("https://example.com/next"), w.adopt(popup, true)]);
		const ids = fake.table()["saved-1"].tabIds;
		if (!ids.includes(popup) || !ids.includes(created.id)) lost++;
	}
	assert.equal(lost, 0, `${lost}/20 runs lost one of the two tabs`);
});

test("two bridge sessions creating tabs at once both keep their tabs", async () => {
	let lost = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const { BrowserSession } = await load("worker");
		const a = await BrowserSession.open("bridge-claude-a", "claude", 1);
		const b = await BrowserSession.open("bridge-codex-b", "codex", 1);
		const [ta, tb] = await Promise.all([a.createTab("https://a.example/"), b.createTab("https://b.example/")]);
		const t = fake.table();
		if (!t["bridge-claude-a"]?.tabIds.includes(ta.id) || !t["bridge-codex-b"]?.tabIds.includes(tb.id)) lost++;
	}
	assert.equal(lost, 0, `${lost}/20 runs lost a session's new tab from storage`);
});

test("prune running while the panel opens a tab does not drop that tab", async () => {
	let lost = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const panel = await load("panel");
		const worker = await load("worker");
		const home = fake.addTab({ active: true });
		const p = await panel.BrowserSession.open("saved-1", "chat", 1);
		await p.setHomeTab(home);
		await p.adopt(home, true);
		// Start the prune at a random point inside createTab.
		const prune = new Promise((r) => setTimeout(r, Math.random() * 20)).then(() => worker.pruneSessions(new Set()));
		const [created] = await Promise.all([p.createTab("https://example.com/next"), prune]);
		if (!fake.table()["saved-1"]?.tabIds.includes(created.id)) lost++;
	}
	assert.equal(lost, 0, `${lost}/20 runs: prune dropped a tab created while it ran`);
});

test("prune still drops closed tabs and forgets abandoned bridge sessions", async () => {
	const fake = installFakeChrome();
	const { BrowserSession, pruneSessions } = await load("worker");
	const a = await BrowserSession.open("bridge-claude-a", "claude", 1);
	const tab = await a.createTab("https://a.example/");
	const blank = await a.createTab();
	const b = await BrowserSession.open("bridge-codex-b", "codex", 1);
	const gone = await b.createTab("https://b.example/");
	fake.removeTab(gone.id);
	const result = await pruneSessions(new Set());
	const t = fake.table();
	assert.deepEqual(t["bridge-claude-a"].tabIds, [tab.id], "blank tab of an abandoned session closed");
	assert.equal(fake.hasTab(blank.id), false);
	assert.equal(t["bridge-codex-b"], undefined, "session left with no tabs is forgotten");
	assert.deepEqual(result, { dropped: 1, closedTabs: 1 });
});
