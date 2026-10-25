// `tabkyra setup` and `tabkyra doctor` against a throwaway HOME, an empty socket
// directory and a PATH holding only node plus fake harness CLIs. Nothing here can
// reach a real browser, bridge or harness config.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist-chrome");
let root;
let home;
let bin;
let socketDir;
let harnessLog;

const helium = () =>
	process.platform === "darwin"
		? join(home, "Library", "Application Support", "net.imput.helium")
		: join(home, ".config", "net.imput.helium");

/** A fake `claude` or `codex`: `mcp get` fails (not configured), everything is logged. */
function fakeHarness(name) {
	const file = join(bin, name);
	writeFileSync(
		file,
		`#!/bin/sh\necho "${name} $*" >> "${harnessLog}"\nif [ "$2" = "get" ]; then exit 1; fi\nexit 0\n`,
	);
	chmodSync(file, 0o755);
}

function run(args, extraEnv = {}) {
	const result = spawnSync(process.execPath, [cli, ...args], {
		encoding: "utf8",
		env: {
			HOME: home,
			PATH: `${bin}:${dirname(process.execPath)}`,
			TABKYRA_SOCKET_DIR: socketDir,
			TERM: "xterm-256color",
			...extraEnv,
		},
		input: "",
	});
	return { code: result.status, out: result.stdout + result.stderr };
}

before(() => {
	root = mkdtempSync(join(tmpdir(), "tabkyra-setup-"));
	home = join(root, "home");
	bin = join(root, "bin");
	socketDir = join(root, "sock");
	harnessLog = join(root, "harness.log");
	mkdirSync(home);
	mkdirSync(bin);
	mkdirSync(socketDir, { mode: 0o700 });
	mkdirSync(helium(), { recursive: true });
	writeFileSync(harnessLog, "");
});
after(() => rmSync(root, { recursive: true, force: true }));

test("doctor fails with one fix per problem on a fresh machine", () => {
	const { code, out } = run(["doctor", "--json"]);
	assert.equal(code, 1);
	const report = JSON.parse(out);
	assert.equal(report.ok, false);
	const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
	assert.equal(byId.node.status, "ok");
	assert.equal(byId["host:Helium"].status, "fail");
	assert.equal(byId["host:Helium"].fix, "tabkyra install --force");
	assert.equal(byId.connected.status, "fail");
	for (const check of report.checks) if (check.status === "fail") assert.ok(check.fix, `${check.id} has no fix`);
});

test("setup --yes registers the host, prints the load step and wires harnesses by absolute path", { skip: !existsSync(join(extensionDir, "manifest.json")) && "needs dist-chrome" }, () => {
	fakeHarness("claude");
	fakeHarness("codex");
	const { code, out } = run(["setup", "--yes", "--no-wait"]);
	// Not connected (no browser), so setup reports "almost there" and exits 1.
	assert.equal(code, 1, out);
	assert.match(out, /Helium\s+registered/);
	assert.match(out, /Load unpacked/);
	assert.ok(out.includes(extensionDir), "prints the exact extension folder");
	assert.match(out, /Allow user scripts/);

	const calls = readFileSync(harnessLog, "utf8");
	const self = cli;
	assert.ok(calls.includes(`claude mcp add --scope user tabkyra -- ${self} mcp`), calls);
	assert.ok(calls.includes(`codex mcp add tabkyra -- ${self} mcp`), calls);

	const doctor = JSON.parse(run(["doctor", "--json"]).out);
	assert.equal(doctor.checks.find((c) => c.id === "host:Helium").status, "ok");
});

test("setup without --yes and without a terminal never edits a harness config", () => {
	writeFileSync(harnessLog, "");
	fakeHarness("claude");
	run(["setup", "--no-wait"]);
	const calls = readFileSync(harnessLog, "utf8");
	assert.ok(calls.includes("claude mcp get tabkyra"), calls);
	assert.ok(!calls.includes("mcp add"), calls);
});

test("color only when asked for, and NO_COLOR wins", () => {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
	const ansi = /\x1b\[/;
	assert.doesNotMatch(run(["doctor"]).out, ansi, "a pipe gets no color");
	assert.match(run(["doctor"], { FORCE_COLOR: "1" }).out, ansi);
	assert.doesNotMatch(run(["doctor"], { FORCE_COLOR: "1", NO_COLOR: "1" }).out, ansi);
});
