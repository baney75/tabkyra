// Private mode lets the side panel agent reach only zero-data-retention OpenRouter routes and
// models on the user's own machines or network. Bug reports are off by default, redact what
// could identify the user or leak a key, and are only ever shared by the user, by hand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addEntry, NEW_ISSUE_URL, redact, reportText } from "../src/privacy/bug-reports.ts";
import { assertPrivateProxy, hostOf, isLocalBaseUrl, OPENROUTER_PRIVATE_ROUTING, PrivateModeError, privateModel } from "../src/privacy/private-mode.ts";

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
	assert.throws(() => privateModel({ ...openrouter, baseUrl: "http://openrouter.ai/api/v1" }), PrivateModeError, "plain HTTP");
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
	for (const baseUrl of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080"]) assert.ok(isLocalBaseUrl(baseUrl), baseUrl);
	// LAN and mDNS hosts count only once listed: at a hotel the same address is someone else's.
	for (const baseUrl of ["http://192.168.1.20:8000", "http://10.0.0.5/v1", "http://172.20.1.1/v1", "http://studio.local:1234"]) {
		assert.equal(isLocalBaseUrl(baseUrl), false, baseUrl);
	}
	assert.ok(isLocalBaseUrl("http://192.168.1.20:8000", ["192.168.1.20"]));
	assert.ok(isLocalBaseUrl("https://gpu.tail1234.ts.net/v1", ["gpu.tail1234.ts.net"]));
	const m = { provider: "custom", baseUrl: "https://gpu.tail1234.ts.net/v1" };
	assert.equal(privateModel(m, ["gpu.tail1234.ts.net"]), m);
	for (const baseUrl of ["http://172.32.0.1", "http://192.169.0.1", "not a url"]) assert.equal(isLocalBaseUrl(baseUrl), false, baseUrl);
});

test("the trusted-hosts field accepts names, IPs, URLs and host:port", () => {
	assert.equal(hostOf("https://mac.tail1234.ts.net"), "mac.tail1234.ts.net");
	assert.equal(hostOf("mac.tail1234.ts.net:11434"), "mac.tail1234.ts.net");
	assert.equal(hostOf("fd7a:115c:a1e0::1"), "fd7a:115c:a1e0::1");
	assert.equal(hostOf("192.168.1.20"), "192.168.1.20");
	assert.equal(hostOf(""), undefined);
});

test("listing openrouter.ai as trusted doesn't skip the ZDR routing", () => {
	const m = privateModel({ ...openrouter }, ["openrouter.ai"]);
	assert.equal(m.compat.openRouterRouting.zdr, true);
});

test("redaction keeps URLs with parentheses whole, and drops IPv6 and base64 secrets", () => {
	const text = redact(
		"Failed https://wiki.example.com/wiki/Jane_Doe_(patient)/records). At [fd7a:115c:a1e0::1234]:8080 and fe80::1, bad credential wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	);
	assert.doesNotMatch(text, /records|Jane_Doe|fd7a|fe80|wJalr|EXAMPLEKEY/, text);
	assert.match(text, /\[url\]\)\./, "sentence punctuation after a URL is kept");
	assert.match(redact("took 12:34:56 to load"), /12:34:56/, "a clock time isn't an IPv6 address");
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
	assert.match(
		redact("at chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/assets/chunk-4f2a.js:3:9"),
		/ext:\/chunk-4f2a\.js:3:9/,
		"a stack line keeps its file name when the path has digits",
	);
	assert.match(
		redact("at chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/assets/components/ThreadListView.js:3:9"),
		/ext:\/ThreadListView\.js:3:9/,
		"a long path keeps its file name",
	);
	assert.match(redact("at chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/pages/home/view.js:3:9"), /ext:\/view\.js:3:9/);
	const tokenAfterQuery = ["a1b2c3d4", "e5f6g7h8i9"].join("");
	const leaked = redact(`at chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/api.js?auth=Bearer ${tokenAfterQuery}`);
	assert.doesNotMatch(leaked, new RegExp(tokenAfterQuery), "the query is read by the secret rules before it is dropped");
	assert.doesNotMatch(leaked, /auth=/);
	assert.match(redact("a \u00000\u0000 b"), /^a 0 b$/, "a planted marker can't pull in a path");
	// Directories never survive: a path can carry a key (with "/" in it) or an address.
	for (const dir of [["Zx9", "Qw8".repeat(10)].join(""), "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "0123456789abcdef".repeat(2) + "01234567", "a/203.0.113.9"]) {
		const out = redact(`at chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/${dir}/a.js:3:9`);
		assert.equal(out, "at ext:/a.js:3:9", dir);
	}
	assert.equal(redact(`chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/${"0123456789abcdef".repeat(2)}01234567.js`), "ext:/[file]", "a long file name is dropped");
	// Anything that isn't plainly a build file name loses its path.
	for (const [input, out] of [
		["203.0.113.9", "x ext:/[file]"],
		["Users/donovan", "x ext:/[file]"],
		["home/ada", "x ext:/[file]"],
		["Zq8xW3mN7pL2vR9tY4kB6cH1dF5gJ0s+Ab3Cd4Ef5Gh6", "x ext:/[file]"],
		["a.js@example.com", "x ext:/[file]"],
	]) {
		assert.equal(redact(`x chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/${input}`), out, input);
	}
	const more = redact(
		"chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/sidepanel.html?session=abc&q=jdoe data:image/png;base64,iVBORw0K/a+b blob:https://x.example/1 at 203.0.113.9:8080",
	);
	assert.doesNotMatch(more, /jdoe|session=|iVBOR|x\.example|203\.0\.113/);
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
	assert.doesNotMatch(input, /(^|\s)[.?]?checked(\s*=|\s*$|\s)/m, "the welcome checkbox has no checked attribute or binding");
	assert.match(welcome, /setBugReports\(getTabkyraStorage\(\)/, "the welcome box goes through the shared queue");
	assert.match(welcome, /this\.reportsOn\s*\?/, "when reports are already on, the welcome dialog says so instead of an unchecked box");
});

test("the stream gate applies private mode, the trusted hosts and the proxy check to every side panel request", () => {
	const sidepanel = readFileSync(join(repo, "src", "sidepanel.ts"), "utf8");
	assert.match(sidepanel, /assertPrivateProxy\(/);
	assert.match(sidepanel, /model = privateModel\(model, trusted\);/);
	assert.equal((sidepanel.match(/new PrivacyTab\(\)/g) ?? []).length, 2, "both settings entry points show the Privacy tab");
});
