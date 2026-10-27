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

test("panel and worker adding tabs to one session at once keep both, in one group", async () => {
	let lost = 0;
	let split = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const panel = await load("panel");
		const worker = await load("worker");
		const p = await panel.BrowserSession.open("saved-1", "chat", 1);
		const w = await worker.BrowserSession.open("saved-1", "chat", 1);
		const popup = fake.addTab({ url: "https://example.com/popup" });
		const [created] = await Promise.all([p.createTab("https://example.com/next"), w.adopt(popup, true)]);
		const stored = fake.table()["saved-1"];
		if (!stored.tabIds.includes(popup) || !stored.tabIds.includes(created.id)) lost++;
		// Both tabs end up in the one group the session records, not one group each.
		if (fake.groupOf(popup) !== stored.groupId || fake.groupOf(created.id) !== stored.groupId) split++;
	}
	assert.equal(lost, 0, `${lost}/20 runs lost one of the two tabs`);
	assert.equal(split, 0, `${split}/20 runs left the tabs in two groups`);
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

test("the foreground guard adopting a popup during the first-save rename lands in the saved chat", async () => {
	let bad = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const panel = await load("panel");
		// The guard runs in the worker; its session.ts import is the worker's module instance.
		const guard = await import(`../src/browser/foreground-guard.ts?ctx=${Math.random()}`);
		guard.startForegroundGuard();
		const home = fake.addTab({ active: true });
		const p = await panel.BrowserSession.open(`tab-${home}`, "chat", 1);
		await p.setHomeTab(home);
		await p.adopt(home, true);
		const popup = fake.addTab({ url: "https://example.com/popup" });
		for (const fn of chrome.webNavigation.onCreatedNavigationTarget.listeners) fn({ tabId: popup, sourceTabId: home });
		await new Promise((r) => setTimeout(r, Math.random() * 15));
		await panel.BrowserSession.rename(`tab-${home}`, "saved-1");
		for (let i = 0; i < 200 && !fake.table()["saved-1"]?.tabIds.includes(popup); i++)
			await new Promise((r) => setTimeout(r, 5));
		await new Promise((r) => setTimeout(r, 30));
		const t = fake.table();
		if (Object.keys(t).join() !== "saved-1" || !t["saved-1"].tabIds.includes(popup)) bad++;
	}
	assert.equal(bad, 0, `${bad}/20 runs recreated the old record or lost the popup`);
});

test("a new chat reusing a renamed id never follows the old rename into the saved chat", async () => {
	const fake = installFakeChrome();
	const { BrowserSession } = await load("panel");
	const home = fake.addTab({ active: true });
	const a = await BrowserSession.open(`tab-${home}`, "chat", 1);
	await a.setHomeTab(home);
	await a.adopt(home, true);
	await BrowserSession.rename(`tab-${home}`, "saved-1");
	// New chat on the same tab: a fresh session under the same unsaved id, empty at first.
	const other = await load("panel2");
	const b = await other.BrowserSession.open(`tab-${home}`, "chat", 1);
	// Another panel's startup cleanup forgets it before its first tab.
	const cleaner = (await load("panel3")).BrowserSession;
	if (cleaner.dropIfEmpty) await cleaner.dropIfEmpty(`tab-${home}`);
	else await (await cleaner.open(`tab-${home}`, "chat", 1)).closeIfEmpty();
	const tab = fake.addTab({ url: "https://b.example/" });
	await b.adopt(tab, true);
	const t = fake.table();
	assert.equal(b.id, `tab-${home}`, "chat B was rebound to the saved chat's id");
	assert.ok(!t["saved-1"].tabIds.includes(tab), "chat B's tab went into chat A's session");
	assert.ok(t[`tab-${home}`]?.tabIds.includes(tab));
});

test("a tab the user takes back stays theirs while another context reconciles", async () => {
	let bad = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const panel = await load("panel");
		const worker = await load("worker");
		const home = fake.addTab({ active: true });
		const p = await panel.BrowserSession.open("saved-1", "chat", 1);
		await p.setHomeTab(home);
		await p.adopt(home, true);
		await p.createTab("https://example.com/agent");
		fake.setUngroupDelay(40);
		const reconcile = new Promise((r) => setTimeout(r, 5 + Math.random() * 15)).then(() =>
			worker.BrowserSession.open("saved-1", "chat", 1),
		);
		await Promise.all([p.release(home), reconcile]);
		// Any later reconcile must not take it back either.
		await (await worker.BrowserSession.open("saved-1", "chat", 1)).tabs();
		if (fake.table()["saved-1"].tabIds.includes(home) || fake.groupOf(home) !== -1) bad++;
	}
	assert.equal(bad, 0, `${bad}/20 runs: the released tab went back to the agent`);
});

test("dropping an empty record leaves the instance a client holds registered", async () => {
	installFakeChrome();
	const { BrowserSession } = await load("worker");
	const held = await BrowserSession.open("bridge-claude-abc", "claude", 1);
	if (BrowserSession.dropIfEmpty) await BrowserSession.dropIfEmpty("bridge-claude-abc");
	else await (await BrowserSession.open("bridge-claude-abc", "claude", 1)).closeIfEmpty();
	assert.equal(await BrowserSession.open("bridge-claude-abc", "claude", 1), held);
});

test("caches keep following writes after extension storage is cleared", async () => {
	const fake = installFakeChrome();
	const panel = await load("panel");
	const worker = await load("worker");
	const p = await panel.BrowserSession.open("saved-1", "chat", 1);
	for (let i = 0; i < 5; i++) await p.adopt(fake.addTab({}), true);
	fake.clearLocal();
	const w = await worker.BrowserSession.open("saved-1", "chat", 1);
	const tab = fake.addTab({});
	await w.adopt(tab, true);
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(p.tabIds.includes(tab), `panel cache stopped following after the wipe: ${p.tabIds}`);
});

test("adoptIfFree: a tab another session took first stays with it, even when both race", async () => {
	let taken = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const panel = await load("panel");
		const worker = await load("worker");
		const tab = fake.addTab({ active: false });
		const chat = await panel.BrowserSession.open("chat-1", "chat", 1);
		const agent = await worker.BrowserSession.open("bridge-claude", "Claude Code", 1);
		// The bridge agent claims the tab while the panel resolves a reference to it.
		const [, owner] = await Promise.all([agent.adopt(tab, true), chat.adoptIfFree(tab, true)]);
		const t = fake.table();
		const chatHas = t["chat-1"].tabIds.includes(tab);
		const agentHas = t["bridge-claude"].tabIds.includes(tab);
		// Whichever lands first, the agent ends up with the tab: its adopt takes it from the chat,
		// and the chat's adoptIfFree never takes it from the agent. (Plain adopt would, when second.)
		if (!agentHas || chatHas) taken++;
		if (owner !== undefined && owner.id !== "bridge-claude") taken++;
	}
	assert.equal(taken, 0, `${taken}/20 runs: the tab was shared twice, lost, or taken from the agent`);
});

test("adoptIfFree takes an unowned tab and makes it current", async () => {
	const fake = installFakeChrome();
	const { BrowserSession } = await load("panel");
	const tab = fake.addTab({ active: false });
	const chat = await BrowserSession.open("chat-2", "chat", 1);
	assert.equal(await chat.adoptIfFree(tab, true), undefined);
	assert.deepEqual(fake.table()["chat-2"].tabIds, [tab]);
	assert.equal(fake.table()["chat-2"].currentTabId, tab);
	const other = await BrowserSession.open("chat-3", "other", 1);
	assert.deepEqual(await other.adoptIfFree(tab, true), { id: "chat-2", label: "chat" });
	assert.deepEqual(fake.table()["chat-2"].tabIds, [tab], "the first chat keeps it");
	assert.deepEqual(fake.table()["chat-3"].tabIds, []);
});
