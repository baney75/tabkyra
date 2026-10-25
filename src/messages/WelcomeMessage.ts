import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentInterface, MessageRenderer } from "@mariozechner/pi-web-ui";
import { registerMessageRenderer } from "@mariozechner/pi-web-ui";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { helmMark } from "../components/HelmMark.js";

export interface TutorialPrompt {
	label: string;
	prompt: string;
}

export interface WelcomeMessage {
	role: "welcome";
	tutorials: TutorialPrompt[];
}

declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		welcome: WelcomeMessage;
	}
}

@customElement("welcome-message")
export class WelcomeMessageElement extends LitElement {
	@property({ type: Array }) tutorials!: TutorialPrompt[];
	@property({ attribute: false }) agent!: Agent;
	@property({ attribute: false }) agentInterface!: AgentInterface;
	@property({ attribute: false }) message!: WelcomeMessage;

	protected createRenderRoot() {
		return this;
	}

	private async selectTutorial(prompt: string) {
		// Remove this welcome message
		const messages = this.agent.state.messages.filter((m) => m !== this.message);
		this.agent.replaceMessages(messages);

		// Send tutorial prompt
		await this.agentInterface.sendMessage(prompt);
	}

	override render(): TemplateResult {
		return html`
			<div class="welcome-container my-10 flex flex-col items-center justify-center">
				<div class="flex flex-col items-center text-center mb-8 px-6">
					${helmMark(72, "tile", "mb-5 rounded-[17px] shadow-[0_10px_30px_-12px_rgba(227,169,59,0.55)]")}
					<h1 class="text-3xl font-semibold tracking-tight mb-2">Tabkyra</h1>
					<p class="text-base text-muted-foreground max-w-xs">You steer. Tabkyra works the tabs.</p>
				</div>

				<!-- Tutorial pills -->
				<div class="flex flex-wrap gap-3 justify-center max-w-lg px-6 mt-4">
					${this.tutorials.map(
						(tutorial, index) => html`
							<button
								class="tutorial-pill px-6 py-3 text-sm font-medium text-foreground rounded-full cursor-pointer"
								@click=${() => this.selectTutorial(tutorial.prompt)}
								style="animation-delay: ${index * 0.1}s;"
							>
								${tutorial.label}
							</button>
						`,
					)}
				</div>
			</div>
		`;
	}
}

export function createWelcomeRenderer(agent: Agent, agentInterface: AgentInterface): MessageRenderer<WelcomeMessage> {
	return {
		render: (message) => {
			// Only show if no conversation started yet
			const hasConversation = agent.state.messages.some((m) => m.role === "user" || m.role === "assistant");

			if (hasConversation) return html``;

			return html`<welcome-message
				.tutorials=${message.tutorials}
				.agent=${agent}
				.agentInterface=${agentInterface}
				.message=${message}
			></welcome-message>`;
		},
	};
}

export function registerWelcomeRenderer(agent: Agent, agentInterface: AgentInterface) {
	registerMessageRenderer("welcome", createWelcomeRenderer(agent, agentInterface));
}

export function createWelcomeMessage(tutorials: TutorialPrompt[]): WelcomeMessage {
	return { role: "welcome", tutorials };
}
