/**
 * Updates under the side panel header: "Update available" with an Update now button, the
 * progress of a running update, a version-mismatch banner with its one-click fix, and a
 * dismissible "What's new" card after an update reloads Tabkyra. The native host reports the
 * status (update_status) and each step (update_progress); the service worker relays the buttons
 * (src/update/worker.ts). Settings > Updates (src/dialogs/UpdatesTab.ts) reads the same state.
 */

import { html, nothing, type TemplateResult } from "lit";
import {
	type HostUpdateProgress,
	type HostUpdateStatus,
	UPDATE_PROGRESS_KEY,
	UPDATE_STATUS_KEY,
} from "../bridge/protocol.js";
import { BUILD } from "../update/build.js";
import { PANEL_UPDATE_MESSAGE, safeLink, type UpdateAction, whatsNewFor } from "../update/logic.js";

const DISMISSED_KEY = "tabkyra.updateDismissed";
const WHATS_NEW_DISMISSED_KEY = "tabkyra.whatsNewDismissed";
const PROGRESS_DISMISSED_KEY = "tabkyra.updateProgressDismissed";

export interface UpdateState {
	status?: HostUpdateStatus;
	progress?: HostUpdateProgress;
	/** The version whose "Update available" the user hid. */
	dismissed?: string;
	whatsNewDismissed?: string;
	progressDismissedAt?: number;
}

export const updateState: UpdateState = {};
const listeners = new Set<() => void>();
let watching = false;

const KEYS = [UPDATE_STATUS_KEY, UPDATE_PROGRESS_KEY, DISMISSED_KEY, WHATS_NEW_DISMISSED_KEY, PROGRESS_DISMISSED_KEY];

function apply(values: Record<string, unknown>): void {
	if (UPDATE_STATUS_KEY in values) updateState.status = values[UPDATE_STATUS_KEY] as HostUpdateStatus | undefined;
	if (UPDATE_PROGRESS_KEY in values)
		updateState.progress = values[UPDATE_PROGRESS_KEY] as HostUpdateProgress | undefined;
	if (DISMISSED_KEY in values) updateState.dismissed = values[DISMISSED_KEY] as string | undefined;
	if (WHATS_NEW_DISMISSED_KEY in values)
		updateState.whatsNewDismissed = values[WHATS_NEW_DISMISSED_KEY] as string | undefined;
	if (PROGRESS_DISMISSED_KEY in values)
		updateState.progressDismissedAt = values[PROGRESS_DISMISSED_KEY] as number | undefined;
}

/** Load the stored state and call `onChange` whenever the host or the worker updates it. */
export async function watchUpdateStatus(onChange: () => void): Promise<() => void> {
	listeners.add(onChange);
	if (!watching) {
		watching = true;
		apply(await chrome.storage.local.get(KEYS));
		chrome.storage.onChanged.addListener((changes, area) => {
			if (area !== "local" || !KEYS.some((k) => k in changes)) return;
			apply(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.newValue])));
			for (const l of listeners) l();
		});
	}
	onChange();
	return () => listeners.delete(onChange);
}

/** Ask the service worker to run an update action, or to reload once idle. */
export function requestUpdate(action: UpdateAction | "reload"): void {
	void chrome.runtime.sendMessage({ type: PANEL_UPDATE_MESSAGE, action }).catch(() => undefined);
}

const PHASE_LABEL: Record<HostUpdateProgress["phase"], string> = {
	checking: "Checking",
	downloading: "Downloading",
	verifying: "Verifying",
	pulling: "Pulling",
	installing: "Installing",
	building: "Building",
	skills: "Skills",
	waiting: "Waiting",
	reloading: "Reloading",
	done: "Done",
	failed: "Failed",
};

/** An update step that is still going (stale ones count as over). */
export function updateRunning(progress = updateState.progress): boolean {
	return !!progress && !["done", "failed"].includes(progress.phase) && Date.now() - progress.at < 30 * 60 * 1000;
}

export function phaseLabel(phase: HostUpdateProgress["phase"]): string {
	return PHASE_LABEL[phase] ?? phase;
}

const bar = "flex items-start gap-2 px-3 py-1.5 text-xs border-b border-border shrink-0";
const link =
	"shrink-0 underline decoration-border underline-offset-2 hover:decoration-current text-foreground disabled:opacity-50";

function progressLine(): TemplateResult | typeof nothing {
	const p = updateState.progress;
	if (!p || p.action.startsWith("policy-")) return nothing;
	const recentDone = p.phase === "done" && Date.now() - p.at < 20000;
	const failed = p.phase === "failed" && p.at > (updateState.progressDismissedAt ?? 0);
	if (!updateRunning(p) && !recentDone && !failed) return nothing;
	return html`<div
		class="${bar} ${failed ? "text-destructive" : "text-muted-foreground"}"
		role="status"
		aria-live="polite"
		data-testid="update-progress"
		data-phase=${p.phase}
	>
		<span class="shrink-0 font-medium">${phaseLabel(p.phase)}</span>
		<span class="min-w-0 whitespace-pre-wrap break-words">${p.message}</span>
		${
			failed
				? html`<button
						class="ml-auto shrink-0 hover:text-foreground"
						aria-label="Dismiss"
						@click=${() => chrome.storage.local.set({ [PROGRESS_DISMISSED_KEY]: Date.now() })}
					>
						✕
					</button>`
				: nothing
		}
	</div>`;
}

function mismatchBanner(): TemplateResult | typeof nothing {
	const m = updateState.status?.mismatch;
	if (!m || updateRunning()) return nothing;
	return html`<div class="${bar} text-foreground" role="alert" data-testid="update-mismatch">
		<span class="min-w-0">${m.reason}</span>
		<button class="${link} ml-auto" @click=${() => requestUpdate(m.fix === "reload" ? "reload" : "reinstall")}>
			${m.fix === "reload" ? "Reload Tabkyra" : "Re-run install"}
		</button>
	</div>`;
}

function availableLine(): TemplateResult | typeof nothing {
	const s = updateState.status;
	if (!s?.available || updateRunning() || s.mismatch) return nothing;
	const label =
		s.mode === "checkout"
			? s.behind
				? `${s.behind} new commit${s.behind === 1 ? "" : "s"} on main`
				: "a build of the current checkout"
			: (s.latest ?? "");
	const key = s.latest ?? s.current;
	if (updateState.dismissed === key) return nothing;
	return html`<div class="${bar} text-muted-foreground" role="status" data-testid="update-notice">
		<span class="min-w-0 truncate" title=${s.blocked ?? ""}>Update available: ${label}${s.policy === "auto" && !s.blocked ? ". Installs when idle" : ""}</span>
		<button
			class="${link} ml-auto"
			?disabled=${!!s.blocked}
			title=${s.blocked ?? "Install it now; Tabkyra reloads when no agent is running"}
			@click=${() => requestUpdate("update")}
		>
			Update now
		</button>
		<button
			class="shrink-0 hover:text-foreground"
			title="Hide until the next version"
			aria-label="Dismiss update notice"
			@click=${() => chrome.storage.local.set({ [DISMISSED_KEY]: key })}
		>
			✕
		</button>
	</div>`;
}

function whatsNewCard(): TemplateResult | typeof nothing {
	const last = whatsNewFor(updateState.status?.lastUpdate, updateState.whatsNewDismissed, BUILD?.id);
	if (!last) return nothing;
	const url = safeLink(last.url);
	const more = (last.totalCommits ?? 0) - (last.commits?.length ?? 0);
	const skipped = last.skills?.skipped ?? [];
	return html`<section
		class="mx-3 my-2 rounded-lg border border-border bg-card p-3 text-xs space-y-2 shrink-0 max-h-64 overflow-y-auto"
		aria-label="What's new"
		data-testid="whats-new"
	>
		<div class="flex items-center gap-2">
			<span class="text-sm font-semibold text-foreground">What's new in ${last.to}</span>
			<button
				class="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
				aria-label="Dismiss what's new"
				@click=${() => chrome.storage.local.set({ [WHATS_NEW_DISMISSED_KEY]: last.id })}
			>
				✕
			</button>
		</div>
		${last.notes ? html`<p class="whitespace-pre-wrap text-muted-foreground">${last.notes}</p>` : nothing}
		${
			last.commits?.length
				? html`<ul class="list-disc pl-4 space-y-0.5 text-muted-foreground">
						${last.commits.map((c) => html`<li><span class="text-foreground">${c.subject}</span> <span class="font-mono">${c.sha.slice(0, 7)}</span></li>`)}
					</ul>
					${more > 0 ? html`<p class="text-muted-foreground">and ${more} more</p>` : nothing}`
				: nothing
		}
		${url ? html`<a class="underline underline-offset-2 text-foreground" href=${url} target="_blank" rel="noopener">${last.mode === "checkout" ? "Compare on GitHub" : "Release page"}</a>` : nothing}
		${
			skipped.length
				? html`<p class="text-muted-foreground">
						Skills left alone because you edited them: ${skipped.map((s) => s.skill).join(", ")}. Run
						<code class="font-mono">tabkyra skill install &lt;name&gt; --force</code> to replace one.
					</p>`
				: nothing
		}
	</section>`;
}

/** Everything update-related under the header; nothing when there is nothing to say. */
export function updateNotice(): TemplateResult {
	return html`${progressLine()}${mismatchBanner()}${availableLine()}${whatsNewCard()}`;
}
