// Every stamp and label the hero shows must come from the recording. These tests run the
// render's own checks on the real capture and on doctored copies of it: a doctored copy that
// contradicts a stamp must make the check throw, so the render fails instead of lying.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { catalogRunFrom, checkCli, checkPrompt, checkRouter } from "../src/hero/claims.ts";

const real = JSON.parse(readFileSync(new URL("../public/capture/capture.json", import.meta.url), "utf8"));
const realRouter = JSON.parse(readFileSync(new URL("../public/capture/router.json", import.meta.url), "utf8"));
const copy = () => structuredClone(real);
const catalog = (c) => catalogRunFrom(c.browser.calls, c.browser.catalog.refs, c.browser.catalogUrl, c.browser.catalog.confirmation);
const prompt = (c) =>
	checkPrompt(
		c.browser.permissionPrompt.requestedSchema.properties.decision,
		c.browser.permissionAnswer,
		c.browser.statusAfter.allowedHosts,
		new URL(c.browser.book.url).hostname,
	);
const readBackIndex = (c) => c.browser.calls.findIndex((x) => x.name === "get_page_text" && x.text.includes("Hold placed"));

test("the real capture passes and REFUSED sits on the 404 refusal line", () => {
	const cli = checkCli(real.cli);
	assert.match(cli.refusal, /is not registered \(doi\.org returned 404\)/);
	assert.equal(cli.cleanLine, "✓ Clean.");
	assert.equal(cli.lintErrors.length, 4);
	const run = catalog(real);
	assert.match(run.clickHold, /\/\/ Place hold$/);
	assert.match(run.clickConfirm, /\/\/ Confirm hold$/);
	assert.match(run.readBack, /^get_page_text/);
	assert.equal(run.confirmation, "Hold placed for Ada Lovelace: Moby-Dick. Pick it up at Main Street after Thursday.");
	assert.equal(cli.skillPath, "page-helper/SKILL.md");
	const router = checkRouter(realRouter);
	assert.deepEqual(
		router.rows.map((r) => [r.name, r.score]),
		[["academic-research", "11.73"], ["osint", "9.86"], ["none", ""], ["rsi", "6"]],
	);
	assert.equal(router.rows[2].description, "no skill fits this task.");
	assert.ok(router.p95Ms < 1);
	assert.deepEqual(prompt(real), { picked: 0, label: "Allow www.gutenberg.org from now on" });
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

test("a p95 of a millisecond or more fails the render", () => {
	const r = structuredClone(realRouter);
	r.eval.speed.p95Ms = 1.4;
	assert.throws(() => checkRouter(r), /not under a millisecond/);
});

test("a 'none' task that routed to a skill fails the render", () => {
	const r = structuredClone(realRouter);
	r.matches[2].out = "osint                  9.86  Research a person.";
	assert.throws(() => checkRouter(r), /routed to osint, expected none/);
});

test("a skill match that failed or routed elsewhere fails the render", () => {
	const r = structuredClone(realRouter);
	r.matches[0].code = 1;
	assert.throws(() => checkRouter(r), /exited 1/);
	const r2 = structuredClone(realRouter);
	r2.matches[1].out = "Warning: something\nosint  9.86  Research a person.";
	assert.throws(() => checkRouter(r2), /expected osint/);
});

test("the read-back sentence is the checked call's result, and a stale cached copy fails the render", () => {
	const c = copy();
	c.browser.catalog.confirmation = "Pinecrest Library\nHold placed for Grace Hopper: Moby-Dick. Pick it up at Riverside after Thursday.";
	assert.throws(() => catalog(c), /disagrees with the recorded read-back/);
});

test("a read-back that doesn't name what was filled fails the render", () => {
	const c = copy();
	const call = c.browser.calls[readBackIndex(c)];
	const page = JSON.parse(call.text);
	page.text = page.text.replace("Main Street", "Riverside");
	call.text = JSON.stringify(page);
	c.browser.catalog.confirmation = page.text;
	assert.throws(() => catalog(c), /doesn't name the filled value "Main Street"/);
});

test("a read-back with no confirmation sentence fails the render", () => {
	const c = copy();
	const call = c.browser.calls[readBackIndex(c)];
	call.text = JSON.stringify({ text: "Pinecrest Library\nHold placed? Something went wrong." });
	assert.throws(() => catalog(c), /hold confirmation/);
});

test("a lint error past the end of the bad skill file fails the render", () => {
	const c = copy();
	c.cli.badSkill = c.cli.badSkill.split("\n").slice(0, 15).join("\n");
	assert.throws(() => checkCli(c.cli), /names line 16, past the 15-line skill file/);
});

test("a lint error about a different file fails the render", () => {
	const c = copy();
	c.cli.lintBad.out = c.cli.lintBad.out.replace("page-helper/SKILL.md:14", "other/SKILL.md:14");
	assert.throws(() => checkCli(c.cli), /isn't about page-helper\/SKILL.md/);
});

test("reordered prompt choices move the checkmark to the recorded answer", () => {
	const c = copy();
	const d = c.browser.permissionPrompt.requestedSchema.properties.decision;
	d.enum.reverse();
	d.enumNames.reverse();
	assert.deepEqual(prompt(c), { picked: 2, label: "Allow www.gutenberg.org from now on" });
});

test("a recorded deny, a missing answer or an unallowed site fails the render", () => {
	const deny = copy();
	deny.browser.permissionAnswer = "deny";
	assert.throws(() => prompt(deny), /not an allow/);
	const missing = copy();
	delete missing.browser.permissionAnswer;
	assert.throws(() => prompt(missing), /isn't one of the prompt's choices/);
	const unallowed = copy();
	unallowed.browser.statusAfter.allowedHosts = ["127.0.0.1"];
	assert.throws(() => prompt(unallowed), /isn't in the allowed sites/);
});
