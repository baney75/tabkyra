// The side panel's display helpers: readable model and provider names, prices that stay
// prices, how the active tab reaches the agent, and the starter chips.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { escapeCurrency } from "../src/transcript/currency.ts";
import { modelDisplayName, modelLabelParts, providerDisplayName } from "../src/models/display.ts";
import { installFakeChrome } from "./fake-chrome.mjs";

test("a discovered model whose name is its id gets a readable name", () => {
	assert.equal(modelDisplayName({ id: "deepseek/deepseek-v4.1-flash-1017", name: "deepseek/deepseek-v4.1-flash-1017" }), "DeepSeek V4.1 Flash");
	assert.equal(modelDisplayName({ id: "qwen3-8b-nothink" }), "Qwen3 8B Nothink");
	assert.equal(modelDisplayName({ id: "gpt-4o-mini-2024-07-18" }), "GPT-4o Mini");
	assert.equal(modelDisplayName({ id: "claude-3-5-haiku-20241022" }), "Claude 3 5 Haiku");
	assert.equal(modelDisplayName({ id: "o4-mini" }), "o4 Mini");
	assert.equal(modelDisplayName({ id: "meta-llama/llama-3.3-70b-instruct:free" }), "Llama 3.3 70B Instruct (free)");
});

test("a curated name wins, without the vendor prefix the provider already names", () => {
	assert.equal(modelDisplayName({ id: "deepseek/deepseek-chat", name: "DeepSeek: DeepSeek V3" }), "DeepSeek V3");
	assert.equal(modelDisplayName({ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }), "Claude Haiku 4.5");
});

test("provider names: known ones spelled right, custom ones kept as typed", () => {
	assert.equal(providerDisplayName("openrouter"), "OpenRouter");
	assert.equal(providerDisplayName("xai"), "xAI");
	assert.equal(providerDisplayName("vercel-ai-gateway"), "Vercel AI Gateway");
	assert.equal(providerDisplayName("Local"), "Local");
	assert.equal(providerDisplayName("My LM Box"), "My LM Box");
	assert.equal(providerDisplayName("some-new-cloud"), "Some New Cloud");
});

test("the composer's label keeps the full id in its tooltip", () => {
	const parts = modelLabelParts({ id: "deepseek/deepseek-v4.1-flash-1017", name: "deepseek/deepseek-v4.1-flash-1017", provider: "openrouter" });
	assert.equal(parts.name, "DeepSeek V4.1 Flash");
	assert.equal(parts.provider, "OpenRouter");
	assert.match(parts.title, /OpenRouter · deepseek\/deepseek-v4\.1-flash-1017/);
});

test("dollar amounts are escaped so they render as prices, math and code are not", () => {
	assert.equal(
		escapeCurrency("The C3 is $89, a hand grinder; the Opus is $4 less."),
		"The C3 is \\$89, a hand grinder; the Opus is \\$4 less.",
	);
	assert.equal(escapeCurrency("From $1,299.99 to $2.5M."), "From \\$1,299.99 to \\$2.5M.");
	assert.equal(escapeCurrency("Euler: $2^{10}$ and $3x+1$"), "Euler: $2^{10}$ and $3x+1$");
	assert.equal(escapeCurrency("Run `echo $5` then\n```\nprice=$9\n```\nok $7"), "Run `echo $5` then\n```\nprice=$9\n```\nok \\$7");
	assert.equal(escapeCurrency("already \\$5 and $$x$$"), "already \\$5 and $$x$$");
});

test("the tab the user is looking at goes to the agent with their message, no button needed", async () => {
	const fake = installFakeChrome();
	const { shareActiveTab, tabToShare } = await import(`../src/browser/share-tab.ts?${Math.random()}`);
	const task = fake.addTab({ url: "https://shop.example/" });
	const other = fake.addTab({ active: true, url: "https://news.example/" });
	const adopted = [];
	const session = (heldBy) => ({
		tabIds: [task],
		adoptIfFree: async (id, makeCurrent) => {
			if (heldBy) return { id: "bridge-x", label: heldBy };
			adopted.push([id, makeCurrent]);
		},
	});
	// Sending from another tab hands that tab over and makes it the agent's page.
	assert.deepEqual(await shareActiveTab(session(), 1, true), { tabId: other });
	assert.deepEqual(adopted, [[other, true]]);
	// "Send now" mid-run adds it without swapping the run's page.
	await shareActiveTab(session(), 1, false);
	assert.deepEqual(adopted.at(-1), [other, false]);
	// A tab another agent is driving stays with it.
	assert.deepEqual(await shareActiveTab(session("claude · shop"), 1, true), { tabId: other, heldBy: "claude · shop" });
	// The agent's own tab in front: nothing to do.
	assert.equal(await tabToShare(1, [task, other]), undefined);
	// Browser pages never go to the agent; a blank new tab does.
	for (const [url, shared] of [
		["chrome://settings/", false],
		["chrome-extension://abc/sidepanel.html", false],
		["https://chromewebstore.google.com/detail/x", false],
		["chrome://newtab/", true],
		["about:blank", true],
	]) {
		const f = installFakeChrome();
		const id = f.addTab({ active: true, url });
		assert.equal(await tabToShare(1, []), shared ? id : undefined, url);
	}
	assert.equal(await tabToShare(undefined, []), undefined);
});

test("a message sent mid-run queues, so the tab joins without becoming the run's page", () => {
	const src = readFileSync(new URL("../src/sidepanel.ts", import.meta.url), "utf8");
	const hook = src.slice(src.indexOf("onBeforeSend: async"), src.indexOf("steerContext: async"));
	assert.match(hook, /shareActiveTabOnSend\(agent\?\.state\.isStreaming !== true\)/);
	const steer = src.slice(src.indexOf("steerContext: async"), src.indexOf("onCostClick"));
	assert.match(steer, /shareActiveTabOnSend\(false\)/);
});

test("the header has no always-on share button, and every icon button has a tooltip", () => {
	const src = readFileSync(new URL("../src/sidepanel.ts", import.meta.url), "utf8");
	const header = src.slice(src.indexOf("const renderApp = () => {"), src.indexOf("${updateNotice()}"));
	// No share control at all: the active tab goes with the message.
	assert.doesNotMatch(header, /Share this tab|data-share-tab/);
	assert.doesNotMatch(header, /icon\(Link/);
	for (const call of header.matchAll(/headerButton\("([^"]+)"/g)) assert.ok(call[1].length > 2, `empty label: ${call[0]}`);
	assert.match(src, /function headerButton[\s\S]*?aria-label=\$\{label\} data-tip=\$\{label\}/);
});

test("starter chips: four, each a task that runs, none of the old odd ones", async () => {
	const { starters } = await import("../src/tutorials.ts");
	assert.deepEqual(
		starters.map((s) => s.label),
		["Summarize this page", "Research with sources", "Fill a form", "Compare tabs"],
	);
	for (const s of starters) {
		assert.ok(s.prompt.length > 20 && s.hint && s.icon, s.label);
		assert.ok(s.mode === "send" || s.mode === "compose", s.label);
	}
	// "Compare tabs" ends in "@" so the composer opens its tab menu.
	assert.match(starters.find((s) => s.label === "Compare tabs").prompt, /@$/);
});

test("pages that paint the theme background also set the theme text color, so dialogs on <body> stay readable", () => {
	// Dialogs mount on <body>, outside the panel's own text-foreground wrapper. Without a body
	// color, unstyled text fell back to black: near-invisible on the dark theme's ink.
	for (const page of ["static/sidepanel.html", "static/debug.html"]) {
		const body = readFileSync(new URL(`../${page}`, import.meta.url), "utf8").match(/<body class="([^"]*)"/)?.[1] ?? "";
		assert.match(body, /\bbg-background\b/, page);
		assert.match(body, /\btext-foreground\b/, page);
	}
});

test("the Claude and Gemini MCP setup commands render as readable command blocks with a copy button", () => {
	const source = readFileSync(new URL("../src/subscriptions/SubscriptionsSection.ts", import.meta.url), "utf8");
	assert.match(source, /this\.command\("Claude Code", CLI_MCP_SETUP\.claude\)/);
	assert.match(source, /this\.command\("Gemini CLI", CLI_MCP_SETUP\.gemini\)/);
	const block = source.slice(source.indexOf("private command("), source.indexOf("private row("));
	const codeClass = block.match(/<code class="([^"]*)"/)?.[1] ?? "";
	assert.match(codeClass, /\btext-foreground\b/);
	assert.match(codeClass, /\bfont-mono\b/);
	assert.match(block, /@click=\$\{\(\) => this\.copy\(text\)\}/);
});

test("settings tabs sit in an even grid until one row fits, so no tab is left alone on a line", () => {
	const patch = readFileSync(new URL("../patches/pi-mono.patch", import.meta.url), "utf8");
	const dialog = patch.slice(patch.indexOf("b/packages/web-ui/src/dialogs/SettingsDialog.ts"));
	assert.match(dialog, /\+\s*<div class="@container md:hidden/);
	assert.match(dialog, /\+\s*class="grid gap-1 @\[28rem\]:flex @\[28rem\]:flex-wrap"/);
	assert.match(dialog, /grid-template-columns: repeat\(\$\{this\.tabs\.length > 3 \? Math\.ceil\(this\.tabs\.length \/ 2\) : this\.tabs\.length\}/);
});

test("native controls follow the theme: dark mode declares color-scheme dark", () => {
	const css = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
	const dark = css.slice(css.indexOf(".dark {"), css.indexOf("}", css.indexOf(".dark {")));
	assert.match(dark, /color-scheme: dark;/);
	assert.match(dark, /accent-color: var\(--tk-brass\);/);
});

test("Settings > Providers reads top to bottom: Free mode, subscriptions, API keys with their search and list, custom providers", () => {
	const tab = readFileSync(new URL("../src/dialogs/ApiKeysTab.ts", import.meta.url), "utf8");
	const order = ["Free mode: use the best free model", "<tabkyra-subscriptions>", "agentSetupPromptButton(", ">API keys</h3>", 'placeholder="Find a provider"', "<provider-key-input", "${this.custom}"].map((s) => tab.indexOf(s));
	assert.ok(order.every((i) => i > 0), JSON.stringify(order));
	assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("subscription commands are copyable blocks, and a failed copy is a toast that can't overwrite or outlive the section's notice", () => {
	const source = readFileSync(new URL("../src/subscriptions/SubscriptionsSection.ts", import.meta.url), "utf8");
	assert.match(source, /this\.command\("Install the Copilot SDK", "tabkyra copilot-sdk install"\)/);
	assert.match(source, /this\.command\("Set up Tabkyra", "tabkyra setup"\)/);
	assert.doesNotMatch(source, /run <code>/, "no bare inline commands left");
	const copy = source.slice(source.indexOf("private copy("), source.indexOf("private command("));
	assert.match(copy, /Toast\.error\(/);
	assert.doesNotMatch(copy, /this\.notice/);
});

test("opening Settings doesn't scroll Providers past Free mode to reach the search box", () => {
	const tab = readFileSync(new URL("../src/dialogs/ApiKeysTab.ts", import.meta.url), "utf8");
	assert.match(tab, /\.focus\(\{ preventScroll: true \}\)/);
});
