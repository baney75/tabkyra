// The MCP server with no browser anywhere: every tool is listed with a usable
// description, the safety rules are in the instructions, and a tool call fails fast
// with the one not-connected message instead of hanging.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const NOT_CONNECTED =
	"Tabkyra isn't connected. Ask the user to open Helium/Chrome with the Tabkyra extension loaded, or run `tabkyra doctor`.";
let root;
let mcp;

before(async () => {
	root = mkdtempSync(join(tmpdir(), "tabkyra-mcp-"));
	mkdirSync(join(root, "home"));
	mkdirSync(join(root, "sock"), { mode: 0o700 });
	mcp = new Client({ name: "tabkyra-mcp-test", version: "0.0.0" });
	await mcp.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "mcp"],
			env: { HOME: join(root, "home"), PATH: dirname(process.execPath), TABKYRA_SOCKET_DIR: join(root, "sock") },
			stderr: "ignore",
		}),
	);
});

after(async () => {
	await mcp?.close().catch(() => {});
	rmSync(root, { recursive: true, force: true });
});

test("lists every tool with a description and documented parameters", async () => {
	const { tools } = await mcp.listTools();
	const names = tools.map((t) => t.name);
	for (const name of ["status", "tabs_context", "navigate", "read_page", "click", "type", "fill", "screenshot", "actions"]) {
		assert.ok(names.includes(name), `missing ${name}`);
	}
	for (const tool of tools) {
		assert.match(tool.name, /^[a-z]+(_[a-z]+)*$/, `${tool.name} is not snake_case`);
		assert.ok(tool.description && tool.description.length >= 40, `${tool.name} has a thin description`);
		for (const [param, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
			assert.ok(schema.description, `${tool.name}.${param} has no description`);
		}
		assert.match(tool.description, /Example:/, `${tool.name} shows no example`);
	}
});

test("instructions state the safety rules", () => {
	const instructions = mcp.getInstructions() ?? "";
	assert.match(instructions, /untrusted data/);
	assert.match(instructions, /Ask the user before you act under their sign-in/);
});

test("skill_match routes a task to one skill, or none, and skill_read returns that skill", async () => {
	assert.match(mcp.getInstructions() ?? "", /call skill_match with the user's task first/);
	const match = await mcp.callTool({ name: "skill_match", arguments: { task: "find peer-reviewed studies on sleep and memory" } });
	assert.notEqual(match.isError, true);
	const lines = match.content[0].text.split("\n");
	assert.match(lines[0], /^academic-research \([\d.]+\): \S/);
	assert.ok(lines.length <= 4, "top 3 plus the next step, nothing more");
	assert.equal(lines.at(-1), 'Next: skill_read {"name":"academic-research"}');
	const one = await mcp.callTool({ name: "skill_match", arguments: { task: "/rsi learn from this", top: 1 } });
	assert.equal(one.content[0].text.split("\n").length, 2);
	const none = await mcp.callTool({ name: "skill_match", arguments: { task: "write a haiku about autumn leaves" } });
	assert.match(none.content[0].text, /^none: /);
	const read = await mcp.callTool({ name: "skill_read", arguments: { name: "academic-research" } });
	assert.equal(read.content[0].text, readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "academic-research", "SKILL.md"), "utf8"));
	for (const name of ["../academic-research", "no-such-skill", "Academic-Research"]) {
		const bad = await mcp.callTool({ name: "skill_read", arguments: { name } });
		assert.equal(bad.isError, true, name);
	}
});

test("a tool call without a browser fails fast with the not-connected message", async () => {
	const started = Date.now();
	const result = await mcp.callTool({ name: "navigate", arguments: { url: "https://example.com" } });
	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, NOT_CONNECTED);
	assert.ok(Date.now() - started < 5000, "did not wait for a bridge that never existed");
});

test("status reports not connected without failing", async () => {
	const result = await mcp.callTool({ name: "status", arguments: {} });
	assert.ok(!result.isError);
	const body = JSON.parse(result.content[0].text);
	assert.equal(body.connected, false);
	assert.equal(body.message, NOT_CONNECTED);
});

test("a host with no extension behind it is reported as not connected, at once", async () => {
	// A fake native host: welcomes with extensionConnected:false, then drops any request.
	const dir = join(root, "fake-sock");
	mkdirSync(dir, { mode: 0o700 });
	const path = join(dir, `${process.pid}.sock`);
	const frame = (m) => {
		const body = Buffer.from(JSON.stringify(m));
		const head = Buffer.alloc(4);
		head.writeUInt32LE(body.length);
		return Buffer.concat([head, body]);
	};
	// Count frames, not "data" events: the hello and the first request can arrive in one chunk.
	const server = createServer((socket) => {
		let buffered = Buffer.alloc(0);
		let frames = 0;
		socket.on("data", (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
				buffered = buffered.subarray(4 + buffered.readUInt32LE(0));
				frames++;
				if (frames === 1) socket.write(frame({ type: "welcome", clientId: "c1", hostVersion: "0", extensionConnected: false }));
				else {
					socket.destroy();
					return;
				}
			}
		});
	});
	await new Promise((r) => server.listen(path, r));
	chmodSync(path, 0o600);
	const client = new Client({ name: "tabkyra-mcp-fake-host", version: "0.0.0" });
	try {
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [cli, "mcp"],
				env: { HOME: join(root, "home"), PATH: dirname(process.execPath), TABKYRA_SOCKET_DIR: dir },
				stderr: "ignore",
			}),
		);
		const started = Date.now();
		const nav = await client.callTool({ name: "navigate", arguments: { url: "https://example.com" } });
		assert.equal(nav.isError, true);
		assert.equal(nav.content[0].text, NOT_CONNECTED);
		const status = JSON.parse((await client.callTool({ name: "status", arguments: {} })).content[0].text);
		assert.equal(status.connected, false);
		assert.ok(Date.now() - started < 10000, `took ${Date.now() - started} ms; a bridge that never had the extension must not be waited for`);
	} finally {
		await client.close().catch(() => {});
		server.close();
	}
});
