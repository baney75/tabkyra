/**
 * The update system's decisions, as pure functions shared by the extension (service worker and
 * side panel) and the native host. docs/updates.md describes the behaviour; test/update-logic.test.mjs
 * pins it.
 */

import type { HostUpdateStatus, LastUpdate } from "../bridge/protocol.js";
import { type BuildInfo, describeBuild } from "./build.js";

// ---- the request the extension may send -------------------------------------------------

/**
 * Everything the extension can ask the native host to do about updates. Each name maps to a fixed
 * command or settings write in the host (cli/src/update-host.ts); a request carries nothing else.
 */
export const UPDATE_ACTIONS = [
	"check",
	"update",
	"activate",
	"rollback",
	"reinstall",
	"policy-off",
	"policy-notify",
	"policy-auto",
] as const;
export type UpdateAction = (typeof UPDATE_ACTIONS)[number];

/**
 * chrome.runtime message the side panel sends to the service worker: `{ type, action }`, where
 * action is an UpdateAction or "reload" (reload once idle, handled in the worker).
 */
export const PANEL_UPDATE_MESSAGE = "tabkyra-update";

/**
 * The action in an update request, or undefined when the frame is anything but
 * `{ "type": "update_action", "action": <one of UPDATE_ACTIONS> }`. Extra fields refuse the
 * whole request, so nothing else can ride along into the host.
 */
export function parseUpdateRequest(message: unknown): UpdateAction | undefined {
	if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
	const keys = Object.keys(message);
	if (keys.length !== 2 || !keys.includes("type") || !keys.includes("action")) return undefined;
	const { type, action } = message as { type: unknown; action: unknown };
	if (type !== "update_action" || typeof action !== "string") return undefined;
	return (UPDATE_ACTIONS as readonly string[]).includes(action) ? (action as UpdateAction) : undefined;
}

// ---- the updates setting ----------------------------------------------------------------

/** Settings > Updates: Off, Tell me (the default), Install automatically when idle. */
export type UpdatePolicy = "off" | "notify" | "auto";

export const POLICY_LABELS: Record<UpdatePolicy, string> = {
	off: "Off",
	notify: "Tell me",
	auto: "Install automatically when idle",
};

// ---- the idle gate ----------------------------------------------------------------------

/** "When idle": no agent run anywhere for this long. */
export const AUTO_UPDATE_QUIET_MS = 3 * 60 * 1000;
/** A bridge harness counts as mid-run for this long after its last request ends. */
export const BRIDGE_RUN_GAP_MS = 30 * 1000;

export interface ActivitySnapshot {
	now: number;
	/** Windows whose side panel has an agent run going (sidepanel_busy_<windowId>). */
	busyPanels: number;
	/** When a side panel run last ended, or 0. */
	lastPanelRunAt: number;
	bridge: Array<{ name: string; inFlight: boolean; lastActivityAt: number }>;
}

export interface IdleVerdict {
	idle: boolean;
	/** Why not, in words for the side panel. */
	reason?: string;
}

/**
 * May the extension reload (or start an automatic update) now? Never while a side panel run or a
 * bridge request is going. `quietMs` adds a quiet period after the last activity: 0 for "Update
 * now" (only BRIDGE_RUN_GAP_MS still applies to harnesses between calls), AUTO_UPDATE_QUIET_MS
 * for automatic updates.
 */
export function idleGate(a: ActivitySnapshot, quietMs = 0): IdleVerdict {
	if (a.busyPanels > 0) {
		return {
			idle: false,
			reason: `an agent run is going in ${a.busyPanels === 1 ? "a side panel" : `${a.busyPanels} side panels`}`,
		};
	}
	const running = a.bridge.filter((c) => c.inFlight);
	if (running.length > 0) return { idle: false, reason: `${running[0].name} is using the browser` };
	const harnessGap = Math.max(quietMs, BRIDGE_RUN_GAP_MS);
	const recent = a.bridge.find((c) => c.lastActivityAt > 0 && a.now - c.lastActivityAt < harnessGap);
	if (recent) return { idle: false, reason: `${recent.name} used the browser moments ago` };
	if (quietMs > 0 && a.lastPanelRunAt > 0 && a.now - a.lastPanelRunAt < quietMs) {
		return { idle: false, reason: "a side panel run ended moments ago" };
	}
	return { idle: true };
}

// ---- where the extension runs from, and version mismatches ------------------------------

/**
 * Is the browser running the extension from the folder the native host installs into? The
 * extension reads its own build-info.json (an unpacked extension serves its files from disk) and
 * sends it in its hello; the host compares it with the build-info.json in its own dist-chrome.
 * Build ids are new for every build, so equal ids mean the same folder.
 */
export type ExtensionLocation = "here" | "elsewhere" | "unknown";

export function locateExtension(
	extensionDiskId: string | undefined,
	hostDiskId: string | undefined,
): ExtensionLocation {
	if (!extensionDiskId || !hostDiskId) return "unknown";
	return extensionDiskId === hostDiskId ? "here" : "elsewhere";
}

export interface BuildSet {
	/** The extension code the browser is running (compiled in, sent in its hello). */
	extension?: BuildInfo;
	/** dist-chrome/build-info.json where the host installs. Only compared when location is "here". */
	extensionOnDisk?: BuildInfo;
	location: ExtensionLocation;
	/** The native host process (compiled in). */
	host?: BuildInfo;
	/** cli/dist/build-info.json where the host installs. */
	cliOnDisk?: BuildInfo;
}

export interface Mismatch {
	/** reinstall: re-run the install step; reload: reload the extension (which restarts the host too). */
	fix: "reinstall" | "reload";
	reason: string;
}

/** Built from the same source: a rebuild of one commit is not a mismatch. */
export function sameSource(a: BuildInfo, b: BuildInfo): boolean {
	if (a.id === b.id) return true;
	return a.version === b.version && Boolean(a.commit) && a.commit === b.commit;
}

/**
 * A partial update: the extension, native host and CLI disagree. Builds without build-info (made
 * before it existed) are skipped rather than reported. The disk is checked first, because a
 * reload can't fix a half-installed update.
 */
export function diagnoseVersions(b: BuildSet): Mismatch | undefined {
	if (b.extensionOnDisk && b.cliOnDisk && !sameSource(b.extensionOnDisk, b.cliOnDisk)) {
		return {
			fix: "reinstall",
			reason: `The installed extension (${describeBuild(b.extensionOnDisk)}) and CLI (${describeBuild(b.cliOnDisk)}) were built from different commits.`,
		};
	}
	if (b.location === "here" && b.extension && b.extensionOnDisk && !sameSource(b.extension, b.extensionOnDisk)) {
		return {
			fix: "reload",
			reason: `The browser still runs ${describeBuild(b.extension)}; ${describeBuild(b.extensionOnDisk)} is installed.`,
		};
	}
	if (b.host && b.cliOnDisk && !sameSource(b.host, b.cliOnDisk)) {
		return {
			fix: "reload",
			reason: `The native host still runs ${describeBuild(b.host)}; ${describeBuild(b.cliOnDisk)} is installed.`,
		};
	}
	return undefined;
}

// ---- what's new -------------------------------------------------------------------------

/**
 * The "What's new" card shows the last update once the browser runs the build that update
 * installed (so only after the reload), until the user dismisses it. Rollbacks and reinstalls
 * have nothing new to show.
 */
export function whatsNewFor(
	last: LastUpdate | undefined,
	dismissedId: string | undefined,
	runningBuildId: string | undefined,
): LastUpdate | undefined {
	if (!last || last.kind !== "update") return undefined;
	if (!last.extensionBuild || last.extensionBuild !== runningBuildId) return undefined;
	if (dismissedId === last.id) return undefined;
	return last;
}

/** Only https links leave the panel (release pages and compare views). */
export function safeLink(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const u = new URL(url);
		return u.protocol === "https:" ? u.href : undefined;
	} catch {
		return undefined;
	}
}

// ---- automatic updates ------------------------------------------------------------------

/** What an automatic update would install, so a failed one isn't retried in a loop. */
export function offerKey(s: Pick<HostUpdateStatus, "mode" | "latest" | "current">): string {
	return `${s.mode ?? "release"}:${s.latest ?? s.current}`;
}

/**
 * "Install automatically when idle": is there something to install on its own? Never when the
 * update would refuse or the install is half done, never a build the user just rolled back
 * from, and never the same offer twice (a failed attempt waits for the user or a newer offer).
 */
export function shouldAutoUpdate(s: HostUpdateStatus | undefined, attempted?: string): boolean {
	// A reinstall mismatch doesn't hold an update back: the update rebuilds both anyway.
	if (!s || s.policy !== "auto" || !s.available || s.blocked || s.mismatch?.fix === "reload" || s.error) return false;
	if (s.staged || s.updating) return false;
	if (s.mode === "unmanaged") return false;
	// A checkout updates on its own only for new commits, not to rebuild after a rollback.
	if (s.mode === "checkout" && !(s.behind && s.behind > 0)) return false;
	const last = s.lastUpdate;
	if (s.mode !== "checkout" && last?.kind === "rollback" && last.from === s.latest) return false;
	return attempted !== offerKey(s);
}
