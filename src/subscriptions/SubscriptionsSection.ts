import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { request, type SubscriptionStatus, subscriptionStatus } from "./client.js";
import { CLI_MCP_SETUP, COPILOT, SIWC } from "./constants.js";
import { refreshSubscriptionModels } from "./stream.js";

/** chrome.storage.local flag: the "You're using your ChatGPT plan" note was shown once (no token in it). */
export const CHATGPT_WELCOME_KEY = "tabkyra.chatgptPlanWelcomeShown";

/**
 * Settings: the two subscription sign-ins Tabkyra offers, and how to use a Claude or Gemini
 * subscription instead (run that CLI with Tabkyra's MCP server; their terms forbid a sign-in here).
 * Self-contained so it drops into whichever settings tab lists providers.
 */
@customElement("tabkyra-subscriptions")
export class SubscriptionsSection extends LitElement {
	@state() private status?: SubscriptionStatus;
	@state() private error?: string;
	@state() private busy?: "chatgpt" | "copilot";
	@state() private deviceCode?: { userCode: string; verificationUri: string };
	@state() private welcome = false;
	@state() private notice?: string;
	@state() private copied?: string;

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		void this.load();
	}

	private async load(): Promise<void> {
		try {
			this.status = await subscriptionStatus(true);
			this.error = undefined;
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		}
	}

	private async signInChatGpt(): Promise<void> {
		this.busy = "chatgpt";
		this.notice = undefined;
		try {
			const result = await request<{ planUsage: boolean; firstPlanUsage?: boolean }>(
				"chatgpt.signin",
				(progress) => {
					// The sign-in page opens in a normal tab of this browser; the host's loopback listener gets the callback.
					if (
						typeof progress.authorizeUrl === "string" &&
						progress.authorizeUrl.startsWith(`${SIWC.authorizeUrl}?`)
					)
						void chrome.tabs.create({ url: progress.authorizeUrl, active: true });
				},
			);
			if (!result.planUsage)
				this.notice =
					"Signed in, but ChatGPT plan usage wasn't allowed. Choose Continue with ChatGPT again to allow it, or add an OpenAI API key.";
			if (result.firstPlanUsage) {
				const seen = await chrome.storage.local.get(CHATGPT_WELCOME_KEY);
				if (!seen[CHATGPT_WELCOME_KEY]) this.welcome = true;
			}
			await refreshSubscriptionModels();
		} catch (err) {
			this.notice = err instanceof Error ? err.message : String(err);
		}
		this.busy = undefined;
		await this.load();
	}

	private async signInCopilot(): Promise<void> {
		this.busy = "copilot";
		this.notice = undefined;
		try {
			await request("copilot.signin", (progress) => {
				if (typeof progress.userCode === "string" && typeof progress.verificationUri === "string") {
					this.deviceCode = { userCode: progress.userCode, verificationUri: progress.verificationUri };
					if (progress.verificationUri.startsWith("https://github.com/"))
						void chrome.tabs.create({ url: progress.verificationUri, active: true });
				}
			});
			await refreshSubscriptionModels();
		} catch (err) {
			this.notice = err instanceof Error ? err.message : String(err);
		}
		this.deviceCode = undefined;
		this.busy = undefined;
		await this.load();
	}

	private async cancel(which: "chatgpt" | "copilot"): Promise<void> {
		await request(`${which}.cancel`).catch(() => undefined);
	}

	private async signOut(which: "chatgpt" | "copilot"): Promise<void> {
		this.notice = undefined;
		try {
			const result = await request<{ revoked: boolean; revokeUrl?: string }>(`${which}.signout`);
			if (which === "chatgpt" && !result.revoked)
				this.notice =
					"Signed out here, but OpenAI didn't confirm the session was revoked. You can disconnect Tabkyra in ChatGPT Settings.";
			if (which === "copilot")
				this.notice = `Signed out: the token is deleted from this computer. To remove Tabkyra's access on GitHub too, revoke it at ${COPILOT.revokeUrl}.`;
			await refreshSubscriptionModels();
		} catch (err) {
			this.notice = err instanceof Error ? err.message : String(err);
		}
		await this.load();
	}

	private async dismissWelcome(): Promise<void> {
		this.welcome = false;
		await chrome.storage.local.set({ [CHATGPT_WELCOME_KEY]: true });
	}

	private copy(text: string): void {
		void navigator.clipboard.writeText(text).then(() => {
			this.copied = text;
			setTimeout(() => {
				if (this.copied === text) this.copied = undefined;
			}, 1500);
		});
	}

	/** One shell command the user pastes into a terminal: labeled, monospace, with its own copy button. */
	private command(label: string, text: string): TemplateResult {
		return html`
			<div class="flex flex-col gap-1">
				<div class="flex items-center justify-between gap-2">
					<span class="text-xs font-medium text-muted-foreground">${label}</span>
					<button
						type="button"
						class="rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
						aria-label=${`Copy the ${label} command`}
						@click=${() => this.copy(text)}
					>
						${this.copied === text ? "Copied" : "Copy"}
					</button>
				</div>
				<code class="block rounded-md border border-border bg-muted px-2.5 py-2 text-foreground font-mono text-xs leading-5 break-words select-all">${text}</code>
			</div>
		`;
	}

	private row(opts: {
		title: string;
		note: TemplateResult;
		signedIn: boolean;
		who?: string;
		button: string;
		which: "chatgpt" | "copilot";
		onSignIn: () => void;
		extra?: TemplateResult | typeof nothing;
	}): TemplateResult {
		const busy = this.busy === opts.which;
		return html`
			<div class="flex flex-col gap-2 rounded-md border border-border p-3" data-subscription=${opts.which}>
				<div class="flex items-center justify-between gap-2">
					<span class="text-sm font-medium text-foreground">${opts.title}</span>
					${
						opts.signedIn
							? html`<span class="text-xs text-muted-foreground">Signed in${opts.who ? html` as ${opts.who}` : nothing}</span>`
							: nothing
					}
				</div>
				<p class="text-xs text-muted-foreground">${opts.note}</p>
				${opts.extra ?? nothing}
				<div class="flex gap-2">
					${
						opts.signedIn
							? Button({
									size: "sm",
									variant: "outline",
									children: "Sign out",
									onClick: () => void this.signOut(opts.which),
								})
							: busy
								? Button({
										size: "sm",
										variant: "outline",
										children: "Cancel",
										onClick: () => void this.cancel(opts.which),
									})
								: Button({
										size: "sm",
										variant: "default",
										children: opts.button,
										onClick: opts.onSignIn,
										disabled: Boolean(this.busy) || !this.status,
									})
					}
				</div>
			</div>
		`;
	}

	override render(): TemplateResult {
		const s = this.status;
		const link = (href: string, text: string) =>
			html`<a class="underline" href=${href} target="_blank" rel="noopener">${text}</a>`;
		return html`
			<div class="flex flex-col gap-3">
				<div>
					<h3 class="text-sm font-semibold text-foreground mb-1">Use your subscription</h3>
					<p class="text-xs text-muted-foreground">
						Your tokens stay on this computer, in files only you can read. The browser never holds them.
					</p>
				</div>
				${
					this.error
						? html`<p class="text-xs text-destructive">Subscription sign-ins need Tabkyra's native host: run <code>tabkyra setup</code>. (${this.error})</p>`
						: nothing
				}
				${
					this.welcome
						? html`<div class="rounded-md border border-border p-3 flex flex-col gap-2" role="dialog" aria-label="You're using your ChatGPT plan">
								<span class="text-sm font-medium">You're using your ChatGPT plan</span>
								<span class="text-xs text-muted-foreground">Eligible usage in this app uses your ChatGPT plan. Manage usage in your ${link(SIWC.usageUrl, "ChatGPT settings")}.</span>
								<div>${Button({ size: "sm", variant: "default", children: "Got it", onClick: () => void this.dismissWelcome() })}</div>
							</div>`
						: nothing
				}
				${this.row({
					title: "ChatGPT plan",
					which: "chatgpt",
					button: "Continue with ChatGPT",
					signedIn: Boolean(s?.chatgpt.signedIn),
					who: s?.chatgpt.email,
					onSignIn: () => void this.signInChatGpt(),
					note: html`Uses your own ChatGPT plan; allowed by ${link(SIWC.termsUrl, "OpenAI's terms for open-source apps")}; sign out anytime. ${link(SIWC.usageUrl, "Manage usage")}`,
					extra:
						s?.chatgpt.signedIn && !s.chatgpt.planUsage
							? html`<p class="text-xs text-muted-foreground">ChatGPT plan usage isn't enabled for this sign-in. Sign out and choose Continue with ChatGPT to allow it, or use an OpenAI API key.</p>`
							: nothing,
				})}
				${this.row({
					title: "GitHub Copilot plan",
					which: "copilot",
					button: "Sign in with GitHub Copilot",
					signedIn: Boolean(s?.copilot.signedIn),
					who: s?.copilot.login,
					onSignIn: () => void this.signInCopilot(),
					note: html`Uses your own Copilot plan through GitHub's Copilot SDK; allowed by ${link(COPILOT.termsUrl, "GitHub's Copilot SDK docs")}; sign out anytime.`,
					extra: html`${
						this.deviceCode
							? html`<p class="text-xs">Enter <code class="font-semibold" data-device-code>${this.deviceCode.userCode}</code> at ${link(this.deviceCode.verificationUri, this.deviceCode.verificationUri)}
									${Button({ size: "sm", variant: "ghost", children: "Copy code", onClick: () => this.copy(this.deviceCode?.userCode ?? "") })}</p>`
							: nothing
					}${
						s && !s.copilot.sdkInstalled
							? html`<p class="text-xs text-muted-foreground">Copilot needs GitHub's Copilot SDK on this computer (about 160 MB): run <code>tabkyra copilot-sdk install</code>.</p>`
							: nothing
					}`,
				})}
				<div class="flex flex-col gap-2 rounded-md border border-border p-3" data-subscription="cli">
					<span class="text-sm font-medium text-foreground">Claude and Gemini</span>
					<p class="text-xs text-muted-foreground">
						Use your Claude Code or Gemini CLI subscription by running it with Tabkyra's MCP server. Anthropic's and Google's
						terms don't allow other apps to sign in with those plans, so Tabkyra doesn't.
					</p>
					${this.command("Claude Code", CLI_MCP_SETUP.claude)}
					${this.command("Gemini CLI", CLI_MCP_SETUP.gemini)}
				</div>
				${this.notice ? html`<p class="text-xs text-muted-foreground" role="status">${this.notice}</p>` : nothing}
			</div>
		`;
	}
}
