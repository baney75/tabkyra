import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import { html, LitElement, type TemplateResult } from "lit";
import { ArrowLeft } from "lucide";

/** Open pages, oldest first. Esc and the back arrow close only the newest. */
const stack: PageBase[] = [];

/**
 * A screen that fills the side panel, with a back arrow and a title, in place of a floating
 * dialog (Donovan, 2026-10-29: "full screen with a back arrow, NOT a weird overlay thing").
 * Settings, a skill's details, saving a recording as a skill and the custom provider editor use
 * it. A page opened from another page sits on top of it, and going back returns to the one below.
 */
export abstract class PageBase extends LitElement {
	private previousFocus?: Element | null;
	private resolveClosed!: () => void;
	/** Settles when the page closes, by the back arrow, Esc or close(). */
	readonly closed = new Promise<void>((resolve) => {
		this.resolveClosed = resolve;
	});

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	/** The title in the page's top bar. */
	protected abstract pageTitle(): string;
	/** The page's content. The page scrolls it unless it fills the height itself (fillsHeight). */
	protected abstract renderContent(): TemplateResult;
	/** True when renderContent lays out its own scrolling area and footer. */
	protected fillsHeight = false;

	open() {
		this.previousFocus = document.activeElement;
		stack.push(this);
		if (stack.length === 1) window.addEventListener("keydown", onKeyDown);
		document.body.appendChild(this);
		void this.updateComplete.then(() => {
			// Keyboard focus moves into the page unless its content already took it (Settings
			// focuses its provider search).
			if (!this.contains(document.activeElement)) this.querySelector<HTMLElement>("[data-page-back]")?.focus();
		});
	}

	close() {
		const at = stack.indexOf(this);
		if (at >= 0) stack.splice(at, 1);
		if (stack.length === 0) window.removeEventListener("keydown", onKeyDown);
		this.remove();
		this.resolveClosed();
		const back = this.previousFocus;
		if (back instanceof HTMLElement && back.isConnected) requestAnimationFrame(() => back.focus());
	}

	override render() {
		const titleId = `${this.localName}-title`;
		return html`
			<div class="fixed inset-0 z-40 flex flex-col bg-background text-foreground" role="dialog" aria-modal="true" aria-labelledby=${titleId}>
				<header class="flex h-12 flex-shrink-0 items-center gap-1 border-b border-border px-2">
					<button
						type="button"
						data-page-back
						aria-label="Back"
						title="Back"
						class="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						@click=${() => this.close()}
					>
						${icon(ArrowLeft, "md")}
					</button>
					<h2 id=${titleId} class="min-w-0 truncate text-base font-semibold">${this.pageTitle()}</h2>
				</header>
				${
					this.fillsHeight
						? html`<div class="flex min-h-0 flex-1 flex-col">${this.renderContent()}</div>`
						: html`<div class="tk-page-body min-h-0 flex-1 overflow-y-auto">${this.renderContent()}</div>`
				}
			</div>
		`;
	}
}

function onKeyDown(e: KeyboardEvent) {
	if (e.key !== "Escape" || e.defaultPrevented) return;
	const top = stack.at(-1);
	if (!top) return;
	// A dialog opened over the page (the API key prompt, the model picker) closes first, by its own
	// Esc handler.
	for (let el = top.nextElementSibling; el; el = el.nextElementSibling) {
		if (el.querySelector(".fixed.inset-0, [role=dialog]")) return;
	}
	e.preventDefault();
	top.close();
}
