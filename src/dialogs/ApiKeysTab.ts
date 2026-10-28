import { getProviders } from "@mariozechner/pi-ai";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { API_BILLING_NOTE, REMOVED_SIGN_IN_PROVIDERS } from "../auth/policy.js";
import { agentSetupPromptButton } from "../components/AgentSetupPrompt.js";
import { FREE_PRIVACY_NOTE } from "../models/free-mode.js";
import { isFreeModeOn, setFreeMode } from "../models/free-panel.js";

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

	private async toggleFree(e: Event) {
		const input = e.target as HTMLInputElement;
		input.checked = await setFreeMode(input.checked);
		this.requestUpdate();
	}

	render(): TemplateResult {
		const providers = getProviders().filter((p) => !HIDDEN_PROVIDERS.has(p));
		return html`
			<div class="flex flex-col gap-6">
				<div class="space-y-2">
					<h3 class="text-sm font-semibold text-foreground">Free mode</h3>
					<label class="flex items-start gap-2 text-sm text-foreground">
						<input type="checkbox" class="mt-1" .checked=${isFreeModeOn()} @change=${(e: Event) => this.toggleFree(e)} />
						<span>Use the best free model (OpenRouter)</span>
					</label>
					<p class="text-xs text-muted-foreground">
						Runs on OpenRouter's free models, ranked by how well they do Tabkyra's browser tasks, with the next ones
						as fallbacks when one is rate-limited. Free models never cost money, need a free OpenRouter key, and are
						limited per day. ${FREE_PRIVACY_NOTE}
					</p>
				</div>
				<div>
					<h3 class="text-sm font-semibold text-foreground mb-2">API Keys</h3>
					<p class="text-sm text-muted-foreground mb-2">
						Enter API keys for cloud providers. Keys are stored locally in your browser.
					</p>
					<p class="text-sm text-muted-foreground mb-3">${API_BILLING_NOTE}</p>
					${agentSetupPromptButton("Using your own agent instead? Paste this prompt into Claude Code, Codex, pi, OMP or any agent to connect it to this browser.")}
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
