// Fails if a removed subscription sign-in, or any identifier that poses as another app,
// comes back. docs/auth-policy.md has the provider terms behind each entry.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const b64 = (s) => Buffer.from(s).toString("base64");

/** [what it is, the text that must not appear] */
const FORBIDDEN = [
	["Codex CLI OAuth client id", "app_EMoamEEZ73f0CkXaXp7hrann"],
	["VS Code Copilot Chat OAuth client id", "Iv1.b507a08c87ecfe98"],
	["Gemini CLI OAuth client id", "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j"],
	["Gemini CLI OAuth client secret", "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"],
	["Claude Code OAuth client id", "9d1c250a-e61b-44d9-88ed-5944d1962f5e"],
	["Codex originator parameter", "originator"],
	["Codex CLI sign-in flag", "codex_cli_simplified_flow"],
	["Copilot Chat user agent", "GitHubCopilotChat"],
	["Copilot editor header", "Editor-Version"],
	["Copilot editor plugin header", "Editor-Plugin-Version"],
	["Copilot integration header", "Copilot-Integration-Id"],
	["Copilot integration id", "vscode-chat"],
	["Copilot internal token endpoint", "copilot_internal"],
	["Gemini Code Assist endpoint", "cloudcode-pa.googleapis.com"],
	["Gemini CLI user agent", "google-api-nodejs-client"],
	["Gemini CLI client header", "X-Goog-Api-Client"],
	["ChatGPT subscription backend", "chatgpt.com/backend-api"],
	["OpenAI OAuth host", "auth.openai.com"],
	["Claude OAuth host", "claude.ai/oauth"],
	["Claude console OAuth", "platform.claude.com/v1/oauth"],
	["Anthropic console OAuth", "console.anthropic.com/v1/oauth"],
	["Claude Code beta flag", "claude-code-20250219"],
	["Claude Code user agent", "claude-cli/"],
	["Codex user agent", "codex_cli_rs"],
];

// Base64 hides an id from a plain grep; the old code did exactly that.
const NEEDLES = FORBIDDEN.flatMap(([what, text]) => [
	[what, text],
	[`${what} (base64)`, b64(text)],
]);

const ROOTS = ["src", "static", "cli/src", "cli/scripts", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "bench", "probe"]);
const TEXT = /\.(ts|js|mjs|json|html|css)$/;

function* files(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (!SKIP_DIRS.has(name)) yield* files(path);
		} else if (TEXT.test(name)) yield path;
	}
}

test("no borrowed client ids, headers or subscription endpoints in shipped source", () => {
	const hits = [];
	for (const root of ROOTS) {
		const dir = join(repo, root);
		if (!existsSync(dir)) continue;
		for (const file of files(dir)) {
			const text = readFileSync(file, "utf8");
			for (const [what, needle] of NEEDLES) {
				if (text.includes(needle)) hits.push(`${relative(repo, file)}: ${what} (${needle})`);
			}
		}
	}
	assert.deepEqual(hits, [], `Removed sign-in identifiers came back:\n${hits.join("\n")}`);
});

test("the built extension bundle carries none of them either", (t) => {
	const dist = join(repo, "dist-chrome");
	if (!existsSync(join(dist, "sidepanel.js"))) return t.skip("dist-chrome is not built");
	const hits = [];
	for (const file of files(dist)) {
		if (file.endsWith(".map")) continue;
		const text = readFileSync(file, "utf8");
		for (const [what, needle] of NEEDLES) if (text.includes(needle)) hits.push(`${relative(repo, file)}: ${what}`);
	}
	assert.deepEqual(hits, [], `The bundle still ships removed sign-in code:\n${hits.join("\n")}`);
});

test("the removed sign-in modules stay removed", () => {
	for (const file of ["openai-codex.ts", "github-copilot.ts", "google-gemini-cli.ts", "anthropic.ts", "browser-oauth.ts"]) {
		assert.equal(existsSync(join(repo, "src", "oauth", file)), false, `src/oauth/${file} is back`);
	}
});

test("the policy still lists every removed provider and subscription API", () => {
	const policy = readFileSync(join(repo, "src", "auth", "policy.ts"), "utf8");
	for (const id of ["openai-codex", "github-copilot", "google-gemini-cli", "google-antigravity", "openai-codex-responses"]) {
		assert.ok(policy.includes(`"${id}"`), `src/auth/policy.ts no longer blocks ${id}`);
	}
	assert.match(policy, /sk-ant-oat/, "Claude subscription tokens must stay refused");
});

test("the UI says API use is billed and offers no subscription sign-in", () => {
	const tab = readFileSync(join(repo, "src", "dialogs", "ApiKeysTab.ts"), "utf8");
	const dialog = readFileSync(join(repo, "src", "dialogs", "ApiKeyDialog.ts"), "utf8");
	for (const text of [tab, dialog]) assert.match(text, /API_BILLING_NOTE/);
	const policy = readFileSync(join(repo, "src", "auth", "policy.ts"), "utf8");
	assert.match(policy, /billed by the provider/);
	for (const file of readdirSync(join(repo, "src", "dialogs"))) {
		const text = readFileSync(join(repo, "src", "dialogs", file), "utf8");
		assert.doesNotMatch(text, /oauthLogin|Subscription Login|Log in with your existing subscription/, `${file} offers a sign-in`);
	}
});

test("docs/auth-policy.md keeps a row for every provider decision", () => {
	const doc = readFileSync(join(repo, "docs", "auth-policy.md"), "utf8");
	for (const provider of ["OpenAI", "GitHub", "Google", "Anthropic"]) assert.match(doc, new RegExp(`\\| ${provider} \\|`));
	assert.match(doc, /Checked 2026-\d\d-\d\d/);
});
