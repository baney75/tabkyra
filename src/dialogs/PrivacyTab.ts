import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { BUG_LOG_KEY, BUG_REPORTS_KEY, type BugEntry, issueUrl } from "../privacy/bug-reports.js";
import { PRIVATE_MODE_KEY } from "../privacy/private-mode.js";
import { getTabkyraStorage } from "../storage/app-storage.js";

/** Settings > Privacy: private mode and opt-in bug reports. */
@customElement("tabkyra-privacy-tab")
export class PrivacyTab extends SettingsTab {
	@state() private privateMode = false;
	@state() private bugReports = false;
	@state() private log: BugEntry[] = [];

	getTabName(): string {
		return "Privacy";
	}

	override async connectedCallback() {
		super.connectedCallback();
		const settings = getTabkyraStorage().settings;
		this.privateMode = (await settings.get<boolean>(PRIVATE_MODE_KEY)) === true;
		this.bugReports = (await settings.get<boolean>(BUG_REPORTS_KEY)) === true;
		this.log = (await settings.get<BugEntry[]>(BUG_LOG_KEY)) ?? [];
	}

	private async set(key: string, value: boolean) {
		await getTabkyraStorage().settings.set(key, value);
		if (key === PRIVATE_MODE_KEY) this.privateMode = value;
		if (key === BUG_REPORTS_KEY) {
			this.bugReports = value;
			if (!value) {
				await getTabkyraStorage().settings.set(BUG_LOG_KEY, []);
				this.log = [];
			}
		}
	}

	render(): TemplateResult {
		const version = chrome.runtime.getManifest().version;
		return html`
			<div class="flex flex-col gap-6">
				<div class="space-y-2">
					<h3 class="text-sm font-semibold text-foreground">Private mode</h3>
					<label class="flex items-start gap-2 text-sm text-foreground">
						<input
							type="checkbox"
							class="mt-1"
							.checked=${this.privateMode}
							@change=${(e: Event) => this.set(PRIVATE_MODE_KEY, (e.target as HTMLInputElement).checked)}
						/>
						<span>Only use models that don't keep my prompts</span>
					</label>
					<p class="text-xs text-muted-foreground">
						The side panel agent then runs only OpenRouter models, sent with zero data retention required and no
						fallback to other endpoints, and models on this computer or your own network (Custom Providers). Other
						providers are refused. This covers the side panel agent; an outside agent using the Bridge follows its own
						settings.
					</p>
				</div>

				<div class="space-y-2">
					<h3 class="text-sm font-semibold text-foreground">Bug reports</h3>
					<label class="flex items-start gap-2 text-sm text-foreground">
						<input
							type="checkbox"
							class="mt-1"
							.checked=${this.bugReports}
							@change=${(e: Event) => this.set(BUG_REPORTS_KEY, (e.target as HTMLInputElement).checked)}
						/>
						<span>Keep error reports so I can send them</span>
					</label>
					<p class="text-xs text-muted-foreground">
						Optional and off by default. Errors are kept in this browser with page addresses, emails and keys removed.
						Nothing is sent unless you open a report below and submit it on GitHub yourself.
					</p>
					${
						this.bugReports
							? html`<div class="flex items-center gap-3">
									${Button({
										size: "sm",
										variant: "secondary",
										disabled: this.log.length === 0,
										onClick: () =>
											window.open(issueUrl(version, this.log, navigator.userAgent), "_blank", "noopener"),
										children: "Review and send a report",
									})}
									<span class="text-xs text-muted-foreground">${this.log.length} error${this.log.length === 1 ? "" : "s"} kept</span>
								</div>`
							: ""
					}
				</div>
			</div>
		`;
	}
}
