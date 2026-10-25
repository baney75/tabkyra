// The "Copy setup prompt" button replaced the subscription sign-in paragraph. The prompt is
// pasted into an agent with shell access, so it passes the same lint as a skill: no piped
// installers, no secrets, no config tampering. It must also name every step setup needs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lintText } from "../cli/src/skill-lint.ts";
import { agentSetupPrompt } from "../src/agent-setup-prompt.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const prompt = agentSetupPrompt("1.2.3");

test("the setup prompt covers install, connect, skills and a status check", () => {
	for (const step of [
		/git clone https:\/\/github\.com\/baney75\/tabkyra/,
		/npm link/,
		/tabkyra setup --yes/,
		/tabkyra mcp|"mcp"/,
		/tabkyra pi-extension/,
		/tabkyra skill install/,
		/tabkyra skill print >> AGENTS\.md/,
		/tabkyra doctor/,
		/status tool/,
		/1\.2\.3/,
	]) {
		assert.match(prompt, step);
	}
});

test("the setup prompt passes the skill security lint", () => {
	const findings = lintText("setup prompt", prompt, { reference: true });
	assert.deepEqual(findings, [], findings.map((f) => `${f.rule}: ${f.message}`).join("\n"));
	assert.doesNotMatch(prompt, /\|\s*(sh|bash)\b/);
});

test("the API keys tab no longer carries the subscription sign-in paragraph, and offers the prompt", () => {
	for (const file of ["ApiKeysTab.ts", "WelcomeSetupDialog.ts", "BridgeTab.ts"]) {
		const text = readFileSync(join(repo, "src", "dialogs", file), "utf8");
		assert.doesNotMatch(text, /posing as|terms forbid/, `${file} still explains removed sign-ins`);
		assert.match(text, /agentSetupPromptButton\(/, `${file} lacks the setup prompt button`);
	}
});
