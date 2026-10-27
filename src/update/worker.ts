/**
 * Updates in the service worker: forwards the side panel's buttons to the native host, installs a
 * staged update and reloads the extension once no agent is running, and runs automatic updates
 * when the setting says so. docs/updates.md describes the flow.
 *
 * An update builds or downloads first while anything may run ("update", "reinstall"). The steps
 * that change live files ("activate" a staged build, "rollback") run only when idle, and the
 * reload follows at once, after one more idle check. "Idle" (idleGate): no side panel with an
 * open port is mid-run (sidepanel_busy_<windowId>) and no bridge harness has a request going or
 * made one in the last 30 seconds. Automatic updates also wait for AUTO_UPDATE_QUIET_MS.
 */

import { bridgeActivity, onUpdateMessages, sendUpdateAction } from "../bridge/native.js";
import {
	type HostUpdateProgress,
	type HostUpdateStatus,
	UPDATE_PROGRESS_KEY,
	UPDATE_STATUS_KEY,
} from "../bridge/protocol.js";
import { BUILD, describeBuild } from "./build.js";
import {
	type ActivitySnapshot,
	AUTO_UPDATE_QUIET_MS,
	idleGate,
	offerKey,
	PANEL_UPDATE_MESSAGE,
	shouldAutoUpdate,
	UPDATE_ACTIONS,
	type UpdateAction,
} from "./logic.js";

/** The next step waiting for idle, kept across worker restarts (Pending). */
export const PENDING_KEY = "tabkyra.updatePending";
/** The offer an automatic update last sent. */
const AUTO_KEY = "tabkyra.autoUpdateAttempted";
/** When a side panel run last started or ended (storage.session). */
const LAST_PANEL_RUN_KEY = "tabkyra.lastPanelRunAt";
const BUSY_PREFIX = "sidepanel_busy_";
/** background.ts keeps the windows whose side panel port is connected here (storage.session). */
const OPEN_PANELS_KEY = "sidepanel_open_windows";
const AUTO_ALARM = "tabkyra-auto-update";
const WAIT_POLL_MS = 3000;
/** How long to wait for the host to answer an action before saying it didn't. */
const NO_REPLY_MS = 30000;
/** Nothing is known about activity before the worker started; automatic updates count from here. */
const WORKER_STARTED_AT = Date.now();

/**
 * run:    send `action` to the host once idle (activate a staged build, roll back).
 * sent:   sent; waiting for the host's done or failed.
 * reload: reload once idle (checked again immediately before chrome.runtime.reload()).
 */
interface Pending {
	step: "run" | "sent" | "reload";
	action: HostUpdateProgress["action"];
	extensionBuild?: string;
	/** Set right before chrome.runtime.reload(): the build that asked for it. */
	reloadedFrom?: string;
	at: number;
}

async function activity(): Promise<ActivitySnapshot> {
	const session = await chrome.storage.session.get(null);
	const open = new Set((session[OPEN_PANELS_KEY] as number[] | undefined) ?? []);
	// A flag counts only while that window's panel is connected: a panel that crashed mid-run
	// can't hold updates back forever.
	const busyPanels = Object.entries(session).filter(
		([key, value]) =>
			key.startsWith(BUSY_PREFIX) &&
			value !== false &&
			value !== null &&
			value !== undefined &&
			open.has(Number(key.slice(BUSY_PREFIX.length))),
	).length;
	return {
		now: Date.now(),
		busyPanels,
		lastPanelRunAt: Math.max(Number(session[LAST_PANEL_RUN_KEY] ?? 0), WORKER_STARTED_AT),
		bridge: bridgeActivity(),
	};
}

async function setProgress(
	action: HostUpdateProgress["action"],
	phase: HostUpdateProgress["phase"],
	message: string,
): Promise<void> {
	const current = (await chrome.storage.local.get(UPDATE_PROGRESS_KEY))[UPDATE_PROGRESS_KEY] as
		| HostUpdateProgress
		| undefined;
	// Don't rewrite an unchanged "waiting" line every few seconds.
	if (current && current.phase === phase && current.message === message && current.action === action) return;
	const progress: HostUpdateProgress = { type: "update_progress", action, phase, message, at: Date.now() };
	await chrome.storage.local.set({ [UPDATE_PROGRESS_KEY]: progress });
}

async function getPending(): Promise<Pending | undefined> {
	return (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] as Pending | undefined;
}

const setPending = (pending: Pending) => chrome.storage.local.set({ [PENDING_KEY]: pending });

let waitTimer: ReturnType<typeof setTimeout> | undefined;

function later(): void {
	if (waitTimer) clearTimeout(waitTimer);
	waitTimer = setTimeout(() => void advance(), WAIT_POLL_MS);
}

/** Take the next pending step if nothing runs; otherwise say what it waits for and look again. */
async function advance(): Promise<void> {
	waitTimer = undefined;
	const pending = await getPending();
	if (!pending || pending.step === "sent" || pending.reloadedFrom) return;
	const before = idleGate(await activity(), 0);
	if (!before.idle) {
		const what =
			pending.step === "reload"
				? "Reloading Tabkyra"
				: pending.action === "rollback"
					? "Rolling back"
					: "Ready. Installing";
		await setProgress(pending.action, "waiting", `${what} when no agent is running: ${before.reason}.`);
		later();
		return;
	}
	if (pending.step === "run") {
		if (!sendUpdateAction(pending.action as UpdateAction)) {
			await setProgress(pending.action, "waiting", "Waiting for the Tabkyra native host to connect.");
			later();
			return;
		}
		await setPending({ ...pending, step: "sent", at: Date.now() });
		await setProgress(pending.action, "installing", pending.action === "rollback" ? "Rolling back" : "Installing");
		return;
	}
	// Commit to the reload first, then check once more with nothing awaited between that check
	// and the reload: a run that started during the writes above is seen here.
	await setPending({ ...pending, reloadedFrom: BUILD?.id ?? "unknown" });
	await setProgress(pending.action, "reloading", "Reloading Tabkyra");
	const final = idleGate(await activity(), 0);
	if (!final.idle) {
		await setPending({ ...pending, reloadedFrom: undefined });
		await setProgress(pending.action, "waiting", `Reloading Tabkyra when no agent is running: ${final.reason}.`);
		later();
		return;
	}
	chrome.runtime.reload();
}

async function queue(step: Pending["step"], action: Pending["action"], extensionBuild?: string): Promise<void> {
	await setPending({ step, action, extensionBuild, at: Date.now() });
	await advance();
}

/** After a worker start: finish or report what was pending before it. */
async function resume(): Promise<void> {
	const pending = await getPending();
	if (!pending) return;
	if (pending.reloadedFrom) {
		await chrome.storage.local.remove(PENDING_KEY);
		if (pending.extensionBuild && BUILD?.id !== pending.extensionBuild && BUILD?.id === pending.reloadedFrom) {
			await setProgress(
				pending.action,
				"failed",
				"Tabkyra reloaded but still runs the old build, so the browser loads it from another folder. Check the folder on chrome://extensions.",
			);
			return;
		}
		await setProgress(pending.action, "done", `Tabkyra reloaded and runs ${describeBuild(BUILD)}.`);
		return;
	}
	if (pending.step === "sent") {
		// The host follows a running updater after a restart and reports its result; if nothing
		// comes, don't wait forever.
		setTimeout(() => void giveUpOnSent(pending.at), 2 * 60 * 1000);
		return;
	}
	await advance();
}

async function giveUpOnSent(at: number): Promise<void> {
	const pending = await getPending();
	if (pending?.step !== "sent" || pending.at !== at) return;
	await chrome.storage.local.remove(PENDING_KEY);
	await setProgress(
		pending.action,
		"failed",
		"No result from the native host. Open Settings > Updates to see the state and try again.",
	);
}

async function maybeAutoUpdate(): Promise<void> {
	const stored = await chrome.storage.local.get([UPDATE_STATUS_KEY, AUTO_KEY, UPDATE_PROGRESS_KEY, PENDING_KEY]);
	const status = stored[UPDATE_STATUS_KEY] as HostUpdateStatus | undefined;
	if (!status || !shouldAutoUpdate(status, stored[AUTO_KEY] as string | undefined)) return;
	if (stored[PENDING_KEY] || status.staged || status.updating) return;
	const progress = stored[UPDATE_PROGRESS_KEY] as HostUpdateProgress | undefined;
	const busy = progress && !["done", "failed"].includes(progress.phase) && Date.now() - progress.at < 30 * 60 * 1000;
	if (busy) return;
	if (!idleGate(await activity(), AUTO_UPDATE_QUIET_MS).idle) return;
	if (!sendUpdateAction("update")) return;
	// Only an offer actually sent counts as tried.
	await chrome.storage.local.set({ [AUTO_KEY]: offerKey(status) });
	await setProgress("update", "checking", "Updating automatically (Tabkyra is idle)");
}

async function onProgress(progress: HostUpdateProgress): Promise<void> {
	if (progress.phase === "done" && progress.staged) return queue("run", "activate");
	if (progress.phase === "done" && progress.reload) return queue("reload", progress.action, progress.extensionBuild);
	if (progress.phase === "done" || progress.phase === "failed") {
		const pending = await getPending();
		if (pending?.step === "sent" && pending.action === progress.action)
			await chrome.storage.local.remove(PENDING_KEY);
	}
}

/** Say so when the host never answers (a host older than this extension ignores the request). */
function expectReply(action: UpdateAction): void {
	const sentAt = Date.now();
	setTimeout(async () => {
		const p = (await chrome.storage.local.get(UPDATE_PROGRESS_KEY))[UPDATE_PROGRESS_KEY] as
			| HostUpdateProgress
			| undefined;
		if (p && p.action === action && p.at <= sentAt + 1000 && p.phase === "checking") {
			await setProgress(
				action,
				"failed",
				"The native host didn't answer. It may be older than this extension: update the CLI (tabkyra update, or rebuild cli/ in a checkout), then reload Tabkyra.",
			);
		}
	}, NO_REPLY_MS);
}

function onPanelMessage(
	message: unknown,
	sender: chrome.runtime.MessageSender,
	sendResponse: (response: { ok: boolean; message?: string }) => void,
): boolean | undefined {
	const m = message as { type?: unknown; action?: unknown } | null;
	if (!m || m.type !== PANEL_UPDATE_MESSAGE) return undefined;
	// Only Tabkyra's own pages, never a content script on a web page.
	if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
		sendResponse({ ok: false, message: "Refused" });
		return undefined;
	}
	// Steps that change live files wait for idle in the worker; the rest go to the host now.
	if (m.action === "reload") {
		void queue("reload", "reload");
		sendResponse({ ok: true });
		return undefined;
	}
	if (m.action === "install" || m.action === "rollback") {
		void queue("run", m.action === "install" ? "activate" : "rollback");
		sendResponse({ ok: true });
		return undefined;
	}
	if (
		typeof m.action !== "string" ||
		!(UPDATE_ACTIONS as readonly string[]).includes(m.action) ||
		m.action === "activate"
	) {
		sendResponse({ ok: false, message: "Unknown update action" });
		return undefined;
	}
	const action = m.action as UpdateAction;
	if (!sendUpdateAction(action)) {
		void setProgress(action, "failed", "The Tabkyra native host isn't connected. Run tabkyra doctor in a terminal.");
		sendResponse({ ok: false, message: "No native host" });
		return undefined;
	}
	if (!action.startsWith("policy-")) {
		void setProgress(action, "checking", action === "check" ? "Checking for updates" : "Starting");
		expectReply(action);
	}
	sendResponse({ ok: true });
	return undefined;
}

export function startUpdateWorker(): void {
	onUpdateMessages({
		status: () => void maybeAutoUpdate().catch(() => undefined),
		progress: (p) => void onProgress(p).catch(() => undefined),
	});
	chrome.runtime.onMessage.addListener(onPanelMessage);
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "session") return;
		if (Object.keys(changes).some((k) => k.startsWith(BUSY_PREFIX))) {
			void chrome.storage.session.set({ [LAST_PANEL_RUN_KEY]: Date.now() }).catch(() => undefined);
		}
	});
	chrome.alarms.create(AUTO_ALARM, { periodInMinutes: 1 });
	chrome.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === AUTO_ALARM) void maybeAutoUpdate().catch(() => undefined);
	});
	void resume().catch(() => undefined);
}
