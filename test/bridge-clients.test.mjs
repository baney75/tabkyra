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
	return { fake, port, request, settle, connect, disconnect };
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
