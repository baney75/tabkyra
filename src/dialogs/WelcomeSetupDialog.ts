import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { html } from "lit";
import { agentSetupPromptButton } from "../components/AgentSetupPrompt.js";
import { helmMark } from "../components/HelmMark.js";

/**
 * Shown on first launch when no API keys are configured.
 * Blocks until user clicks OK, then opens the API Keys settings.
 */
export class WelcomeSetupDialog extends DialogBase {
	private resolvePromise?: () => void;

	protected modalWidth = "min(450px, 90vw)";
	protected modalHeight = "auto";

	static show(): Promise<void> {
		return new Promise((resolve) => {
			const dialog = new WelcomeSetupDialog();
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
