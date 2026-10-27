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

test("forgetting an empty session does not drop a tab a client added meanwhile", async () => {
	let lost = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const { BrowserSession } = await load("worker");
		const client = await BrowserSession.open("bridge-claude-abc", "claude", 1);
		// dropEmptyBridgeSessions on worker start, while the reconnected client opens a tab.
		const drop = (async () => {
			const s = await BrowserSession.open("bridge-claude-abc", "claude", 1);
			if (s.closeIfEmpty) await s.closeIfEmpty();
			else await s.close();
		})();
		const [, created] = await Promise.all([drop, client.createTab("https://a.example/")]);
		if (!fake.table()["bridge-claude-abc"]?.tabIds.includes(created.id)) lost++;
	}
	assert.equal(lost, 0, `${lost}/20 runs forgot the session after the client's tab was recorded`);
});

test("a late storage event does not roll back a context's cache", async () => {
	const fake = installFakeChrome();
	const panel = await load("panel");
	const worker = await load("worker");
	const home = fake.addTab({ active: true });
	const p = await panel.BrowserSession.open("saved-1", "chat", 1);
	await p.setHomeTab(home);
	await p.adopt(home, true);
	await new Promise((r) => setTimeout(r, 10));
	fake.holdChanges();
	const popup = fake.addTab({ url: "https://example.com/popup" });
	const w = await worker.BrowserSession.open("saved-1", "chat", 1);
	await w.adopt(popup, true);
	const workerWrites = fake.heldCount();
	const created = await p.createTab("https://example.com/next");
	// The worker's older writes reach the panel only now, before the panel's own.
	fake.releaseChanges(workerWrites);
	assert.ok(p.tabIds.includes(created.id), `panel cache rolled back to an older table: ${p.tabIds}`);
	assert.ok(p.tabIds.includes(popup), `panel cache misses the worker's popup: ${p.tabIds}`);
	fake.releaseChanges();
	await new Promise((r) => setTimeout(r, 10));
	// And the worker's cache picks up the panel's tab from the panel's write.
	assert.ok(w.tabIds.includes(created.id), `worker cache misses the panel's tab: ${w.tabIds}`);
});

test("prune leaves the table alone when the tab list can't be read", async () => {
	const fake = installFakeChrome();
	const { BrowserSession, pruneSessions } = await load("worker");
	const home = fake.addTab({ active: true });
	const p = await BrowserSession.open("saved-1", "chat", 1);
	await p.setHomeTab(home);
	await p.adopt(home, true);
	const b = await BrowserSession.open("bridge-claude-a", "claude", 1);
	await b.createTab("https://a.example/");
	const before = fake.table();
	fake.setFailQuery(true);
	await pruneSessions(new Set()).catch(() => undefined);
	fake.setFailQuery(false);
	assert.deepEqual(Object.keys(fake.table()).sort(), Object.keys(before).sort(), "sessions were dropped");
	assert.deepEqual(fake.table()["saved-1"].tabIds, before["saved-1"].tabIds);
	assert.deepEqual(fake.table()["bridge-claude-a"].tabIds, before["bridge-claude-a"].tabIds);
});

test("a session a client holds stays current after prune forgets its empty record", async () => {
	const fake = installFakeChrome();
	const { BrowserSession, pruneSessions } = await load("worker");
	const held = await BrowserSession.open("bridge-claude-abc", "claude", 1);
	const owner = fake.addTab({ url: "https://a.example/" });
	await pruneSessions(new Set());
	// The client's next call opens a tab; then the guard adopts a popup through open().
	await held.adopt(owner, true);
	const popup = fake.addTab({ url: "https://a.example/popup" });
	const guard = await BrowserSession.open("bridge-claude-abc", "claude", 1);
	await guard.adopt(popup, true);
	assert.ok(held.tabIds.includes(popup), `the client's session misses the popup: ${held.tabIds}`);
	assert.equal(held.currentTabId, popup);
});
