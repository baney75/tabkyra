// The side panel's display helpers: readable model and provider names, prices that stay
// prices, when the header offers "Share this tab", and the starter chips.
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

test("Share this tab is offered only for an active tab the agent does not have", async () => {
	const fake = installFakeChrome();
	const { tabToShare } = await import(`../src/browser/share-tab.ts?${Math.random()}`);
	const home = fake.addTab({ active: true, url: "https://shop.example/" });
	// The panel's own task tab in front: nothing to share. This was the button that did nothing.
	assert.equal(await tabToShare(1, [home]), undefined);
	// The user looks at another tab while the panel stays open: offer it.
	const fake1 = installFakeChrome();
	const task = fake1.addTab({ url: "https://shop.example/" });
	const other = fake1.addTab({ active: true, url: "https://news.example/" });
	assert.equal(await tabToShare(1, [task]), other);
	// Once shared, the offer goes away.
	assert.equal(await tabToShare(1, [task, other]), undefined);
	// The extension's own pages are never offered.
	const fake2 = installFakeChrome();
	fake2.addTab({ active: true, url: "chrome-extension://abc/sidepanel.html" });
	assert.equal(await tabToShare(1, []), undefined);
	assert.equal(await tabToShare(undefined, []), undefined);
});

test("the header has no always-on share button, and every icon button has a tooltip", () => {
	const src = readFileSync(new URL("../src/sidepanel.ts", import.meta.url), "utf8");
	const header = src.slice(src.indexOf("const renderApp = () => {"), src.indexOf("${updateNotice()}"));
	// Share is the labeled pill, shown only when shareableTabId is set.
	assert.match(header, /shareableTabId !== undefined\s*\?\s*html`<button[\s\S]*?Share this tab/);
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
