// Every caption and label the Agents video shows must come from the recording. These tests run
// the render's own checks on the real capture and on doctored copies of it: a doctored copy that
// contradicts a caption must make the check throw, so the render fails instead of lying.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkAgents, checkAsk, checkCli, checkComposer, checkHandoff, checkReload, checkResume } from "../src/agents/claims.ts";

const real = JSON.parse(readFileSync(new URL("../public/capture/agents/agents.json", import.meta.url), "utf8"));
const copy = () => structuredClone(real);
const titles = (c) => checkAgents(c).agents.map((a) => a.title);
const all = (c) => {
	const t = titles(c);
	checkResume(c, t[0]);
	checkHandoff(c);
	checkAsk(c);
	checkComposer(c, t);
	checkCli(c, t, "teapot");
	checkReload(c);
};

test("the real capture passes every check", () => {
	all(real);
	const team = checkAgents(real);
	assert.deepEqual(
		team.agents.map((a) => a.title),
		["Tabkyra · claude · shop", "Tabkyra · claude · shop 2", "Tabkyra · claude · shop 3"],
	);
	assert.equal(new Set(team.agents.map((a) => a.color)).size, 3);
	assert.match(team.refusal.text, /not owned by this session/);
	assert.match(checkHandoff(real).news, /^The user took tab \d+ .* it's theirs now/);
	assert.equal(checkReload(real).runs, 1);
});

test("two agents in one group fail the hook", () => {
	const c = copy();
	c.agents.agent2.group = c.agents.agent1.group;
	c.groups.find((g) => g.tabs.some((t) => t.id === c.agents.agent2.tabId)).title = c.agents.agent1.group.title;
	assert.throws(() => checkAgents(c), /group/);
});

test("an agent that sees another's tab fails 'Each one sees only its own'", () => {
	const c = copy();
	c.agents.agent3.context += `\n  ${c.agents.agent1.tabId} "Copper Kettle" ${c.site}/product/kettle`;
	assert.throws(() => checkAgents(c));
});

test("a cross-talk call that succeeded fails NOT YOURS", () => {
	const c = copy();
	c.crossTalk.isError = false;
	c.crossTalk.text = '{"selected":true}';
	assert.throws(() => checkAgents(c), /wasn't refused/);
});

test("a restart that lost a tab fails 'Its tabs come back'", () => {
	const c = copy();
	c.resume.after = c.resume.after.split("\n").slice(0, 2).join("\n");
	assert.throws(() => checkResume(c, titles(c)[0]), /restarted agent/);
});

test("a hand-off the agent wasn't told about fails 'Now it's yours'", () => {
	const c = copy();
	c.handoff.context = c.handoff.context
		.split("\n")
		.filter((l) => !l.startsWith("News:"))
		.join("\n");
	assert.throws(() => checkHandoff(c), /News/);
	const d = copy();
	d.handoff.tabAfter.groupId = 7;
	assert.throws(() => checkHandoff(d), /still in a group/);
});

test("an answer the agent didn't get, or didn't use, fails 'It gets your answer'", () => {
	const c = copy();
	c.ask.result = "No answer: the user skipped the question.";
	assert.throws(() => checkAsk(c), /didn't get/);
	const d = copy();
	d.ask.after.fills[1].args.value = "PayPal sandbox";
	assert.throws(() => checkAsk(d), /didn't use the answer/);
});

test("a side panel run that never read the tab fails the composer beat", () => {
	const c = copy();
	c.composer.transcript = `${c.composer.task}\nI don't have access to the page.`;
	assert.throws(() => checkComposer(c, titles(c)), /never read/);
	const d = copy();
	d.composer.atAll = d.composer.atAll.map((r) => r.replace(/ used by agent .*? 127/, " 127"));
	assert.throws(() => checkComposer(d, titles(d)), /in use/);
});

test("a failed CLI command or a search with no hit fails the terminal beat", () => {
	const c = copy();
	c.cli.sessions.code = 1;
	assert.throws(() => checkCli(c, titles(c), "teapot"), /exited 1/);
	const d = copy();
	d.cli.threads.out = 'No threads mention "teapot".';
	assert.throws(() => checkCli(d, titles(d), "teapot"), /didn't find/);
});

test("a click that ran twice, or a cut-off call with no advice, fails the reload beat", () => {
	const c = copy();
	c.reload.ordersAfter = c.reload.ordersBefore + 2;
	assert.throws(() => checkReload(c), /ran 2 times/);
	const d = copy();
	d.reload.call.text = "interrupted: the connection dropped.";
	assert.throws(() => checkReload(d), /check the page/);
});
