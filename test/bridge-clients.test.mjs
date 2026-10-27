// The bridge in the service worker keeps one BrowserSession per harness session key. When Claude
// Code restarts its MCP server, the new process connects with the same session id before the old
// socket closes; the old client's disconnect must not suspend or forget the session the new
// client is using.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

async function startBridge() {
	const fake = installFakeChrome();
	const native = await import(`../src/bridge/native.ts?ctx=${Math.random()}`);
	// startBridge schedules a prune 20 s out; don't let that timer hold the test process open.
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (fn, ms, ...args) => {
		const t = realSetTimeout(fn, ms, ...args);
		if (ms >= 10000) t.unref();
		return t;
	};
	try {
		native.startBridge();
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
	const port = fake.ports[0];
	let nextId = 1;
	const request = async (clientId, method, params = {}) => {
		const id = nextId++;
		port.deliver({ type: "request", clientId, id, method, params });
		for (let i = 0; i < 500; i++) {
			const reply = port.sent.find((m) => m.type === "response" && m.clientId === clientId && m.id === id);
			if (reply) return reply;
			await new Promise((r) => realSetTimeout(r, 5));
		}
		throw new Error(`no reply to ${method}`);
	};
	const settle = () => new Promise((r) => realSetTimeout(r, 100));
	const connect = (clientId, session) =>
		port.deliver({ type: "client_connected", clientId, client: { name: "claude", session } });
	const disconnect = (clientId) => port.deliver({ type: "client_disconnected", clientId });
	return { fake, port, request, settle, connect, disconnect, native };
}

test("an old client hanging up leaves the session its successor shares untouched", async () => {
	const { fake, request, settle, connect, disconnect } = await startBridge();
	connect("c1", "abc");
	const created = await request("c1", "tabs.create");
	assert.equal(created.error, undefined, JSON.stringify(created.error));
	const tabId = created.result.tabId;
	// The restarted MCP server connects first; the old socket closes after.
	connect("c2", "abc");
	await request("c2", "tabs.context");
	fake.detachCalls.length = 0;
	disconnect("c1");
	await settle();
	assert.deepEqual(fake.detachCalls, [], "the shared session's tabs were suspended under the live client");
	// The last client leaving still suspends.
	disconnect("c2");
	await settle();
	assert.ok(fake.detachCalls.includes(tabId), "the session is suspended once nobody uses it");
	assert.ok(fake.table()["bridge-claude-abc"], "a suspended session keeps its record");
});

test("an old client hanging up does not forget a tabless session its successor shares", async () => {
	const { fake, request, settle, connect, disconnect } = await startBridge();
	connect("c1", "xyz");
	await request("c1", "tabs.context");
	connect("c2", "xyz");
	disconnect("c1");
	await settle();
	assert.ok(fake.table()["bridge-claude-xyz"], "the shared session was closed under the live client");
	disconnect("c2");
	await settle();
	assert.equal(fake.table()["bridge-claude-xyz"], undefined, "a tabless session is dropped once nobody uses it");
});

test("a result too big for the native port fails that request with a clear error", async () => {
	const { request, connect } = await startBridge();
	connect("c1", "big");
	const created = await request("c1", "tabs.create");
	await chrome.tabs.update(created.result.tabId, { title: "x".repeat(61 * 1024 * 1024) });
	const reply = await request("c1", "tabs.context");
	assert.equal(reply.result, undefined, "the oversized result was sent anyway");
	assert.match(reply.error?.message ?? "", /too large|exceeds/i);
});

test("a host that exits before saying anything is retried with growing backoff", async () => {
	const { fake } = await startBridge();
	const portCount = async (n) => {
		for (let i = 0; i < 400 && fake.ports.length < n; i++) await new Promise((r) => setTimeout(r, 10));
		assert.equal(fake.ports.length, n, `port ${n} opened`);
		return Date.now();
	};
	const drop = (port) => {
		for (const fn of port.onDisconnect.listeners) fn();
	};
	drop(fake.ports[0]);
	const t1 = await portCount(2);
	drop(fake.ports[1]);
	const t2 = await portCount(3);
	assert.ok(t2 - t1 >= 1800, `second retry came after ${t2 - t1} ms; the backoff was reset by a silent host`);
	// A host that answers resets it.
	fake.ports[2].deliver({ type: "ping" });
	drop(fake.ports[2]);
	const t3 = Date.now();
	const t4 = await portCount(4);
	assert.ok(t4 - t3 < 1500, `retry after a talking host took ${t4 - t3} ms`);
	drop(fake.ports[3]);
});

test("when the native host goes away mid-request, the running handler sends no more input", async () => {
	const { fake, port, request, connect } = await startBridge();
	// The CDP input path listens for navigations; the shared fake leaves that event out.
	chrome.webNavigation.onCommitted ??= { listeners: [], addListener() {}, removeListener() {} };
	connect("c1", "abort");
	const created = await request("c1", "tabs.create");
	assert.equal(created.error, undefined, JSON.stringify(created.error));
	// A real page: browser-internal ones (about:blank) refuse input before any key.
	await chrome.tabs.update(created.result.tabId, { url: "https://example.com/" });
	const keys = [];
	const send = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		if (method === "Input.dispatchKeyEvent" && params?.type !== "keyUp") keys.push(params?.key);
		return send(target, method, params);
	};
	// With the host there, the batch does press its key (so the test can see one).
	await request("c1", "actions", { steps: [{ wait: 50 }, { press: "b" }] });
	assert.deepEqual(keys, ["b"]);
	keys.length = 0;
	// An input batch: a pause, then a keypress the agent may repeat after the host answered
	// "interrupted: it may have run".
	port.deliver({ type: "request", clientId: "c1", id: 900, method: "actions", params: { steps: [{ wait: 300 }, { press: "a" }] } });
	await new Promise((r) => setTimeout(r, 100));
	for (const fn of port.onDisconnect.listeners) fn();
	await new Promise((r) => setTimeout(r, 700));
	assert.deepEqual(keys, [], "the cut-off request kept typing after its host was gone");
	assert.ok(fake.ports.length >= 1);
});

/** Count key-downs the CDP input path sends from now on. */
function watchKeys() {
	// The CDP input path listens for navigations; the shared fake leaves that event out.
	chrome.webNavigation.onCommitted ??= { listeners: [], addListener() {}, removeListener() {} };
	const keys = [];
	const send = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		if (method === "Input.dispatchKeyEvent" && params?.type !== "keyUp") keys.push(params?.key);
		return send(target, method, params);
	};
	return keys;
}

async function pageTab(request, clientId) {
	const created = await request(clientId, "tabs.create");
	await chrome.tabs.update(created.result.tabId, { url: "https://example.com/" });
}

test("requests queued behind the one the host's loss cut off never start", async () => {
	const { port, request, connect } = await startBridge();
	connect("c1", "queued");
	await pageTab(request, "c1");
	const keys = watchKeys();
	port.deliver({ type: "request", clientId: "c1", id: 901, method: "actions", params: { steps: [{ wait: 300 }, { press: "a" }] } });
	port.deliver({ type: "request", clientId: "c1", id: 902, method: "press", params: { key: "b" } });
	await new Promise((r) => setTimeout(r, 100));
	for (const fn of port.onDisconnect.listeners) fn();
	await new Promise((r) => setTimeout(r, 700));
	assert.deepEqual(keys, [], "a request the host already answered as interrupted ran anyway");
});

test("a request whose host goes away before its handler starts never starts", async () => {
	const { port, request, connect, native } = await startBridge();
	connect("c1", "preamble");
	await pageTab(request, "c1");
	const before = (await chrome.tabs.query({})).length;
	// Hold a tabs.create (a handler with no abort checks of its own) in its preamble, the update
	// gate; drop the host; then let it go on.
	let open;
	native.setGateReady(new Promise((r) => (open = r)));
	port.deliver({ type: "request", clientId: "c1", id: 903, method: "tabs.create", params: {} });
	await new Promise((r) => setTimeout(r, 50));
	for (const fn of port.onDisconnect.listeners) fn();
	open();
	await new Promise((r) => setTimeout(r, 300));
	assert.equal((await chrome.tabs.query({})).length, before, "the cut-off tabs.create opened a tab");
	native.setGateReady(Promise.resolve());
});

test("a request refused during an update install is not_sent, so the client resends it later", async () => {
	const { request, connect, native } = await startBridge();
	connect("c1", "install");
	native.setInstallGate(() => true);
	try {
		const r = await request("c1", "tabs.context");
		assert.equal(r.error?.code, "not_sent");
		assert.match(r.error.message, /did not run/);
	} finally {
		native.setInstallGate(() => false);
	}
});
