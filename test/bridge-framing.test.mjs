// Native-messaging framing between the extension, the host and the CLI. One bad frame must not
// make a stream deaf: the parser keeps the good frames around it, and the host restarts (exits,
// so Chrome and the extension reconnect) instead of ignoring the extension from then on.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { encodeFrame, FrameParser } from "../cli/src/framing.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

// The CLI's bundler inlines the release key (a .pub text import); do the same for the source run.
const PUB_LOADER = `import { readFileSync } from "node:fs";
export async function load(url, context, next) {
	if (!url.endsWith(".pub")) return next(url, context);
	return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(readFileSync(new URL(url), "utf8")) };
}`;
const HOST_ENTRY = `import { register } from "node:module";
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(PUB_LOADER)}`)});
const { runNativeHost } = await import("./cli/src/host.ts");
runNativeHost();`;

function header(length) {
	const h = Buffer.alloc(4);
	h.writeUInt32LE(length, 0);
	return h;
}

/** Push and collect, whichever way the parser reports a bad frame. */
function push(parser, chunk) {
	try {
		const r = parser.push(chunk);
		return Array.isArray(r) ? { messages: r } : r;
	} catch (err) {
		return { messages: [], error: err, threw: true };
	}
}

test("after an oversized frame, later frames still parse", () => {
	const p = new FrameParser(1024);
	const first = push(p, Buffer.concat([header(5000), Buffer.alloc(3000)]));
	assert.ok(first.error, "oversized frame is reported");
	const second = push(p, Buffer.concat([Buffer.alloc(2000), encodeFrame({ type: "pong" })]));
	assert.deepEqual(second.messages, [{ type: "pong" }]);
	assert.equal(second.error, undefined);
});

test("a malformed frame keeps the good frames before and after it in the same chunk", () => {
	const p = new FrameParser(1024);
	const bad = Buffer.from("{nope");
	const r = push(
		p,
		Buffer.concat([encodeFrame({ type: "response", id: 1 }), header(bad.length), bad, encodeFrame({ type: "pong" })]),
	);
	assert.ok(r.error, "bad frame is reported");
	assert.deepEqual(r.messages, [{ type: "response", id: 1 }, { type: "pong" }]);
});

test("frames split across chunks are reassembled", () => {
	const p = new FrameParser(1024);
	const frame = encodeFrame({ type: "event", data: "x".repeat(100) });
	assert.deepEqual(push(p, frame.subarray(0, 3)).messages, []);
	assert.deepEqual(push(p, frame.subarray(3, 50)).messages, []);
	assert.deepEqual(push(p, frame.subarray(50)).messages, [{ type: "event", data: "x".repeat(100) }]);
});

test("the native host exits on a bad frame from the extension instead of going deaf", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tabkyra-host-"));
	const host = spawn(
		process.execPath,
		["--import", "tsx", "--input-type=module", "-e", HOST_ENTRY],
		{ cwd: repo, env: { ...process.env, TABKYRA_SOCKET_DIR: join(dir, "s") }, stdio: ["pipe", "pipe", "pipe"] },
	);
	const exited = new Promise((r) => host.once("exit", (c) => r(c)));
	const within = (ms) => Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), ms))]);
	try {
		// Up and listening first, so an exit below is the bad frame's doing.
		const sock = join(dir, "s", `${host.pid}.sock`);
		for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
		assert.ok(existsSync(sock), "host started and opened its socket");
		assert.equal(await within(200), "still running");
		host.stdin.write(header(61 * 1024 * 1024));
		const code = await within(5000);
		assert.notEqual(code, "still running", "host kept running after the bad frame");
		assert.notEqual(code, 0, "host exits with an error code");
	} finally {
		host.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("on a bad extension frame the host answers waiting requests with a non-retried error, then exits", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tabkyra-host-"));
	const host = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", HOST_ENTRY], {
		cwd: repo,
		env: { ...process.env, TABKYRA_SOCKET_DIR: join(dir, "s") },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const exited = new Promise((r) => host.once("exit", (c) => r(c)));
	const toExt = new FrameParser(64 * 1024 * 1024);
	const forwarded = [];
	host.stdout.on("data", (chunk) => forwarded.push(...toExt.push(chunk).messages));
	try {
		const sock = join(dir, "s", `${host.pid}.sock`);
		for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
		const client = connect({ path: sock, allowHalfOpen: true });
		const late = client;
		const fromHost = new FrameParser(64 * 1024 * 1024);
		const received = [];
		client.on("data", (chunk) => received.push(...fromHost.push(chunk).messages));
		client.on("error", () => undefined);
		client.write(encodeFrame({ type: "hello", client: { name: "t", session: "s" } }));
		client.write(encodeFrame({ type: "request", id: 1, method: "tabs.create", params: {} }));
		client.write(encodeFrame({ type: "request", id: 2, method: "click", params: {} }));
		const wait = async (fn, what) => {
			for (let i = 0; i < 100; i++) {
				const v = fn();
				if (v) return v;
				await new Promise((r) => setTimeout(r, 20));
			}
			throw new Error(`timed out waiting for ${what}`);
		};
		const reqs = await wait(() => {
			const r = forwarded.filter((m) => m.type === "request");
			return r.length === 2 ? r : undefined;
		}, "both requests forwarded");
		const clientId = reqs[0].clientId;
		// One good reply, then a frame the host can't read: the reply to request 2 is lost.
		host.stdin.write(Buffer.concat([encodeFrame({ type: "response", clientId, id: 1, result: { tabId: 7 } }), header(61 * 1024 * 1024)]));
		await wait(() => received.some((m) => m.id === 2), "the lost request's answer");
		const responses = received.filter((m) => m.type === "response");
		assert.deepEqual(
			responses.find((m) => m.id === 1),
			{ type: "response", id: 1, result: { tabId: 7 } },
			"the good reply reached the client",
		);
		const lost = responses.find((m) => m.id === 2);
		assert.ok(lost?.error, `request 2 got an RPC error, not just a closed socket: ${JSON.stringify(responses)}`);
		assert.match(lost.error.message, /may have run/);
		// A request that reaches the host after that is never forwarded (it could only be lost).
		late.write(encodeFrame({ type: "request", id: 3, method: "click", params: {} }));
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(forwarded.filter((m) => m.type === "request" && m.id === 3).length, 0, "request 3 was forwarded");
		assert.notEqual(await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 5000))]), "still running");
	} finally {
		host.kill();
		rmSync(dir, { recursive: true, force: true });
	}
});
