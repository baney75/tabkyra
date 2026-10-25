import { html, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { HELM_ICON, HELM_MARK } from "./helm-svg.js";

/** The Tabkyra helm. `tile` is the brass app icon; otherwise the bare mark in currentColor. */
export function helmMark(size: number, variant: "tile" | "mark" = "tile", className = ""): TemplateResult {
	return html`<span
		class="inline-block shrink-0 [&>svg]:block [&>svg]:w-full [&>svg]:h-full ${className}"
		style="width:${size}px;height:${size}px"
		aria-hidden="true"
		>${unsafeSVG(variant === "tile" ? HELM_ICON : HELM_MARK)}</span
	>`;
}
