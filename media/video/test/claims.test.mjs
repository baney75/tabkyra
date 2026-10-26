// Every stamp and label the hero shows must come from the recording. These tests run the
// render's own checks on the real capture and on doctored copies of it: a doctored copy that
// contradicts a stamp must make the check throw, so the render fails instead of lying.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { catalogRunFrom, checkCli } from "../src/hero/claims.ts";

const real = JSON.parse(readFileSync(new URL("../public/capture/capture.json", import.meta.url), "utf8"));
const copy = () => structuredClone(real);
const catalog = (c) => catalogRunFrom(c.browser.calls, c.browser.catalog.refs, c.browser.catalogUrl);

test("the real capture passes and REFUSED sits on the 404 refusal line", () => {
	const cli = checkCli(real.cli);
	assert.match(cli.refusal, /is not registered \(doi\.org returned 404\)/);
	assert.equal(cli.cleanLine, "✓ Clean.");
	assert.equal(cli.lintErrors.length, 4);
	const run = catalog(real);
	assert.match(run.clickHold, /\/\/ Place hold$/);
	assert.match(run.clickConfirm, /\/\/ Confirm hold$/);
	assert.match(run.readBack, /^get_page_text/);
});

test("a doi.org outage during the made-up DOI add fails the render", () => {
	const c = copy();
	c.cli.libraryMadeUp.out = "✗ Couldn't reach doi.org (ETIMEDOUT). Try again later.";
	assert.throws(() => checkCli(c.cli), /made-up DOI refusal/);
});

test("a made-up DOI add that succeeded fails the render", () => {
	const c = copy();
	c.cli.libraryMadeUp.code = 0;
	assert.throws(() => checkCli(c.cli), /made-up DOI add/);
});

test("a shipped-skills lint with an error fails the render", () => {
	const c = copy();
	c.cli.lintShipped.out = "✓ Clean.\nfoo/SKILL.md:3  error  remote-code  Runs downloaded code.";
	assert.throws(() => checkCli(c.cli), /lists errors/);
});

test("a retracted add that didn't exit 3 fails the render", () => {
	const c = copy();
	c.cli.libraryRetracted.code = 0;
	assert.throws(() => checkCli(c.cli), /retracted add/);
});

test("an extra click before the hold puts the real hold click under the hold shot", () => {
	const c = copy();
	const calls = c.browser.calls;
	const results = calls.findIndex((x) => x.name === "read_page" && x.text.includes("Place hold"));
	// A cookie-banner dismissal after the search, read from its own snapshot.
	calls.splice(
		results,
		0,
		{ name: "read_page", args: { filter: "interactive" }, ms: 5, text: 'Page: x\ne1 button "Accept cookies"\n' },
		{ name: "click", args: { ref: "e7" }, ms: 5, text: '{"clicked":{"x":1,"y":1}}' },
	);
	const run = catalog(c);
	assert.equal(run.clickHold, 'click { ref: "e1" }  // Place hold');
	assert.equal(run.clickConfirm, 'click { ref: "e3" }  // Confirm hold');
});

test("a hold click made from a different snapshot than the results fails the render", () => {
	const c = copy();
	const calls = c.browser.calls;
	const hold = calls.findIndex((x) => x.name === "click");
	calls.splice(hold, 0, { name: "read_page", args: { filter: "interactive" }, ms: 5, text: 'Page: x\ne1 button "Accept cookies"\n' });
	assert.throws(() => catalog(c), /hold button/);
});

test("a run that clicked a button other than Confirm fails the render", () => {
	const c = copy();
	const form = c.browser.calls.find((x) => x.name === "read_page" && x.text.includes("Confirm hold"));
	form.text = form.text.replace('e3 button "Confirm hold"', 'e3 button "Cancel"');
	assert.throws(() => catalog(c), /confirm/i);
});
