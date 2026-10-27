import { i18n } from "@mariozechner/mini-lit";
import { DownloadButton } from "@mariozechner/mini-lit/dist/DownloadButton.js";
import { ArtifactElement } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { mimeTypeFor } from "./preview/file-types.js";

@customElement("tk-image-artifact")
export class TkImageArtifact extends ArtifactElement {
	@property({ type: String }) private _content = "";

	get content(): string {
		return this._content;
	}

	set content(value: string) {
		this._content = value;
		this.requestUpdate();
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		this.style.height = "100%";
	}

	private getMimeType(): string {
		return mimeTypeFor(this.filename);
	}

	private getImageUrl(): string {
		// If content is already a data URL, use it directly
		if (this._content.startsWith("data:")) {
			return this._content;
		}
		// Otherwise assume it's base64 and construct data URL
		return `data:${this.getMimeType()};base64,${this._content}`;
	}

	private decodeBase64(): Uint8Array {
		let base64Data: string;

		// If content is a data URL, extract the base64 part
		if (this._content.startsWith("data:")) {
			const base64Match = this._content.match(/base64,(.+)/);
			if (base64Match) {
				base64Data = base64Match[1];
			} else {
				// Not a base64 data URL, return empty
				return new Uint8Array(0);
			}
		} else {
			// Otherwise use content as-is
			base64Data = this._content;
		}

		// Decode base64 to binary string
		const binaryString = atob(base64Data);

		// Convert binary string to Uint8Array
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}

		return bytes;
	}

	public getHeaderButtons() {
		return html`
			<div class="flex items-center gap-1">
				${DownloadButton({
					content: this.decodeBase64(),
					filename: this.filename,
					mimeType: this.getMimeType(),
					title: i18n("Download"),
				})}
			</div>
		`;
	}

	override render(): TemplateResult {
		return html`
			<div class="h-full flex flex-col bg-background overflow-auto">
				<div class="flex-1 flex items-center justify-center p-4">
					<img
						src="${this.getImageUrl()}"
						alt="${this.filename}"
						class="max-w-full max-h-full object-contain"
						@error=${(e: Event) => {
							const target = e.target as HTMLImageElement;
							target.src =
								"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext x='50' y='50' text-anchor='middle' dominant-baseline='middle' fill='%23999'%3EImage Error%3C/text%3E%3C/svg%3E";
						}}
					/>
				</div>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"tk-image-artifact": TkImageArtifact;
	}
}
