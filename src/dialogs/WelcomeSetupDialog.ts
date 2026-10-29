import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { html } from "lit";
import { agentSetupPromptButton } from "../components/AgentSetupPrompt.js";
import { helmMark } from "../components/HelmMark.js";
import { BUG_REPORTS_KEY } from "../privacy/bug-reports.js";
import { setBugReports } from "../privacy/capture.js";
import { getTabkyraStorage } from "../storage/app-storage.js";

/**
 * Shown on first launch when no API keys are configured.
 * Blocks until user clicks OK, then opens the API Keys settings.
 */
export class WelcomeSetupDialog extends DialogBase {
	private resolvePromise?: () => void;

	protected modalWidth = "min(450px, 90vw)";
	protected modalHeight = "auto";

	/** Bug reports were already on (turned on earlier in Settings > Privacy). */
	private reportsOn = false;

	static async show(): Promise<void> {
		const reportsOn = (await getTabkyraStorage().settings.get<boolean>(BUG_REPORTS_KEY)) === true;
		return new Promise((resolve) => {
			const dialog = new WelcomeSetupDialog();
			dialog.reportsOn = reportsOn;
			dialog.resolvePromise = resolve;
			dialog.open();
		});
	}

	override close() {
		super.close();
		this.resolvePromise?.();
	}

	protected renderContent() {
		return html`
			${DialogContent({
				className: "flex flex-col gap-4",
				children: html`
					${helmMark(40, "tile", "rounded-[9px]")}
					${DialogHeader({
						title: "Welcome to Tabkyra",
					})}
					<p class="text-sm text-foreground">
						To chat in this side panel, add an API key for at least one AI provider. API use is billed
						by the provider.
					</p>
					${agentSetupPromptButton("To let your own agent drive this browser, paste this prompt into Claude Code, Codex, pi, OMP or any agent. It needs no API key here.")}
					${
						this.reportsOn
							? html`<p class="text-xs text-muted-foreground">Error reports are on. Turn them off in Settings &gt; Privacy.</p>`
							: html`<label class="flex items-start justify-between gap-3 text-xs text-muted-foreground cursor-pointer">
									<span>Keep error reports I can choose to send (optional, off by default; Settings &gt; Privacy)</span>
									<input
										type="checkbox"
										role="switch"
										class="tk-switch"
										@change=${(e: Event) => void setBugReports(getTabkyraStorage(), (e.target as HTMLInputElement).checked)}
									/>
								</label>`
					}
					<div class="flex justify-end">
						${Button({
							variant: "default",
							onClick: () => this.close(),
							children: "Set up provider",
						})}
					</div>
				`,
			})}
		`;
	}
}

if (!customElements.get("welcome-setup-dialog")) {
	customElements.define("welcome-setup-dialog", WelcomeSetupDialog);
}
