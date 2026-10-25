import type { TabkyraAppStorage } from "../storage/app-storage.js";
import { addEntry, BUG_LOG_KEY, BUG_REPORTS_KEY, type BugEntry } from "./bug-reports.js";

/**
 * Keep redacted errors from the side panel while the user has bug reports on. Off by
 * default; when off, nothing is recorded. Nothing is sent from here.
 */
export function installBugCapture(storage: TabkyraAppStorage): void {
	const record = async (error: unknown) => {
		try {
			if ((await storage.settings.get<boolean>(BUG_REPORTS_KEY)) !== true) return;
			const log = (await storage.settings.get<BugEntry[]>(BUG_LOG_KEY)) ?? [];
			await storage.settings.set(BUG_LOG_KEY, addEntry(log, error));
		} catch {
			/* A bug reporter must never cause a bug. */
		}
	};
	window.addEventListener("error", (e) => void record(e.error ?? e.message));
	window.addEventListener("unhandledrejection", (e) => void record(e.reason));
}
