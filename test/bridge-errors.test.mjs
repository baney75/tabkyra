// Expected failures get their own code and no stack trace; `internal` is for real bugs.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
const { classify, splitStack, BridgeError } = await import("../src/bridge/errors.ts");
const { NoTabError } = await import("../src/browser/session.ts");

const STACK = "\n    at resolveRef (<anonymous>:12:32)\n    at <anonymous>:16:3";

test("splitStack cuts a page-side stack off the message and keeps it apart", () => {
	const { message, stack } = splitStack(`Error: Ref e1 not found: the page changed.${STACK}`);
	assert.equal(message, "Error: Ref e1 not found: the page changed.");
	assert.match(stack, /resolveRef/);
	assert.deepEqual(splitStack("plain"), { message: "plain" });
});

test("classify gives each expected failure its code, with no stack in the message", () => {
	const cases = [
		[`Error: Ref e7 not found: the page changed. Call read_page for fresh refs.${STACK}`, "stale_ref"],
		["Ref e7 now shows something else: the page reused it. Call read_page for fresh refs.", "stale_ref"],
		["Ref e7 isn't shown now (hidden or closed). Call read_page for fresh refs.", "stale_ref"],
		[`Error: Selector not found: #x. read_page or find gives refs.${STACK}`, "not_found"],
		["Tab 5 is not owned by this session", "not_found"],
		["Ref e7 is covered by div \"Cookie settings\". Close or dismiss it, then call read_page.", "not_actionable"],
		["Invalid regular expression: /(/i: Unterminated group", "bad_params"],
		["Navigation to https://x.invalid/ failed: net::ERR_NAME_NOT_RESOLVED", "navigation_failed"],
		["Cannot run scripts on chrome://x: browser-internal pages are protected.", "permission_denied"],
		["Screenshot timed out after 20 s: the browser did not paint this background tab.", "timeout"],
	];
	for (const [text, code] of cases) {
		const { error } = classify(new Error(text), "click");
		assert.equal(error.code, code, text);
		assert.doesNotMatch(error.message, /\n\s+at /);
		assert.doesNotMatch(error.message, /^Error: /);
	}
});

test("a page script's own exception is script_error for run_js and internal anywhere else", () => {
	const { error, stack } = classify(new Error(`Error: boom${STACK}`), "evaluate");
	assert.equal(error.code, "script_error");
	assert.equal(error.message, "Error: boom");
	assert.match(stack, /resolveRef/);
	assert.equal(classify(new Error("something broke"), "click").error.code, "internal");
});

test("typed errors keep their code; a lost debugger is interrupted, never the raw message", () => {
	const own = new BridgeError("dialog_open", "A confirm dialog is open");
	assert.equal(classify(own, "click").error, own);
	assert.equal(classify(new NoTabError(), "click").error.code, "no_tab");
	for (const raw of ["Detached while handling command.", "Debugger is not attached to the tab with id: 4."]) {
		const { error } = classify(new Error(raw), "click");
		assert.equal(error.code, "interrupted");
		assert.match(error.message, /Check the page with read_page before you repeat it/);
		assert.doesNotMatch(error.message, /Detached while handling|not attached to the tab/);
	}
});
