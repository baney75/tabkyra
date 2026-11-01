import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const root = mkdtempSync(join(tmpdir(), "tabkyra-hub-"));
const env = { HOME: join(root, "home"), PATH: dirname(process.execPath), NO_COLOR: "1", TABKYRA_SOCKET_DIR: join(root, "sock") };
mkdirSync(env.HOME, { recursive: true });
mkdirSync(env.TABKYRA_SOCKET_DIR, { mode: 0o700 });

function run(args, extra = {}) {
	const r = spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("hub token scopes are browser.read and browser.navigate only", () => {
	const r = run(["hub", "token", "--name", "hub1"]);
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /browser\.read, browser\.navigate/);
	assert.match(r.out, /tkr_/);
	const listed = run(["token", "list", "--json"]);
	assert.equal(listed.code, 0, listed.out);
	const tokens = JSON.parse(listed.out);
	const hub = (Array.isArray(tokens) ? tokens : tokens.tokens).find((t) => t.name === "hub1");
	assert.ok(hub);
	assert.deepEqual(hub.scopes.sort(), ["browser.navigate", "browser.read"]);
});

test("hub tunnel keeps Funnel off (no --public path)", () => {
	const bin = join(root, "bin");
	mkdirSync(bin);
	// no tailscale on PATH
	const r = run(["hub", "tunnel"], { PATH: bin });
	assert.equal(r.code, 1);
	assert.match(r.out, /Tailscale isn't installed/);
	assert.doesNotMatch(r.out, /funnel/i);
});
