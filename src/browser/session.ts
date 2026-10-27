/**
 * BrowserSession: the set of tabs an agent owns.
 *
 * Every agent (a sidepanel chat session or an external harness connected through
 * the bridge) gets one session. The session owns a Chrome tab group in one window,
 * creates its tabs inactive, tracks which tab tools act on, and never touches tabs
 * outside the group. Nothing here changes window focus or the active tab; that is
 * reserved for the explicit `show()` call.
 *
 * State lives in chrome.storage.local so it survives sidepanel reloads, service worker
 * restarts and extension reloads (Chrome's tab groups do too). Tab and group ids that no
 * longer exist are dropped on reconcile, which is what happens after a browser restart.
 *
 * Two extension contexts write the table: the side panel and the service worker (bridge,
 * foreground guard, prune). Storage is the source of truth. Every write runs under one Web
 * Lock shared by all extension contexts, re-reads the table and changes only the stored
 * entry it means to change. A BrowserSession's `state` is a read cache of its entry; it
 * never writes that cache back whole.
 */

import { detachTab, ensureAttached, isRestrictedUrl, releaseAgentViewport } from "./cdp.js";

const STORAGE_KEY = "browser_sessions";
const GROUP_PREFIX = "Tabkyra";
const GROUP_COLORS: `${chrome.tabGroups.Color}`[] = [
	"blue",
	"cyan",
	"green",
	"orange",
	"red",
	"pink",
	"purple",
	"yellow",
];

export interface TabInfo {
	id: number;
	url: string;
	title: string;
	current: boolean;
	favicon?: string;
	/** False when the tab sits outside the session's group (dragged out, or grouping failed). */
	inGroup: boolean;
}

interface PersistedSession {
	id: string;
	label: string;
	color: `${chrome.tabGroups.Color}`;
	windowId: number;
	groupId?: number;
	tabIds: number[];
	currentTabId?: number;
	/** The tab the panel that owns this session was opened on (Claude-style per-tab binding). */
	homeTabId?: number;
	/** Last time a tool touched the session (ms since epoch); drives cleanup of abandoned sessions. */
	lastUsedAt?: number;
}

type SessionTable = Record<string, PersistedSession>;
/** Old id -> new id for sessions renamed on first save, so a context holding the old id follows. */
type RenameTable = Record<string, { to: string; at: number }>;

const RENAMES_KEY = "browser_session_renames";
const RENAME_TTL_MS = 60 * 60 * 1000;
/** One lock for the table across the side panel and the service worker (same origin). */
const LOCK_NAME = "tabkyra-browser-sessions";

async function readTable(): Promise<SessionTable> {
	const data = await chrome.storage.local.get(STORAGE_KEY);
	return (data[STORAGE_KEY] as SessionTable | undefined) ?? {};
}

let fallbackChain: Promise<unknown> = Promise.resolve();

/** Run `fn` holding the table lock. Not reentrant: never call it from inside `fn`. */
function withTableLock<T>(fn: () => Promise<T>): Promise<T> {
	const locks = (globalThis.navigator as Navigator | undefined)?.locks;
	// The callback's promise is what request() resolves with; lib.dom types it one level deep.
	if (locks) return locks.request(LOCK_NAME, fn) as unknown as Promise<T>;
	// No Web Locks (not an extension context): serialize within this context only.
	const run = fallbackChain.then(fn, fn);
	fallbackChain = run.catch(() => undefined);
	return run;
}

interface TableTx {
	table: SessionTable;
	renames: RenameTable;
}

/**
 * Read-modify-write the table under the lock. `fn` changes `tx` in place and must not take
 * the lock itself. Every instance in this context is refreshed from what was written.
 */
async function mutateTable<T>(fn: (tx: TableTx) => T | Promise<T>): Promise<T> {
	return withTableLock(async () => {
		const data = await chrome.storage.local.get([STORAGE_KEY, RENAMES_KEY]);
		const tx: TableTx = {
			table: (data[STORAGE_KEY] as SessionTable | undefined) ?? {},
			renames: (data[RENAMES_KEY] as RenameTable | undefined) ?? {},
		};
		const before = JSON.stringify(tx.renames);
		const result = await fn(tx);
		const write: Record<string, unknown> = { [STORAGE_KEY]: tx.table };
		if (JSON.stringify(tx.renames) !== before) write[RENAMES_KEY] = tx.renames;
		await chrome.storage.local.set(write);
		refreshInstances(tx.table);
		return result;
	});
}

/** Point every live instance in this context at its freshly stored entry. */
function refreshInstances(table: SessionTable): void {
	for (const [id, inst] of instances) {
		const stored = table[id];
		if (stored) inst.adoptState(structuredClone(stored));
	}
}

/** Keep this context's caches current when the other context writes. */
if (typeof chrome !== "undefined")
	chrome.storage?.onChanged?.addListener((changes, area) => {
		if (area !== "local" || !(STORAGE_KEY in changes)) return;
		const table = changes[STORAGE_KEY].newValue as SessionTable | undefined;
		if (table) refreshInstances(table);
	});

function ownedElsewhere(table: SessionTable, selfId: string, tabId: number): boolean {
	return Object.values(table).some((s) => s.id !== selfId && s.tabIds.includes(tabId));
}

function fixCurrent(s: PersistedSession): void {
	if (s.currentTabId !== undefined && !s.tabIds.includes(s.currentTabId))
		s.currentTabId = s.tabIds[s.tabIds.length - 1];
}

/** Chromium refuses tab edits while a tab is being dragged or animated; retry briefly. */
async function withGroupRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
	let lastError: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			await new Promise((r) => setTimeout(r, 250 * (i + 1)));
		}
	}
	throw lastError;
}

/** Tab ids owned by any session. Used by the foreground guard in the service worker. */
export async function allOwnedTabIds(): Promise<Set<number>> {
	const table = await readTable();
	const ids = new Set<number>();
	for (const s of Object.values(table)) for (const id of s.tabIds) ids.add(id);
	return ids;
}

/** Find the session that owns a tab, if any. */
export async function sessionOwningTab(tabId: number): Promise<PersistedSession | undefined> {
	const table = await readTable();
	return Object.values(table).find((s) => s.tabIds.includes(tabId));
}

/** Summaries of all sessions, for UI. */
export async function listSessions(): Promise<PersistedSession[]> {
	return Object.values(await readTable());
}

/** The id of the session whose home tab is `tabId`, if any. */
export async function sessionIdForTab(tabId: number): Promise<string | undefined> {
	const table = await readTable();
	return Object.values(table).find((s) => s.homeTabId === tabId)?.id;
}

/**
 * Ungroup tabs sitting in "Tabkyra · ..." groups that no live session owns (left behind
 * by an extension reload, which clears session storage but not the browser's groups).
 */
export async function cleanupOrphanGroups(): Promise<number> {
	const table = await readTable();
	const liveGroups = new Set<number>();
	for (const s of Object.values(table)) if (s.groupId !== undefined) liveGroups.add(s.groupId);
	const groups = await chrome.tabGroups.query({}).catch(() => []);
	let released = 0;
	for (const g of groups) {
		if (!g.title?.startsWith(`${GROUP_PREFIX} ·`) || liveGroups.has(g.id)) continue;
		const tabs = await chrome.tabs.query({ groupId: g.id }).catch(() => []);
		for (const t of tabs) {
			if (t.id === undefined) continue;
			await chrome.tabs.ungroup(t.id).catch(() => undefined);
			released++;
		}
	}
	return released;
}

function isBlankUrl(url: string | undefined): boolean {
	return (
		!url ||
		url === "about:blank" ||
		url.startsWith("chrome://newtab") ||
		url.startsWith("brave://newtab") ||
		url.startsWith("edge://newtab") ||
		url.startsWith("chrome://new-tab-page")
	);
}

/**
 * Tidy the session table. Dead tab ids are dropped everywhere. Bridge sessions whose
 * client is gone (`liveIds` lacks them) lose their blank tabs, are forgotten once they
 * own nothing, and have their group collapsed after `idleMs` so finished agent work
 * stops cluttering the tab strip (one click on the group closes it). Side-panel sessions
 * are left alone apart from dead ids: their tabs are the user's.
 *
 * Works from the stored entries, never this context's cached copies, and only removes ids
 * it saw dead: a tab another context adds while this runs is kept.
 */
export async function pruneSessions(
	liveIds: Set<string>,
	idleMs = 30 * 60 * 1000,
): Promise<{
	dropped: number;
	closedTabs: number;
}> {
	// Read the table before listing tabs: any id stored by then that the listing lacks is dead.
	const snapshot = await readTable();
	const liveTabs = new Map<number, chrome.tabs.Tab>();
	for (const t of await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[])) {
		if (t.id !== undefined) liveTabs.set(t.id, t);
	}
	const dead = new Set<number>();
	for (const s of Object.values(snapshot)) {
		for (const id of s.tabIds) if (!liveTabs.has(id)) dead.add(id);
		if (s.homeTabId !== undefined && !liveTabs.has(s.homeTabId)) dead.add(s.homeTabId);
	}
	// Blank tabs of abandoned bridge sessions get closed (outside the lock: tab calls are slow).
	let closedTabs = 0;
	for (const s of Object.values(snapshot)) {
		if (!s.id.startsWith("bridge-") || liveIds.has(s.id)) continue;
		for (const id of s.tabIds) {
			const tab = liveTabs.get(id);
			if (!tab || !isBlankUrl(tab.url ?? tab.pendingUrl) || tab.active) continue;
			await chrome.tabs.remove(id).catch(() => undefined);
			dead.add(id);
			closedTabs++;
		}
	}
	const now = Date.now();
	const toCollapse: number[] = [];
	const droppedIds: string[] = [];
	await mutateTable(({ table }) => {
		for (const s of Object.values(table)) {
			s.tabIds = s.tabIds.filter((id) => !dead.has(id));
			fixCurrent(s);
			if (s.homeTabId !== undefined && dead.has(s.homeTabId)) s.homeTabId = undefined;
			const isBridge = s.id.startsWith("bridge-");
			if (isBridge && !liveIds.has(s.id)) {
				if (s.tabIds.length === 0) {
					delete table[s.id];
					droppedIds.push(s.id);
					continue;
				}
				const userLooking = s.tabIds.some((id) => liveTabs.get(id)?.active);
				if (s.groupId !== undefined && !userLooking && now - (s.lastUsedAt ?? 0) > idleMs)
					toCollapse.push(s.groupId);
			} else if (!isBridge && s.tabIds.length === 0 && s.homeTabId === undefined) {
				delete table[s.id];
				droppedIds.push(s.id);
			}
		}
	});
	for (const id of droppedIds) instances.delete(id);
	for (const groupId of toCollapse) {
		await chrome.tabGroups.update(groupId, { collapsed: true }).catch(() => undefined);
	}
	return { dropped: droppedIds.length, closedTabs };
}

/** "omp", then "omp 2", "omp 3" ...: two agents must not share a group title. */
function uniqueLabel(table: SessionTable, label: string, selfId?: string): string {
	const taken = new Set(
		Object.values(table)
			.filter((s) => s.id !== selfId)
			.map((s) => s.label),
	);
	if (!taken.has(label)) return label;
	for (let n = 2; ; n++) if (!taken.has(`${label} ${n}`)) return `${label} ${n}`;
}

function pickColor(table: SessionTable): `${chrome.tabGroups.Color}` {
	const used = new Set(Object.values(table).map((s) => s.color));
	return GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[Object.keys(table).length % GROUP_COLORS.length];
}

async function tabExists(tabId: number): Promise<chrome.tabs.Tab | undefined> {
	try {
		return await chrome.tabs.get(tabId);
	} catch {
		return undefined;
	}
}

export class NoTabError extends Error {
	constructor() {
		super("This session has no tab yet. Call navigate with a URL first (it opens a tab in your group).");
	}
}

/** One live instance per session id in this context, so concurrent clients share state. */
const instances = new Map<string, BrowserSession>();

export class BrowserSession {
	/** Read cache of the stored entry. Writes go through `update`, never by saving this whole. */
	private state: PersistedSession;

	private constructor(state: PersistedSession) {
		this.state = state;
	}

	/** @internal Replace the cache with a stored copy (see refreshInstances). */
	adoptState(state: PersistedSession): void {
		this.state = state;
	}

	get id(): string {
		return this.state.id;
	}

	get label(): string {
		return this.state.label;
	}

	get windowId(): number {
		return this.state.windowId;
	}

	get tabIds(): number[] {
		return [...this.state.tabIds];
	}

	get currentTabId(): number | undefined {
		return this.state.currentTabId;
	}

	get homeTabId(): number | undefined {
		return this.state.homeTabId;
	}

	/** The tab group title this session uses ("Tabkyra · claude"), whether or not it exists yet. */
	get groupName(): string {
		return this.groupTitle();
	}

	/**
	 * Apply `fn` to this session's stored entry under the table lock. Follows a rename made in
	 * any context; recreates the entry from the cache if another context forgot it, minus tabs
	 * another session now owns. `fn` returning false skips the write's timestamp bump.
	 */
	private async update(fn: (s: PersistedSession, table: SessionTable) => unknown): Promise<void> {
		await mutateTable(({ table, renames }) => {
			let id = this.state.id;
			for (let hops = 0; !table[id] && renames[id] && hops < 8; hops++) id = renames[id].to;
			if (id !== this.state.id) {
				if (instances.get(this.state.id) === this) instances.delete(this.state.id);
				if (!instances.has(id)) instances.set(id, this);
			}
			let s = table[id];
			if (!s) {
				s = structuredClone({ ...this.state, id });
				s.tabIds = s.tabIds.filter((tabId) => !ownedElsewhere(table, id, tabId));
				fixCurrent(s);
				table[id] = s;
			}
			if (fn(s, table) !== false) s.lastUsedAt = Date.now();
			this.state = structuredClone(s);
		});
	}

	/** Re-read this session's stored entry into the cache. */
	private async refresh(): Promise<void> {
		const data = await chrome.storage.local.get([STORAGE_KEY, RENAMES_KEY]);
		const table = (data[STORAGE_KEY] as SessionTable | undefined) ?? {};
		const renames = (data[RENAMES_KEY] as RenameTable | undefined) ?? {};
		let id = this.state.id;
		for (let hops = 0; !table[id] && renames[id] && hops < 8; hops++) id = renames[id].to;
		const stored = table[id];
		if (!stored) return;
		if (id !== this.state.id) {
			if (instances.get(this.state.id) === this) instances.delete(this.state.id);
			if (!instances.has(id)) instances.set(id, this);
		}
		this.state = stored;
	}

	/**
	 * Bind this session to the tab its panel lives on, so reopening the panel there restores
	 * it. Exclusive: any other session that claimed this tab as its home tab gives it up, so a
	 * tab maps to exactly one task (e.g. after "New chat" rebinds the tab to a fresh session).
	 */
	async setHomeTab(tabId: number): Promise<void> {
		await this.update((s, table) => {
			for (const other of Object.values(table)) {
				if (other.id !== s.id && other.homeTabId === tabId) other.homeTabId = undefined;
			}
			s.homeTabId = tabId;
		});
	}

	/**
	 * Open (or re-adopt) a session. `windowId` is where new tabs go; for the sidepanel
	 * that is its own window, for the bridge the last focused normal window.
	 */
	static async open(id: string, label: string, windowId?: number): Promise<BrowserSession> {
		const existing = instances.get(id);
		const fallbackWindow =
			windowId === undefined && !existing && !(await readTable())[id] ? await lastFocusedWindowId() : undefined;
		const state = await mutateTable(({ table }) => {
			let s = table[id];
			if (!s) {
				s = {
					id,
					label: uniqueLabel(table, existing?.label ?? label),
					color: existing?.state.color ?? pickColor(table),
					windowId: windowId ?? fallbackWindow ?? existing?.windowId ?? 0,
					tabIds: [],
				};
				table[id] = s;
			} else {
				if (!existing && s.label !== label && !s.label.startsWith(`${label} `))
					s.label = uniqueLabel(table, label, id);
				if (windowId !== undefined) s.windowId = windowId;
			}
			return structuredClone(s);
		});
		let session = instances.get(id);
		if (session) session.state = state;
		else {
			session = new BrowserSession(state);
			instances.set(id, session);
		}
		await session.reconcile();
		return session;
	}

	/**
	 * Rename a session in place (a sidepanel session gets its real id on first save). The
	 * in-memory id changes inside the same locked write, so an update queued on this instance
	 * lands on the new entry; other contexts follow the recorded rename.
	 */
	static async rename(oldId: string, newId: string): Promise<void> {
		await mutateTable(({ table, renames }) => {
			const now = Date.now();
			for (const [from, r] of Object.entries(renames)) if (now - r.at > RENAME_TTL_MS) delete renames[from];
			const state = table[oldId];
			if (!state) return;
			delete table[oldId];
			state.id = newId;
			table[newId] = state;
			renames[oldId] = { to: newId, at: now };
			const inst = instances.get(oldId);
			if (inst) {
				instances.delete(oldId);
				inst.state = structuredClone(state);
				instances.set(newId, inst);
			}
		});
	}

	/** Drop tabs that no longer exist and re-find the group if the id went stale. */
	async reconcile(): Promise<void> {
		await this.refresh();
		const seen = this.state;
		const dead = new Set<number>();
		for (const id of seen.tabIds) if (!(await tabExists(id))) dead.add(id);
		const homeDead = seen.homeTabId !== undefined && !(await tabExists(seen.homeTabId));
		// A group belongs to exactly one session. (Re-finding a group by title used to hand a
		// fresh session another agent's group whenever their labels matched.)
		const table = await readTable();
		const claimedElsewhere =
			seen.groupId !== undefined && Object.values(table).some((s) => s.id !== seen.id && s.groupId === seen.groupId);
		const group = claimedElsewhere ? undefined : await this.liveGroup();
		const lostGroup = seen.groupId !== undefined && !group ? seen.groupId : undefined;
		// Chrome puts tabs opened from a grouped tab into that group; those are this agent's.
		const found: number[] = [];
		if (group) {
			for (const t of await chrome.tabs.query({ groupId: group.id }).catch(() => [] as chrome.tabs.Tab[])) {
				if (t.id !== undefined && !seen.tabIds.includes(t.id)) found.push(t.id);
			}
		}
		await this.update((s, stored) => {
			s.tabIds = s.tabIds.filter((id) => !dead.has(id));
			for (const id of found) if (!s.tabIds.includes(id) && !ownedElsewhere(stored, s.id, id)) s.tabIds.push(id);
			fixCurrent(s);
			if (homeDead && s.homeTabId === seen.homeTabId) s.homeTabId = undefined;
			if (lostGroup !== undefined && s.groupId === lostGroup) s.groupId = undefined;
		});
		// Tabs that fell out of the group (or never made it in) go back, so the user always sees
		// an agent's tabs together.
		for (const id of this.state.tabIds) {
			const tab = await tabExists(id);
			if (tab && (this.state.groupId === undefined || tab.groupId !== this.state.groupId)) await this.groupTab(id);
		}
	}

	private groupTitle(): string {
		return `${GROUP_PREFIX} · ${this.state.label}`;
	}

	/** Change the label; updates the tab group title. */
	async setLabel(label: string): Promise<void> {
		await this.update((s) => {
			s.label = label;
		});
		if (this.state.groupId !== undefined) {
			try {
				await chrome.tabGroups.update(this.state.groupId, { title: this.groupTitle() });
			} catch {
				/* group gone */
			}
		}
	}

	/** The session's group if it still exists. */
	private async liveGroup(): Promise<chrome.tabGroups.TabGroup | undefined> {
		if (this.state.groupId === undefined) return undefined;
		try {
			return await chrome.tabGroups.get(this.state.groupId);
		} catch {
			return undefined;
		}
	}

	/**
	 * Put a tab into the session group, creating the group in the tab's window. A tab in
	 * another window is moved next to the group first (a group cannot span windows). If the
	 * existing group refuses the tab, a fresh group is made rather than leaving it loose.
	 */
	private async groupTab(tabId: number): Promise<void> {
		try {
			let tab = await chrome.tabs.get(tabId);
			if (tab.pinned) return; // pinned tabs cannot be grouped
			const win = await chrome.windows.get(tab.windowId).catch(() => undefined);
			if (win && win.type !== "normal") return; // popups and app windows have no tab strip
			const group = await this.liveGroup();
			if (group && tab.groupId === group.id) return;
			if (group) {
				try {
					if (group.windowId !== tab.windowId) {
						await withGroupRetry(() => chrome.tabs.move(tabId, { windowId: group.windowId, index: -1 }));
						tab = await chrome.tabs.get(tabId);
					}
					await withGroupRetry(() => chrome.tabs.group({ tabIds: [tabId], groupId: group.id }));
					return;
				} catch (err) {
					console.warn("[BrowserSession] joining group failed, starting a new one:", err);
				}
			}
			if (tab.groupId !== undefined && tab.groupId !== -1) await chrome.tabs.ungroup(tabId).catch(() => undefined);
			const groupId = await withGroupRetry(() =>
				chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } }),
			);
			const windowId = tab.windowId;
			await this.update((s) => {
				s.groupId = groupId;
				s.windowId = windowId;
			});
			await chrome.tabGroups.update(groupId, { title: this.groupTitle(), color: this.state.color });
		} catch (err) {
			// A closing window or a tab being dragged must not fail the tool; the tab stays owned.
			console.warn("[BrowserSession] group failed:", err);
		}
	}

	/** Window for new tabs: the group's window when it exists, else the session window. */
	private async targetWindowId(): Promise<number> {
		const group = await this.liveGroup();
		if (group) return group.windowId;
		try {
			const win = await chrome.windows.get(this.state.windowId);
			if (win.type === "normal") return this.state.windowId;
		} catch {
			/* window gone */
		}
		const windowId = await lastFocusedWindowId();
		await this.update((s) => {
			s.windowId = windowId;
			return false;
		});
		return windowId;
	}

	/**
	 * Create a new inactive tab in the session's group and make it current. With a url the
	 * tab loads it directly (callers wait for the load); without one it starts blank.
	 */
	async createTab(url?: string): Promise<chrome.tabs.Tab> {
		const windowId = await this.targetWindowId();
		const tab = await chrome.tabs.create({ url: url ?? "about:blank", windowId, active: false });
		if (tab.id === undefined) throw new Error("Failed to create tab");
		await this.adopt(tab.id);
		return tab;
	}

	/** Take ownership of an existing tab (user handed it over, or a popup opened from an owned tab). */
	async adopt(tabId: number, makeCurrent = true): Promise<void> {
		await this.update((s, table) => {
			// A tab belongs to one session; take it away from whoever had it before.
			for (const other of Object.values(table)) {
				if (other.id === s.id || !other.tabIds.includes(tabId)) continue;
				other.tabIds = other.tabIds.filter((id) => id !== tabId);
				fixCurrent(other);
			}
			if (!s.tabIds.includes(tabId)) s.tabIds.push(tabId);
			if (makeCurrent) s.currentTabId = tabId;
		});
		await this.groupTab(tabId);
	}

	/** Swap a tab id Chrome replaced (prerender/instant pages commit into a new tab). */
	async replaceTabId(oldId: number, newId: number): Promise<void> {
		let replaced = false;
		await this.update((s) => {
			if (!s.tabIds.includes(oldId)) return false;
			s.tabIds = s.tabIds.map((id) => (id === oldId ? newId : id));
			if (s.currentTabId === oldId) s.currentTabId = newId;
			if (s.homeTabId === oldId) s.homeTabId = newId;
			replaced = true;
		});
		if (replaced) await this.groupTab(newId);
	}

	/** Release a tab without closing it. */
	async release(tabId: number): Promise<void> {
		await this.update((s) => {
			s.tabIds = s.tabIds.filter((id) => id !== tabId);
			fixCurrent(s);
		});
		await detachTab(tabId, true);
		try {
			await chrome.tabs.ungroup(tabId);
		} catch {
			/* tab gone */
		}
	}

	async closeTab(tabId: number): Promise<void> {
		await this.refresh();
		if (!this.state.tabIds.includes(tabId)) throw new Error(`Tab ${tabId} is not owned by this session`);
		await this.release(tabId);
		try {
			await chrome.tabs.remove(tabId);
		} catch {
			/* already closed */
		}
	}

	/** Make an owned tab the one tools act on. Does not focus anything. */
	async setCurrent(tabId: number): Promise<chrome.tabs.Tab> {
		await this.refresh();
		if (!this.state.tabIds.includes(tabId)) throw new Error(`Tab ${tabId} is not owned by this session`);
		const tab = await tabExists(tabId);
		if (!tab) {
			await this.reconcile();
			throw new Error(`Tab ${tabId} no longer exists`);
		}
		await this.update((s) => {
			if (s.tabIds.includes(tabId)) s.currentTabId = tabId;
		});
		return tab;
	}

	/** The tab tools act on, or undefined when the session has no tabs yet. */
	async currentTab(): Promise<chrome.tabs.Tab | undefined> {
		await this.refresh();
		if (this.state.currentTabId === undefined) return undefined;
		const tab = await tabExists(this.state.currentTabId);
		if (!tab) {
			await this.reconcile();
			return this.state.currentTabId === undefined ? undefined : await tabExists(this.state.currentTabId);
		}
		return tab;
	}

	/**
	 * Current tab for tools that need a page. An empty session does not get a blank tab
	 * conjured up (those piled up as empty tabs); the model is told to navigate first.
	 */
	async requireCurrentTab(): Promise<chrome.tabs.Tab> {
		const tab = await this.currentTab();
		if (tab) return tab;
		throw new NoTabError();
	}

	/** Current tab with the debugger attached, for CDP-based tools. */
	async attachedCurrentTab(): Promise<chrome.tabs.Tab> {
		const tab = await this.requireCurrentTab();
		if (tab.id === undefined) throw new Error("Tab has no id");
		if (tab.url && isRestrictedUrl(tab.url)) {
			throw new Error(
				`Cannot control ${tab.url}: browser-internal pages are protected. Navigate to a website first.`,
			);
		}
		await ensureAttached(tab.id);
		return tab;
	}

	/** Owned tabs with live titles and urls. */
	async tabs(): Promise<TabInfo[]> {
		await this.reconcile();
		const out: TabInfo[] = [];
		for (const id of this.state.tabIds) {
			const tab = await tabExists(id);
			if (!tab) continue;
			out.push({
				id,
				url: tab.url ?? tab.pendingUrl ?? "",
				title: tab.title ?? "",
				current: id === this.state.currentTabId,
				favicon: tab.favIconUrl,
				inGroup: this.state.groupId !== undefined && tab.groupId === this.state.groupId,
			});
		}
		return out;
	}

	/** The one focus-changing operation: bring an owned tab to the front for the user. */
	async show(tabId?: number): Promise<void> {
		const id = tabId ?? this.state.currentTabId;
		if (id === undefined) return;
		if (!this.state.tabIds.includes(id)) throw new Error(`Tab ${id} is not owned by this session`);
		const tab = await tabExists(id);
		if (!tab) return;
		await releaseAgentViewport(id);
		await chrome.tabs.update(id, { active: true });
		await chrome.windows.update(tab.windowId, { focused: true });
	}

	/** Detach debuggers but keep the record, so a reconnecting client re-adopts its tabs. */
	async suspend(): Promise<void> {
		for (const id of this.state.tabIds) await detachTab(id);
	}

	/** Detach debuggers and forget the session; tabs stay open for the user. */
	async close(): Promise<void> {
		for (const id of this.state.tabIds) await detachTab(id, true);
		await mutateTable(({ table }) => {
			delete table[this.state.id];
		});
		if (instances.get(this.state.id) === this) instances.delete(this.state.id);
	}
}

async function lastFocusedWindowId(): Promise<number> {
	try {
		const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
		if (win.id !== undefined) return win.id;
	} catch {
		/* no window */
	}
	const win = await chrome.windows.create({ url: "about:blank", focused: false, type: "normal" });
	if (win?.id === undefined) throw new Error("Failed to create a window");
	return win.id;
}
