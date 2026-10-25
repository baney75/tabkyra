import { i18n } from "@mariozechner/mini-lit/dist/i18n.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import "../utils/i18n-extension.js";

@customElement("about-tab")
export class AboutTab extends SettingsTab {
	getTabName(): string {
		return i18n("About");
	}

	render(): TemplateResult {
		const version = chrome.runtime.getManifest().version;

		return html`
			<div class="flex flex-col gap-4">
				<div class="space-y-2">
					<h3 class="text-lg font-semibold text-foreground">Tabkyra</h3>
					<p class="text-sm text-muted-foreground">${i18n("AI-powered browser extension for web navigation and interaction")}</p>
				</div>

				<div class="text-sm">
					<span class="font-medium text-foreground">${i18n("Version:")}</span>
					<span class="text-muted-foreground ml-2">${version}</span>
				</div>

				<p class="text-xs text-muted-foreground">
					Built on Sitegeist by Mario Zechner and the agent bridge by 0xSero. AGPL-3.0.
				</p>

				<div class="text-xs text-muted-foreground space-x-3">
					<a href="https://github.com/baney75/tabkyra" target="_blank" class="text-primary hover:underline">Tabkyra</a>
					<span>·</span>
					<a href="https://github.com/badlogic/sitegeist" target="_blank" class="text-primary hover:underline">Sitegeist</a>
					<span>·</span>
					<a href="https://github.com/0xSero/sitegeist" target="_blank" class="text-primary hover:underline">0xSero fork</a>
				</div>
			</div>
		`;
	}
}
