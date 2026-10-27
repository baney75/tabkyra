/**
 * The native host's side of updates from the side panel (docs/updates.md):
 *
 * - status: the last check, refreshed once a day (or on "check"), plus the install mode, the
 *   builds on disk and running, version mismatches and the last update, sent as update_status;
 * - actions: the extension sends `{type: "update_action", action}` and nothing else. Each action
 *   maps to a fixed child command line (UPDATE_COMMANDS) or a fixed settings write. Nothing the
 *   extension sends reaches a command; a frame with any other field is refused.
 * - progress: the child prints one JSON line per step; each becomes an update_progress frame.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtHello, HostToExt, HostUpdateProgress, HostUpdateStatus, UpdatePhase } from "../../src/bridge/protocol.ts";
import { asBuildInfo, BUILD, type BuildInfo, describeBuild } from "../../src/update/build.ts";
import { diagnoseVersions, type ExtensionLocation, locateExtension, parseUpdateRequest, type UpdateAction } from "../../src/update/logic.ts";
import { blockedReason, canRollBack, detectMode, inspectCheckout, needsBuild, previousBuild, readBuildInfo, toolEnv } from "./checkout.ts";
import type { HostRunAction } from "./update-run.ts";
import {
	CHECK_INTERVAL_MS,
	checkForUpdate,
	installedVersion,
	previousDir,
	readLastUpdate,
	readSettings,
	readStatus,
	setPolicy,
	type UpdateStatus,
	writeStatus,
} from "./update.ts";

/**
 * The only command lines the host runs for the extension, by action. They are passed to the
 * CLI this host runs from, as argv (no shell). Checks and settings run in this process.
 */
export const UPDATE_COMMANDS: Readonly<Record<HostRunAction, readonly string[]>> = Object.freeze({
	update: Object.freeze(["update", "--host"]),
	rollback: Object.freeze(["update", "--host", "--rollback"]),
	reinstall: Object.freeze(["update", "--host", "--reinstall"]),
});

type Send = (message: HostToExt) => void;

/** The CLI file this host runs from: the child runs the same code. */
function cliEntry(): string {
	return fileURLToPath(import.meta.url);
}

let extension: { build?: BuildInfo; location: ExtensionLocation } = { location: "unknown" };
let running: { action: HostRunAction; last?: HostUpdateProgress } | undefined;

/** The extension said hello: note what it runs and whether it loads from our folder. */
export function noteHello(hello: ExtHello): void {
	const { root } = detectMode();
	const disk = readBuildInfo(join(root, "dist-chrome"));
	extension = {
		build: asBuildInfo(hello.build),
		location: locateExtension(asBuildInfo(hello.diskBuild)?.id, disk?.id),
	};
}

/** For tests and `tabkyra debug`: is an update child running. */
export function updateRunning(): HostRunAction | undefined {
	return running?.action;
}

// ---- status -------------------------------------------------------------------------------

/** Release mode and unmanaged: the cached release check, refreshed when old or forced. */
async function releaseCheck(force: boolean, root: string): Promise<UpdateStatus> {
	const { channel } = readSettings();
	const cached = readStatus();
	const current = installedVersion(root) ?? installedVersion();
	if (!force && cached && (cached.mode ?? "release") !== "checkout" && cached.channel === channel && cached.current === current && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) {
		return cached;
	}
	return checkForUpdate(channel);
}

interface CheckoutCheck {
	status: UpdateStatus;
	blocked?: string;
	behind: number;
	needsBuild: boolean;
}

/** Checkout mode: `git fetch` once a day (or when forced); everything else is read each time. */
async function checkoutCheck(force: boolean, root: string, checks: boolean): Promise<CheckoutCheck> {
	const cached = readStatus();
	const stale = !cached || cached.mode !== "checkout" || Date.now() - cached.checkedAt >= CHECK_INTERVAL_MS;
	const fetch = checks && (force || stale);
	const info = await inspectCheckout(root, { fetch });
	const pending = needsBuild(info);
	const status: UpdateStatus = {
		checkedAt: fetch ? Date.now() : (cached?.mode === "checkout" ? cached.checkedAt : 0),
		channel: "main",
		mode: "checkout",
		current: describeBuild(info.built) === "unknown" ? info.head.slice(0, 7) : describeBuild(info.built),
		latest: info.origin?.slice(0, 7),
		available: info.behind > 0 || pending,
		head: info.head,
		origin: info.origin,
		error: info.fetchError,
	};
	if (fetch) writeStatus(status);
	return { status, blocked: info.blocked ?? blockedReason(info), behind: info.behind, needsBuild: pending };
}

/** Everything Settings > Updates and the notice show. `force` checks now. */
export async function computeStatus(force = false): Promise<HostUpdateStatus> {
	const settings = readSettings();
	const { mode, root } = detectMode();
	const checks = settings.policy !== "off" || force;
	const extensionOnDisk = readBuildInfo(join(root, "dist-chrome"));
	const cliOnDisk = readBuildInfo(join(root, "cli", "dist"));
	let check: UpdateStatus;
	let blocked: string | undefined;
	let behind: number | undefined;
	let pendingBuild: boolean | undefined;
	let canRollback = false;
	let rollbackTo: string | undefined;
	if (mode === "checkout") {
		const c = await checkoutCheck(force, root, checks);
		check = c.status;
		blocked = c.blocked;
		behind = c.behind;
		pendingBuild = c.needsBuild;
		canRollback = canRollBack(root);
		rollbackTo = canRollback ? describeBuild(previousBuild(root)) : undefined;
	} else {
		const current = installedVersion(root) ?? describeBuild(cliOnDisk);
		check = checks ? await releaseCheck(force, root) : { checkedAt: readStatus()?.checkedAt ?? 0, channel: settings.channel, current, available: false };
		if (!checks) check.available = false;
		if (mode === "release") {
			canRollback = existsSync(previousDir());
			rollbackTo = canRollback ? installedVersion(previousDir()) : undefined;
		} else {
			blocked = `This Tabkyra runs from ${root}, which is neither a release install nor a git checkout. Run tabkyra update in a terminal.`;
		}
	}
	if (extension.location === "elsewhere") {
		blocked = `The browser loads Tabkyra from another folder than ${join(root, "dist-chrome")}, so updating here would not change it. Load that folder on chrome://extensions, or update the copy the browser loads.`;
	}
	const mismatch = diagnoseVersions({ extension: extension.build, extensionOnDisk, location: extension.location, host: BUILD, cliOnDisk });
	return {
		type: "update_status",
		available: checks && check.available && !check.error,
		current: check.current,
		latest: check.latest,
		channel: check.channel,
		checkedAt: check.checkedAt,
		mode,
		policy: settings.policy,
		nextCheckAt: settings.policy === "off" ? undefined : (check.checkedAt || Date.now()) + CHECK_INTERVAL_MS,
		root,
		error: check.error,
		blocked,
		behind,
		needsBuild: pendingBuild,
		canRollback,
		rollbackTo,
		location: extension.location,
		mismatch,
		lastUpdate: readLastUpdate(),
		hostBuild: BUILD,
		cliBuild: cliOnDisk,
		extensionBuild: extensionOnDisk,
	};
}

export async function sendStatus(send: Send, force = false): Promise<HostUpdateStatus | undefined> {
	try {
		const status = await computeStatus(force);
		send(status);
		return status;
	} catch (err) {
		process.stderr.write(`[tabkyra-host] update status failed: ${String(err)}\n`);
		return undefined;
	}
}

// ---- actions ------------------------------------------------------------------------------

function progress(send: Send, action: UpdateAction, phase: UpdatePhase, message: string, extra: Partial<HostUpdateProgress> = {}): HostUpdateProgress {
	const frame: HostUpdateProgress = { type: "update_progress", action, phase, message, at: Date.now(), ...extra };
	send(frame);
	return frame;
}

/** Run one of the fixed update commands as a child and stream its steps. */
function runChild(action: HostRunAction, send: Send): void {
	const child = spawn(process.execPath, [cliEntry(), ...UPDATE_COMMANDS[action]], {
		env: toolEnv(),
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	});
	const state: { action: HostRunAction; last?: HostUpdateProgress } = { action };
	running = state;
	let buffer = "";
	let stderr = "";
	let finished = false;
	const onLine = (line: string) => {
		if (!line.trim()) return;
		let event: { phase?: unknown; message?: unknown; reload?: unknown; extensionBuild?: unknown };
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		const phases: UpdatePhase[] = ["checking", "downloading", "verifying", "pulling", "installing", "building", "skills", "done", "failed"];
		if (typeof event.phase !== "string" || !phases.includes(event.phase as UpdatePhase)) return;
		const phase = event.phase as UpdatePhase;
		if (phase === "done" || phase === "failed") finished = true;
		state.last = progress(send, action, phase, String(event.message ?? "").slice(0, 2000), {
			reload: event.reload === true ? true : undefined,
			extensionBuild: typeof event.extensionBuild === "string" ? event.extensionBuild : undefined,
		});
	};
	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let nl = buffer.indexOf("\n");
		while (nl >= 0) {
			onLine(buffer.slice(0, nl));
			buffer = buffer.slice(nl + 1);
			nl = buffer.indexOf("\n");
		}
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString("utf8")).slice(-2000);
	});
	const end = (code: number | null, error?: Error) => {
		if (running === state) running = undefined;
		if (buffer) onLine(buffer);
		if (!finished) {
			const reason = error?.message || stderr.trim().split("\n").slice(-3).join("\n") || `exit code ${code}`;
			progress(send, action, "failed", `The updater stopped: ${reason}`);
		}
		void sendStatus(send);
	};
	child.on("error", (err) => end(null, err));
	child.on("close", (code) => end(code));
}

/**
 * An update_action frame from the extension. Anything but exactly `{type, action}` with a known
 * action is refused without running anything.
 */
export function handleUpdateAction(raw: unknown, send: Send): void {
	const action = parseUpdateRequest(raw);
	if (!action) {
		progress(send, "update", "failed", "Refused: an update request carries only an action name the host knows.");
		return;
	}
	if (action === "policy-off" || action === "policy-notify" || action === "policy-auto") {
		setPolicy(action === "policy-off" ? "off" : action === "policy-notify" ? "notify" : "auto");
		void sendStatus(send);
		return;
	}
	if (running) {
		// Say what is going on instead of starting a second updater.
		if (running.last) send({ ...running.last, at: Date.now() });
		else progress(send, running.action, "checking", "An update is already running.");
		return;
	}
	if (action === "check") {
		progress(send, "check", "checking", "Checking for updates");
		void sendStatus(send, true).then((status) => {
			if (!status) progress(send, "check", "failed", "The check failed.");
			else if (status.error) progress(send, "check", "failed", status.error);
			else progress(send, "check", "done", status.available ? `Update available: ${status.latest ?? "new build"}` : "Up to date");
		});
		return;
	}
	if (extension.location === "elsewhere" && action !== "reinstall") {
		void computeStatus().then((status) => progress(send, action, "failed", status.blocked ?? "The browser loads Tabkyra from another folder."));
		return;
	}
	runChild(action, send);
}

/** Re-check once a day while the host runs (the browser keeps it running). */
export function startUpdateTimer(send: Send): void {
	const timer = setInterval(
		() => {
			const status = readStatus();
			if (!status || Date.now() - status.checkedAt >= CHECK_INTERVAL_MS) void sendStatus(send);
		},
		60 * 60 * 1000,
	);
	timer.unref();
}
