/**
 * A quiet one-line "Update available" under the side panel header. The native host
 * reports what `tabkyra update --check` found; nothing updates from here. The user
 * runs `tabkyra update`, or dismisses the notice for that version.
 */

import { html, type TemplateResult } from "lit";
import { type HostUpdateStatus, UPDATE_STATUS_KEY } from "../bridge/protocol.js";

const DISMISSED_KEY = "tabkyra.updateDismissed";

let status: HostUpdateStatus | undefined;
let dismissed: string | undefined;

/** Load the stored status and re-render when the host reports a new one. */
export async function watchUpdateStatus(onChange: () => void): Promise<void> {
	const stored = await chrome.storage.local.get([UPDATE_STATUS_KEY, DISMISSED_KEY]);
	status = stored[UPDATE_STATUS_KEY] as HostUpdateStatus | undefined;
	dismissed = stored[DISMISSED_KEY] as string | undefined;
	onChange();
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local") return;
		if (changes[UPDATE_STATUS_KEY]) status = changes[UPDATE_STATUS_KEY].newValue as HostUpdateStatus | undefined;
		if (changes[DISMISSED_KEY]) dismissed = changes[DISMISSED_KEY].newValue as string | undefined;
		if (changes[UPDATE_STATUS_KEY] || changes[DISMISSED_KEY]) onChange();
	});
}

/** The notice, or nothing when up to date, unknown, or dismissed for this version. */
export function updateNotice(): TemplateResult | string {
	if (!status?.available || !status.latest || dismissed === status.latest) return "";
	const latest = status.latest;
	return html`<div
		class="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground border-b border-border shrink-0"
		role="status"
		data-testid="update-notice"
	>
		<span class="min-w-0 truncate"
			>Update available: ${latest}. Run <code class="font-mono text-foreground">tabkyra update</code></span
		>
		<button
			class="ml-auto shrink-0 hover:text-foreground"
			title="Hide until the next version"
			aria-label="Dismiss update notice"
			@click=${() => chrome.storage.local.set({ [DISMISSED_KEY]: latest })}
		>
			✕
		</button>
	</div>`;
}
