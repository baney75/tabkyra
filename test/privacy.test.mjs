// Private mode lets the side panel agent reach only zero-data-retention OpenRouter routes and
// models on the user's own machines or network. Bug reports are off by default, redact what
// could identify the user or leak a key, and are only ever shared by the user, by hand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addEntry, NEW_ISSUE_URL, redact, reportText } from "../src/privacy/bug-reports.ts";
import { assertPrivateProxy, isLocalBaseUrl, OPENROUTER_PRIVATE_ROUTING, PrivateModeError, privateModel } from "../src/privacy/private-mode.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const openrouter = { provider: "openrouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" };
// Assembled at run time so the file holds no key-shaped literal.
const fakeKey = ["sk", "ant", "api03", "ABCDEFGHIJKLMNOP"].join("-");

test("OpenRouter gets zero-data-retention routing, keeping any provider order", () => {
	const m = privateModel({ ...openrouter, compat: { openRouterRouting: { order: ["anthropic"] } } });
	assert.deepEqual(m.compat.openRouterRouting, { order: ["anthropic"], zdr: true, data_collection: "deny", allow_fallbacks: false });
	assert.deepEqual(OPENROUTER_PRIVATE_ROUTING, { zdr: true, data_collection: "deny", allow_fallbacks: false });
});

test("OpenRouter on an adapter that wouldn't send the routing is refused, and so are impostors", () => {
	for (const api of ["openai-responses", "anthropic-messages", undefined]) {
		assert.throws(() => privateModel({ ...openrouter, api }), PrivateModeError, String(api));
	}
	assert.throws(() => privateModel({ ...openrouter, baseUrl: "https://openrouter.ai.evil.example.com/v1" }), PrivateModeError);
	assert.throws(() => privateModel({ ...openrouter, provider: "custom" }), PrivateModeError);
});

test("hosted providers are refused; local models pass; tailnet hosts only when the user lists them", () => {
	for (const [provider, baseUrl] of [
		["anthropic", "https://api.anthropic.com"],
		["openai", "https://api.openai.com/v1"],
		["custom", "https://my-vps.example.com/v1"],
		["custom", "http://8.8.8.8:11434/v1"],
		["custom", "https://someone.tail9999.ts.net/v1"],
		["custom", "http://100.101.102.103:11434"],
	]) {
		assert.throws(() => privateModel({ provider, baseUrl }), PrivateModeError, `${provider} ${baseUrl}`);
	}
	for (const baseUrl of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080", "http://192.168.1.20:8000", "http://10.0.0.5/v1", "http://172.20.1.1/v1", "http://studio.local:1234"]) {
		assert.ok(isLocalBaseUrl(baseUrl), baseUrl);
	}
	assert.ok(isLocalBaseUrl("https://gpu.tail1234.ts.net/v1", ["gpu.tail1234.ts.net"]));
	const m = { provider: "custom", baseUrl: "https://gpu.tail1234.ts.net/v1" };
	assert.equal(privateModel(m, ["gpu.tail1234.ts.net"]), m);
	for (const baseUrl of ["http://172.32.0.1", "http://192.169.0.1", "not a url"]) assert.equal(isLocalBaseUrl(baseUrl), false, baseUrl);
});

test("a CORS proxy off the user's machines is refused in private mode", () => {
	assert.throws(() => assertPrivateProxy(true, "https://proxy.example.com"), PrivateModeError);
	assert.doesNotThrow(() => assertPrivateProxy(true, "http://localhost:3001"));
	assert.doesNotThrow(() => assertPrivateProxy(false, "https://proxy.example.com"));
});

test("bug reports drop web addresses, emails, keys and home paths, and never travel in a URL", () => {
	const text = redact(
		`Failed https://mail.example.com/inbox/thread/patient-records-jdoe for ada@example.com with ${fakeKey} at /Users/donovan/project and C:\\Users\\ada\\x in chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/sidepanel.js:10`,
	);
	assert.doesNotMatch(text, /mail\.example|patient-records|ada@example|ABCDEFGHIJKLMNOP|donovan|\\ada\\|kenehmggpggpiolepbjojeenmeapgfoc/);
	assert.match(text, /\[url\]/);
	assert.match(text, /ext:\/sidepanel\.js/);
	const log = Array.from({ length: 30 }, (_, i) => i).reduce((l, i) => addEntry(l, new Error(`e${i}`)), []);
	assert.equal(log.length, 20, "the log is a short ring buffer");
	assert.match(reportText("1.2.3", log, "Mozilla/5.0"), /e29/);
	assert.equal(new URL(NEW_ISSUE_URL).search, "?labels=bug-report", "the issue page URL carries no report text");
});

test("bug reports are off by default; turning them off clears the log through the same queue as captures", () => {
	const capture = readFileSync(join(repo, "src", "privacy", "capture.ts"), "utf8");
	assert.match(capture, /!== true\) return/, "capture records only when the setting is exactly true");
	assert.match(capture, /if \(!on\) await storage\.settings\.set\(BUG_LOG_KEY, \[\]\);/);
	assert.match(capture, /export function setBugReports[\s\S]*?return serial\(/, "opt-out runs in the capture queue");
	for (const file of ["src/privacy/capture.ts", "src/privacy/bug-reports.ts", "src/dialogs/PrivacyTab.ts"]) {
		assert.doesNotMatch(readFileSync(join(repo, file), "utf8"), /\bfetch\(|sendBeacon|XMLHttpRequest/, `${file} sends data`);
	}
	const welcome = readFileSync(join(repo, "src", "dialogs", "WelcomeSetupDialog.ts"), "utf8");
	const input = welcome.slice(welcome.indexOf("<input"), welcome.indexOf("/>", welcome.indexOf("<input")));
	assert.ok(input.includes('type="checkbox"'), "found the welcome checkbox");
	// A checked attribute or a .checked binding (reading e.target.checked in the handler is fine).
	assert.doesNotMatch(input, /(^|\s)\.?checked(\s*=|\s*$|\s)/m, "the welcome checkbox has no checked attribute or binding");
	assert.match(welcome, /setBugReports\(getTabkyraStorage\(\)/, "the welcome box goes through the shared queue");
});

test("the stream gate applies private mode, the trusted hosts and the proxy check to every side panel request", () => {
	const sidepanel = readFileSync(join(repo, "src", "sidepanel.ts"), "utf8");
	assert.match(sidepanel, /assertPrivateProxy\(/);
	assert.match(sidepanel, /model = privateModel\(model, trusted\);/);
	assert.equal((sidepanel.match(/new PrivacyTab\(\)/g) ?? []).length, 2, "both settings entry points show the Privacy tab");
});
