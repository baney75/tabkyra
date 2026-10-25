// Private mode lets the side panel agent reach only zero-data-retention OpenRouter routes and
// models on the user's own machine or network. Bug reports are off by default, redact what
// could identify the user or leak a key, and are only ever sent by the user.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addEntry, issueUrl, redact } from "../src/privacy/bug-reports.ts";
import { isLocalBaseUrl, OPENROUTER_PRIVATE_ROUTING, PrivateModeError, privateModel } from "../src/privacy/private-mode.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

test("OpenRouter gets zero-data-retention routing, keeping any provider order", () => {
	const m = privateModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", compat: { openRouterRouting: { order: ["anthropic"] } } });
	assert.deepEqual(m.compat.openRouterRouting, { order: ["anthropic"], zdr: true, data_collection: "deny", allow_fallbacks: false });
	assert.deepEqual(OPENROUTER_PRIVATE_ROUTING, { zdr: true, data_collection: "deny", allow_fallbacks: false });
});

test("a model that only claims to be OpenRouter is refused", () => {
	assert.throws(() => privateModel({ provider: "openrouter", baseUrl: "https://openrouter.ai.evil.example.com/v1" }), PrivateModeError);
	assert.throws(() => privateModel({ provider: "custom", baseUrl: "https://openrouter.ai/api/v1" }), PrivateModeError);
});

test("hosted providers are refused; local and tailnet models pass unchanged", () => {
	for (const [provider, baseUrl] of [
		["anthropic", "https://api.anthropic.com"],
		["openai", "https://api.openai.com/v1"],
		["google", "https://generativelanguage.googleapis.com"],
		["custom", "https://my-vps.example.com/v1"],
		["custom", "http://8.8.8.8:11434/v1"],
	]) {
		assert.throws(() => privateModel({ provider, baseUrl }), PrivateModeError, `${provider} ${baseUrl}`);
	}
	for (const baseUrl of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080", "http://192.168.1.20:8000", "http://10.0.0.5/v1", "http://172.20.1.1/v1", "http://100.101.102.103:11434", "https://gpu.tail1234.ts.net/v1", "http://studio.local:1234"]) {
		assert.ok(isLocalBaseUrl(baseUrl), baseUrl);
		const m = { provider: "custom", baseUrl };
		assert.equal(privateModel(m), m);
	}
	for (const baseUrl of ["http://172.32.0.1", "http://100.128.0.1", "http://192.169.0.1", "not a url"]) assert.equal(isLocalBaseUrl(baseUrl), false, baseUrl);
});

test("bug reports redact query strings, emails, keys and home paths", () => {
	const text = redact(
		"Failed https://mail.example.com/inbox?token=abc123&u=ada for ada@example.com with sk-ant-api03-ABCDEFGHIJKLMNOP at /Users/donovan/project and C:\\Users\\ada\\x",
	);
	assert.doesNotMatch(text, /token=|ada@example|sk-ant|donovan|\\ada\\/);
	assert.match(text, /https:\/\/mail\.example\.com\/inbox\?\[redacted\]/);
	const log = Array.from({ length: 30 }, (_, i) => i).reduce((l, i) => addEntry(l, new Error(`e${i}`)), []);
	assert.equal(log.length, 20, "the log is a short ring buffer");
	const url = new URL(issueUrl("1.2.3", log, "Mozilla/5.0"));
	assert.equal(url.origin + url.pathname, "https://github.com/baney75/tabkyra/issues/new");
	assert.match(url.searchParams.get("body"), /e29/);
});

test("bug reports are off by default and the UI sends nothing on its own", () => {
	const capture = readFileSync(join(repo, "src", "privacy", "capture.ts"), "utf8");
	assert.match(capture, /!== true\) return/, "capture records only when the setting is exactly true");
	for (const file of ["src/privacy/capture.ts", "src/privacy/bug-reports.ts", "src/dialogs/PrivacyTab.ts"]) {
		assert.doesNotMatch(readFileSync(join(repo, file), "utf8"), /\bfetch\(|sendBeacon|XMLHttpRequest/, `${file} sends data`);
	}
	const welcome = readFileSync(join(repo, "src", "dialogs", "WelcomeSetupDialog.ts"), "utf8");
	assert.doesNotMatch(welcome, /type="checkbox"[^>]*checked/, "the welcome checkbox starts unchecked");
});

test("the stream gate applies private mode to every side panel request", () => {
	const sidepanel = readFileSync(join(repo, "src", "sidepanel.ts"), "utf8");
	assert.match(sidepanel, /if \(await storage\.settings\.get<boolean>\(PRIVATE_MODE_KEY\)\) model = privateModel\(model\);/);
	assert.equal((sidepanel.match(/new PrivacyTab\(\)/g) ?? []).length, 2, "both settings entry points show the Privacy tab");
});
