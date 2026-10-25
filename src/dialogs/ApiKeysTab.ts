import { getProviders } from "@mariozechner/pi-ai";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { API_BILLING_NOTE, REMOVED_SIGN_IN_PROVIDERS } from "../auth/policy.js";

// Providers to hide from the API key list: removed sign-ins, and clouds that need more than a key.
const HIDDEN_PROVIDERS = new Set([
	...REMOVED_SIGN_IN_PROVIDERS,
	"amazon-bedrock",
	"azure-openai-responses",
	"google-vertex",
	"opencode",
	"opencode-go",
	"kimi-coding",
]);

export class ApiKeysTab extends SettingsTab {
	getTabName(): string {
		return "API Keys";
	}

	render(): TemplateResult {
		const providers = getProviders().filter((p) => !HIDDEN_PROVIDERS.has(p));
		return html`
			<div class="flex flex-col gap-6">
				<div>
					<h3 class="text-sm font-semibold text-foreground mb-2">API Keys</h3>
					<p class="text-sm text-muted-foreground mb-2">
						Enter API keys for cloud providers. Keys are stored locally in your browser.
					</p>
					<p class="text-sm text-muted-foreground mb-2">${API_BILLING_NOTE}</p>
					<p class="text-xs text-muted-foreground">
						There is no ChatGPT, Claude, GitHub Copilot or Gemini subscription sign-in. Those sign-ins
						only work by posing as the providers' own apps, and their terms forbid it.
					</p>
				</div>
				<div class="flex flex-col gap-6">
					${providers.map((provider) => html`<provider-key-input .provider=${provider}></provider-key-input>`)}
				</div>
			</div>
		`;
	}
}

if (!customElements.get("tabkyra-api-keys-tab")) {
	customElements.define("tabkyra-api-keys-tab", ApiKeysTab);
}
