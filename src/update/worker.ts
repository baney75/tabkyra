/**
 * Updates in the service worker: forwards the side panel's buttons to the native host, reloads
 * the extension after an update once no agent is running, and runs automatic updates when the
 * setting says so. docs/updates.md describes the flow.
 *
 * "No agent is running" (idleGate): no side panel is mid-run (sidepanel_busy_<windowId>) and no
 * bridge harness has a request going or made one in the last 30 seconds. Automatic updates also
 * wait for AUTO_UPDATE_QUIET_MS without any of that, and the gate is checked again right before
 * the reload.
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

/** A reload waiting for idle, kept across worker restarts: { extensionBuild?, action, reloadedFrom? }. */
const RELOAD_KEY = "tabkyra.reloadPending";
/** The offer an automatic update last tried. */
const AUTO_KEY = "tabkyra.autoUpdateAttempted";
/** When a side panel run last started or ended (storage.session). */
const LAST_PANEL_RUN_KEY = "tabkyra.lastPanelRunAt";
const BUSY_PREFIX = "sidepanel_busy_";
const AUTO_ALARM = "tabkyra-auto-update";
const WAIT_POLL_MS = 3000;
/** Nothing is known about activity before the worker started; automatic updates count from here. */
const WORKER_STARTED_AT = Date.now();

interface PendingReload {
	action: UpdateAction | "reload";
	extensionBuild?: string;
	/** Set right before chrome.runtime.reload(): the build that asked for it. */
	reloadedFrom?: string;
}

async function activity(): Promise<ActivitySnapshot> {
	const session = await chrome.storage.session.get(null);
	const busyPanels = Object.entries(session).filter(
		([key, value]) => key.startsWith(BUSY_PREFIX) && value !== false && value !== null && value !== undefined,
	).length;
	return {
		now: Date.now(),
		busyPanels,
		lastPanelRunAt: Math.max(Number(session[LAST_PANEL_RUN_KEY] ?? 0), WORKER_STARTED_AT),
		bridge: bridgeActivity(),
	};
}

function setProgress(
	action: HostUpdateProgress["action"],
	phase: HostUpdateProgress["phase"],
	message: string,
): Promise<void> {
	const progress: HostUpdateProgress = { type: "update_progress", action, phase, message, at: Date.now() };
	return chrome.storage.local.set({ [UPDATE_PROGRESS_KEY]: progress });
}

async function pendingReload(): Promise<PendingReload | undefined> {
	return (await chrome.storage.local.get(RELOAD_KEY))[RELOAD_KEY] as PendingReload | undefined;
}

let waitTimer: ReturnType<typeof setTimeout> | undefined;

/** Reload once nothing runs; say what it waits for meanwhile. */
async function reloadWhenIdle(): Promise<void> {
	waitTimer = undefined;
	const pending = await pendingReload();
	if (!pending || pending.reloadedFrom) return;
	const verdict = idleGate(await activity(), 0);
	if (!verdict.idle) {
		const what = pending.action === "reload" ? "Reloading Tabkyra" : "Installed. Reloading Tabkyra";
		await setProgress(pending.action, "waiting", `${what} when no agent is running: ${verdict.reason}.`);
		waitTimer = setTimeout(() => void reloadWhenIdle(), WAIT_POLL_MS);
		return;
	}
	await chrome.storage.local.set({ [RELOAD_KEY]: { ...pending, reloadedFrom: BUILD?.id ?? "unknown" } });
	await setProgress(pending.action, "reloading", "Reloading Tabkyra");
	chrome.runtime.reload();
}

async function requestReload(action: PendingReload["action"], extensionBuild?: string): Promise<void> {
	await chrome.storage.local.set({ [RELOAD_KEY]: { action, extensionBuild } satisfies PendingReload });
	if (waitTimer) clearTimeout(waitTimer);
	await reloadWhenIdle();
}

/** After a worker start: finish or report a reload that was asked for before it. */
async function resumeReload(): Promise<void> {
	const pending = await pendingReload();
	if (!pending) return;
	if (!pending.reloadedFrom) {
		await reloadWhenIdle();
		return;
	}
	await chrome.storage.local.remove(RELOAD_KEY);
	if (pending.extensionBuild && BUILD?.id !== pending.extensionBuild && BUILD?.id === pending.reloadedFrom) {
		await setProgress(
			pending.action,
			"failed",
			"Tabkyra reloaded but still runs the old build, so the browser loads it from another folder. Check the folder on chrome://extensions.",
		);
		return;
	}
	await setProgress(pending.action, "done", `Tabkyra reloaded and runs ${describeBuild(BUILD)}.`);
}

async function maybeAutoUpdate(): Promise<void> {
	const stored = await chrome.storage.local.get([UPDATE_STATUS_KEY, AUTO_KEY, UPDATE_PROGRESS_KEY, RELOAD_KEY]);
	const status = stored[UPDATE_STATUS_KEY] as HostUpdateStatus | undefined;
	if (!shouldAutoUpdate(status, stored[AUTO_KEY] as string | undefined) || !status) return;
	if (stored[RELOAD_KEY]) return;
	const progress = stored[UPDATE_PROGRESS_KEY] as HostUpdateProgress | undefined;
	const busy = progress && !["done", "failed"].includes(progress.phase) && Date.now() - progress.at < 30 * 60 * 1000;
	if (busy) return;
	if (!idleGate(await activity(), AUTO_UPDATE_QUIET_MS).idle) return;
	await chrome.storage.local.set({ [AUTO_KEY]: offerKey(status) });
	if (sendUpdateAction("update"))
		await setProgress("update", "checking", "Installing the update automatically (Tabkyra is idle)");
}

function onProgress(progress: HostUpdateProgress): void {
	if (progress.phase === "done" && progress.reload) void requestReload(progress.action, progress.extensionBuild);
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
	if (m.action === "reload") {
		void requestReload("reload");
		sendResponse({ ok: true });
		return undefined;
	}
	if (typeof m.action !== "string" || !(UPDATE_ACTIONS as readonly string[]).includes(m.action)) {
		sendResponse({ ok: false, message: "Unknown update action" });
		return undefined;
	}
	const action = m.action as UpdateAction;
	if (!sendUpdateAction(action)) {
		void setProgress(action, "failed", "The Tabkyra native host isn't connected. Run tabkyra doctor in a terminal.");
		sendResponse({ ok: false, message: "No native host" });
		return undefined;
	}
	if (!action.startsWith("policy-"))
		void setProgress(action, "checking", action === "check" ? "Checking for updates" : "Starting");
	sendResponse({ ok: true });
	return undefined;
}

export function startUpdateWorker(): void {
	onUpdateMessages({
		status: () => void maybeAutoUpdate().catch(() => undefined),
		progress: onProgress,
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
	void resumeReload().catch(() => undefined);
}
