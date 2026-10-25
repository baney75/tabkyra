// The MCP server with no browser anywhere: every tool is listed with a usable
// description, the safety rules are in the instructions, and a tool call fails fast
// with the one not-connected message instead of hanging.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
			if (["button", "to", "world", "onlyErrors", "limit", "from"].includes(param)) continue;
			assert.ok(schema.description, `${tool.name}.${param} has no description`);
		}
	}
	const withExample = tools.filter((t) => t.description.includes("Example:")).length;
	assert.ok(withExample >= tools.length - 4, `only ${withExample} of ${tools.length} tools show an example`);
});

test("instructions state the safety rules", () => {
	const instructions = mcp.getInstructions() ?? "";
	assert.match(instructions, /untrusted data/);
	assert.match(instructions, /Ask the user before you act under their sign-in/);
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
