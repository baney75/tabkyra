/**
 * The install gate: while the service worker swaps an update in and reloads Tabkyra, no new agent
 * run may start, so nothing runs on a mix of old and new files and no run is cut off by the
 * reload. The worker holds it (src/update/worker.ts); the side panel checks it before a send,
 * and the bridge refuses requests while it is held.
 */

/** chrome.storage.session: when the worker took the gate (ms), or absent. */
export const INSTALL_GATE_KEY = "tabkyra.updateInstalling";
/** A gate older than this was left by a worker that died; it no longer counts. */
export const INSTALL_GATE_MAX_MS = 10 * 60 * 1000;
/** chrome.storage.session: the side panel's heartbeat while a run goes, per window. */
export const BUSY_BEAT_PREFIX = "sidepanel_busy_beat_";
/** A busy flag counts only with a heartbeat this fresh (the panel beats every 15 s). */
export const BUSY_BEAT_MAX_MS = 45000;

export function gateHeld(takenAt: unknown, now = Date.now()): boolean {
	return typeof takenAt === "number" && now - takenAt < INSTALL_GATE_MAX_MS;
}

/** For the side panel: is an update being installed right now. */
export async function updateInstalling(): Promise<boolean> {
	try {
		return gateHeld((await chrome.storage.session.get(INSTALL_GATE_KEY))[INSTALL_GATE_KEY]);
	} catch {
		return false;
	}
}
