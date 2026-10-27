/**
 * The install gate: while the service worker swaps an update in and reloads Tabkyra, no new agent
 * run may start, so nothing runs on a mix of old and new files and no run is cut off by the
 * reload. It is a Web Lock, shared by the worker and every side panel (same origin):
 *
 * - the worker takes it, then checks that nothing runs, and holds it through the install and
 *   the reload (src/update/worker.ts);
 * - a side panel starting a run takes it only if it is free, and marks itself busy while it
 *   holds it (reserveRun), so either the worker sees the run or the panel sees the install;
 * - the bridge refuses requests while the worker holds it (src/bridge/native.ts).
 */

export const INSTALL_GATE_LOCK = "tabkyra-update-install";
/** A gate held longer than this is let go (a stuck install must not block runs forever). */
export const INSTALL_GATE_MAX_MS = 10 * 60 * 1000;
/** chrome.storage.session: the side panel's heartbeat while a run goes, per window. */
export const BUSY_BEAT_PREFIX = "sidepanel_busy_beat_";
/** A busy flag counts only with a heartbeat this fresh (the panel beats every 15 s). */
export const BUSY_BEAT_MAX_MS = 45000;

/**
 * For the side panel, before it starts a run: false when an update is being installed.
 * `markBusy` runs while the panel holds the gate, so the worker's idle check after it takes
 * the gate sees the run.
 */
export async function reserveRun(markBusy: () => Promise<void>): Promise<boolean> {
	if (!globalThis.navigator?.locks) {
		await markBusy();
		return true;
	}
	return navigator.locks.request(INSTALL_GATE_LOCK, { ifAvailable: true }, async (lock) => {
		if (!lock) return false;
		await markBusy();
		return true;
	});
}
