// The command line itself: one version, help and completions generated from one command
// table, --json on the read commands, and the documented exit codes.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const repo = join(here, "..", "..");
const home = mkdtempSync(join(tmpdir(), "tabkyra-cli-"));
const socketDir = join(home, "sock");
mkdirSync(socketDir, { mode: 0o700 });
after(() => rmSync(home, { recursive: true, force: true }));

function run(...args) {
	const env = { ...process.env, HOME: home, TABKYRA_SOCKET_DIR: socketDir, NO_COLOR: "1" };
	delete env.XDG_CONFIG_HOME;
	// A command that ignores an unknown flag could start serving; the timeout turns that into a failure.
	const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 20000 });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

const manifestVersion = JSON.parse(readFileSync(join(repo, "static", "manifest.chrome.json"), "utf8")).version;

test("the CLI's version is the extension manifest's", () => {
	assert.equal(run("--version").out.trim(), manifestVersion);
	assert.equal(run("version").out.trim(), manifestVersion);
	const json = JSON.parse(run("version", "--json").out);
	assert.equal(json.version, manifestVersion);
	assert.match(json.builtAt, /^\d{4}-/);
	// The MCP server and the doctor report the same number.
	assert.match(run("doctor", "--json").out, new RegExp(`"version": "${manifestVersion.replaceAll(".", "\\.")}"`));
});

test("help lists every command the CLI dispatches, grouped, with the exit codes", () => {
	const help = run("--help").out;
	for (const name of ["setup", "status", "mcp", "skill", "serve", "token", "tunnel", "library", "allow", "ask", "allow-all", "doctor", "update", "install", "reload", "debug", "completion", "version"]) {
		assert.match(help, new RegExp(`tabkyra ${name}\\b`), `help lacks ${name}`);
		// A listed command is one the dispatcher knows: it never says "Unknown command".
		const r = run(name, "--definitely-not-a-flag");
		assert.doesNotMatch(r.err, /Unknown command/, name);
		// ...and an unknown flag is a usage error, never ignored (serve used to start serving).
		assert.equal(r.code, 2, `${name} --definitely-not-a-flag exited ${r.code}: ${r.err}`);
	}
	for (const group of ["Get started", "Agents", "Remote", "Library", "Sites", "Troubleshoot"]) assert.match(help, new RegExp(`\\n${group}\\n`));
	assert.match(help, /Exit codes: 0 success, 1 failed or not connected, 2 usage error\./);
	const unknown = run("frobnicate");
	assert.equal(unknown.code, 2);
	assert.match(unknown.err, /Unknown command "frobnicate"/);
});

test("completions parse in each shell and complete commands, subcommands and flags", () => {
	const zsh = run("completion", "zsh");
	assert.equal(zsh.code, 0);
	assert.match(zsh.out, /^#compdef tabkyra/);
	assert.match(zsh.out, /'completion:/);
	const bash = run("completion", "bash").out;
	const fish = run("completion", "fish").out;
	assert.match(fish, /complete -c tabkyra -n __fish_use_subcommand -a status/);
	assert.match(fish, /__fish_seen_subcommand_from skill' -a lint/);
	const file = join(home, "tk.bash");
	execFileSync("sh", ["-c", 'cat > "$1"', "sh", file], { input: bash });
	const complete = (words) =>
		execFileSync("bash", ["-c", `source "${file}"; COMP_WORDS=(${words}); COMP_CWORD=$((\${#COMP_WORDS[@]} - 1)); _tabkyra; echo "\${COMPREPLY[@]}"`], { encoding: "utf8" }).trim();
	assert.equal(complete("tabkyra sta"), "status");
	assert.equal(complete("tabkyra skill li").split(" ").sort().join(" "), "lint list");
	assert.equal(complete("tabkyra doctor --j"), "--json");
	if (spawnSync("zsh", ["--version"]).status === 0) assert.equal(spawnSync("zsh", ["-n"], { input: zsh.out }).status, 0, "zsh script has a syntax error");
	// Hidden aliases stay out.
	assert.doesNotMatch(bash, /\byolo\b/);
	const bad = run("completion", "powershell");
	assert.equal(bad.code, 2);
	assert.match(bad.err, /tabkyra completion zsh\|bash\|fish/);
});

test("read commands print JSON with --json, and exit 1 when not connected", () => {
	const status = run("status", "--json");
	assert.equal(status.code, 1);
	assert.equal(JSON.parse(status.out).connected, false);
	assert.deepEqual(JSON.parse(run("token", "list", "--json").out), []);
	assert.ok(Array.isArray(Object.keys(JSON.parse(run("token", "scopes", "--json").out))));
	assert.deepEqual(JSON.parse(run("library", "list", "--json").out), []);
	const search = run("library", "search", "nothing", "--json");
	assert.deepEqual(JSON.parse(search.out), []);
	assert.equal(search.code, 1, "no match exits 1");
	assert.ok(Array.isArray(JSON.parse(run("skill", "list", "--json").out)));
});

test("the launcher harnesses run turns on Node's compile cache without overriding the user's", () => {
	run("install");
	const launcher = join(home, ".config", "tabkyra", "tabkyra");
	const text = readFileSync(launcher, "utf8");
	assert.match(text, /: "\$\{NODE_COMPILE_CACHE:=.*node-compile-cache\}"\nexport NODE_COMPILE_CACHE\nexec /);
	assert.ok(statSync(launcher).mode & 0o100);
	const out = execFileSync(launcher, ["--version"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
	assert.equal(out.trim(), manifestVersion);
});
