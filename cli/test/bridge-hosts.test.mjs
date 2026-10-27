// Several native hosts at once (two browsers, or a stale host): a request is resent only to the
// browser it started in, and a reconnect doesn't wait on a host whose extension never answers.
// Each fake host's socket is named after a live process (a sleeping child), as real ones are.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "tabkyra-hosts-"));
const dir = join(root, "sock");
mkdirSync(dir, { mode: 0o700 });
const sleepers = [];
/** Every fake host, stopped after each test however it ends. */
const hosts = [];
let BridgeClient;

const frame = (m) => {
	const body = Buffer.from(JSON.stringify(m));
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length);
	return Buffer.concat([head, body]);
};

/** A fake native host: welcomes, answers requests, counts what it got. */
async function host({ browserId, extension = true, dropFirst = [] }) {
	const sleeper = spawn("sleep", ["600"], { stdio: "ignore" });
	sleepers.push(sleeper);
	const path = join(dir, `${sleeper.pid}.sock`);
	const got = [];
	const drop = new Set(dropFirst);
	const sockets = new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let buf = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
				const msg = JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString());
				buf = buf.subarray(4 + buf.readUInt32LE(0));
				if (msg.type === "hello") {
					socket.write(frame({ type: "welcome", clientId: "c", hostVersion: "0", extensionConnected: extension, ...(extension && browserId ? { browserId } : {}) }));
					continue;
				}
				got.push(msg.method);
				if (drop.delete(msg.method)) {
					// Cut off, and gone: the socket file and process vanish with it (a reload).
					void h.stop();
					return;
				}
				socket.write(frame({ type: "response", id: msg.id, result: { from: browserId } }));
			}
		});
	});
	await new Promise((r) => server.listen(path, r));
	chmodSync(path, 0o600);
	const h = {
		got,
		/** The host goes away: its socket file and process vanish, as when a browser's extension reloads. */
		async stop() {
			for (const s of sockets) s.destroy();
			if (server.listening) await new Promise((r) => server.close(r));
			sleeper.kill();
		},
	};
	hosts.push(h);
	return h;
}

before(async () => {
	const { build } = await import("esbuild");
	const out = join(root, "client.mjs");
	await build({ entryPoints: [join(here, "..", "src", "client.ts")], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent" });
	({ BridgeClient } = await import(out));
	process.env.TABKYRA_SOCKET_DIR = dir;
	process.env.TABKYRA_RECONNECT_BUDGET_MS = "6000";
});

afterEach(async () => {
	for (const h of hosts.splice(0)) await h.stop().catch(() => {});
});

after(() => {
	for (const s of sleepers) s.kill();
	rmSync(root, { recursive: true, force: true });
});

test("a read cut off in browser A is resent to A when it comes back, never to browser B", async () => {
	const a = await host({ browserId: "browser-a", dropFirst: ["text"] });
	const client = new BridgeClient({ name: "pin", session: "pin" });
	try {
		assert.deepEqual(await client.call("tabs.context"), { from: "browser-a" });
		// Browser B's host appears; then A's extension reloads under a read.
		const b = await host({ browserId: "browser-b" });
		const reading = client.call("text");
		await new Promise((r) => setTimeout(r, 800));
		const a2 = await host({ browserId: "browser-a" });
		assert.deepEqual(await reading, { from: "browser-a" });
		assert.deepEqual(b.got, [], "the read went to the other browser");
		assert.deepEqual(a2.got, ["text"]);
	} finally {
		client.close();
	}
});

test("a reconnect stuck on a host whose extension never answers moves to the host that comes up", async () => {
	const stale = await host({ extension: false });
	const live = await host({ browserId: "browser-c", dropFirst: ["html"] });
	const client = new BridgeClient({ name: "stale", session: "stale" });
	try {
		assert.deepEqual(await client.call("tabs.context"), { from: "browser-c" });
		// The live host drops a read and goes away; only the stale host is left for a while.
		const reading = client.call("html");
		await new Promise((r) => setTimeout(r, 1500));
		const back = await host({ browserId: "browser-c" });
		const started = Date.now();
		assert.deepEqual(await reading, { from: "browser-c" });
		assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms after the host came back`);
		assert.deepEqual(back.got, ["html"]);
	} finally {
		client.close();
	}
});
