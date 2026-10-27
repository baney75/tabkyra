/**
 * `tabkyra update --host [--activate|--rollback|--reinstall]`: the update the native host runs
 * for the side panel, as a child process. It prints one JSON line per step ({phase, message})
 * and a last one with phase "done" or "failed"; the host forwards them to the extension. Each
 * line is also written to ~/.config/tabkyra/update-progress.json, so a host that restarts (the
 * browser restarted it, or the extension reloaded) can pick up a run already going.
 *
 * An update has two steps, so the browser never runs a mix of old and new files for long:
 *   --host            check, download or pull, build, and stage the result. Nothing live changes.
 *   --host --activate swap the staged build in, refresh skills, record What's new. The extension
 *                     asks for this only when no agent runs, and reloads right after.
 *
 * What "update" means depends on how Tabkyra runs (detectMode):
 *   release:   the signed GitHub release flow of update.ts, with its checks unchanged.
 *   checkout:  fetch, git pull --ff-only on main, setup-siblings, build (checkout.ts).
 *   unmanaged: an npm install or copied folder; refused, with what to run instead.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LastUpdate, UpdatePhase } from "../../src/bridge/protocol.ts";
import { describeBuild } from "../../src/update/build.ts";
import { activateCheckout, detectMode, readBuildInfo, rollbackCheckout, updateCheckout } from "./checkout.ts";
import { noteUneditedSkills } from "./skill.ts";
import {
	appDir,
	checkForUpdate,
	configDir,
	downloadVerified,
	installedVersion,
	installRoot,
	latestRelease,
	previousDir,
	readSettings,
	readStatus,
	recover,
	reinstallHost,
	stage,
	stagedDir,
	swapBack,
	swapIn,
	UpdateError,
	withLock,
	writeLastUpdate,
	writeStatus,
} from "./update.ts";

export type HostRunAction = "update" | "activate" | "rollback" | "reinstall";

export interface ProgressEvent {
	phase: UpdatePhase;
	message: string;
	/** Done, and a build is staged: the extension activates it once no agent runs. */
	staged?: boolean;
	/** Done, and the extension should reload now to run what is installed. */
	reload?: boolean;
	extensionBuild?: string;
}

/** The last step of the running (or last) updater, for a host that starts while it runs. */
export interface ProgressRecord extends ProgressEvent {
	pid: number;
	action: HostRunAction;
	at: number;
}

export const progressFile = () => join(configDir(), "update-progress.json");

export function readProgressRecord(): ProgressRecord | undefined {
	try {
		return JSON.parse(readFileSync(progressFile(), "utf8")) as ProgressRecord;
	} catch {
		return undefined;
	}
}

let currentAction: HostRunAction = "update";

function emit(event: ProgressEvent): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
	try {
		mkdirSync(configDir(), { recursive: true, mode: 0o700 });
		const record: ProgressRecord = { ...event, pid: process.pid, action: currentAction, at: Date.now() };
		const tmp = `${progressFile()}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(record)}\n`);
		renameSync(tmp, progressFile());
	} catch {
		/* the stream to the host still has it */
	}
}

const phase = (p: UpdatePhase, message: string) => emit({ phase: p, message });

/** Note the unedited installed skills before a swap. Never stops the update. */
function noteSkills(): string | undefined {
	try {
		noteUneditedSkills();
		return undefined;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/** Refresh unedited installed skills with the CLI now installed. Never stops the update. */
function refreshSkills(cli: string, noteError?: string): LastUpdate["skills"] {
	phase("skills", "Refreshing the bundled skills you haven't edited");
	try {
		const out = execFileSync(process.execPath, [cli, "skill", "refresh", "--json"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
		const line = out.trim().split("\n").pop() ?? "{}";
		const r = JSON.parse(line) as { refreshed?: string[]; skipped?: Array<{ skill: string; file: string; reason: string }> };
		return { refreshed: r.refreshed ?? [], skipped: r.skipped ?? [], error: noteError };
	} catch (err) {
		const e = err as { stdout?: string; message: string };
		return { refreshed: [], skipped: [], error: `skill refresh failed: ${(e.stdout || e.message).trim().slice(0, 300)}` };
	}
}

function skillsLine(skills: LastUpdate["skills"]): string {
	if (!skills) return "";
	const parts: string[] = [];
	if (skills.refreshed.length) parts.push(`${skills.refreshed.length} skill file${skills.refreshed.length === 1 ? "" : "s"} refreshed`);
	if (skills.skipped.length) parts.push(`${skills.skipped.length} left alone because you edited them`);
	if (skills.error) parts.push(`skills not refreshed (${skills.error})`);
	return parts.length ? ` ${parts.join("; ")}.` : "";
}

/** Swallow the log lines of the terminal flow; the steps are reported as phases instead. */
const quiet = (_line: string) => {};

const WHEN_IDLE = "It installs when no agent is running, then Tabkyra reloads.";

// ---- release mode -------------------------------------------------------------------------

interface ReleasePending {
	from: string;
	to: string;
	notes?: string;
	url?: string;
}

const pendingFile = () => join(stagedDir(), ".pending.json");

async function releaseUpdate(): Promise<void> {
	const { channel } = readSettings();
	phase("checking", `Checking GitHub for the newest ${channel} release`);
	if (existsSync(installRoot())) withLock(recover);
	const status = await checkForUpdate(channel);
	if (status.error) throw new UpdateError(status.error);
	if (!status.latest) {
		emit({ phase: "done", message: `No ${channel} release is published yet.` });
		return;
	}
	if (!status.available) {
		emit({ phase: "done", message: `Up to date (${status.current}).` });
		return;
	}
	const release = await latestRelease(channel);
	if (!release || release.version !== status.latest) throw new UpdateError("The release list changed during the update; run it again.");
	const zip = await downloadVerified(release, quiet, phase);
	phase("installing", `Unpacking ${release.version}`);
	withLock(() => {
		recover();
		rmSync(stagedDir(), { recursive: true, force: true });
		renameSync(stage(zip, release.version), stagedDir());
		const pending: ReleasePending = { from: status.current, to: release.version, notes: release.notes, url: release.url };
		writeFileSync(pendingFile(), `${JSON.stringify(pending, null, 2)}\n`);
	});
	emit({ phase: "done", message: `Downloaded and verified ${release.version}. ${WHEN_IDLE}`, staged: true });
}

function releaseActivate(): void {
	let pending: ReleasePending | undefined;
	const noteError = noteSkills();
	phase("installing", "Installing the verified release");
	withLock(() => {
		recover();
		if (!existsSync(pendingFile())) return;
		pending = JSON.parse(readFileSync(pendingFile(), "utf8")) as ReleasePending;
		rmSync(pendingFile(), { force: true });
		if (installedVersion(stagedDir()) !== pending.to) throw new UpdateError(`The staged release is not ${pending.to}; run Update now again.`);
		swapIn(stagedDir());
	});
	if (!pending) {
		emit({ phase: "done", message: "Nothing was waiting to install." });
		return;
	}
	const done = pending;
	reinstallHost(quiet);
	const status = readStatus();
	if (status) writeStatus({ ...status, current: done.to, available: false, checkedAt: Date.now() });
	const skills = refreshSkills(join(appDir(), "cli", "dist", "index.js"), noteError);
	const extensionBuild = readBuildInfo(join(appDir(), "dist-chrome"))?.id;
	writeLastUpdate({ id: randomUUID(), kind: "update", mode: "release", at: Date.now(), from: done.from, to: done.to, notes: done.notes, url: done.url, extensionBuild, skills });
	emit({ phase: "done", message: `Installed ${done.to}.${skillsLine(skills)}`, reload: true, extensionBuild });
}

function releaseRollback(): void {
	phase("installing", `Rolling back to the release in ${previousDir()}`);
	withLock(() => rmSync(stagedDir(), { recursive: true, force: true }));
	const { from, to } = swapBack(quiet);
	reinstallHost(quiet);
	const extensionBuild = readBuildInfo(join(appDir(), "dist-chrome"))?.id;
	writeLastUpdate({ id: randomUUID(), kind: "rollback", mode: "release", at: Date.now(), from: from ?? "?", to: to ?? "?", extensionBuild });
	emit({ phase: "done", message: `Rolled back ${from ?? "?"} to ${to ?? "?"}.`, reload: true, extensionBuild });
}

function releaseReinstall(): void {
	phase("installing", "Registering the native host and launcher from the installed release");
	if (!reinstallHost(quiet)) throw new UpdateError(`Registering the native host from ${appDir()} failed. Run: node ${join(appDir(), "cli", "dist", "index.js")} install`);
	const version = installedVersion(appDir()) ?? "?";
	const extensionBuild = readBuildInfo(join(appDir(), "dist-chrome"))?.id;
	writeLastUpdate({ id: randomUUID(), kind: "reinstall", mode: "release", at: Date.now(), from: version, to: version, extensionBuild });
	emit({ phase: "done", message: `Re-ran the install step for ${version}.`, reload: true, extensionBuild });
}

// ---- checkout mode ------------------------------------------------------------------------

async function checkoutUpdate(root: string, pull: boolean): Promise<void> {
	const result = await updateCheckout(root, phase, { pull });
	if (!result.changed) {
		emit({ phase: "done", message: result.message });
		return;
	}
	const n = result.staged?.commits?.total ?? 0;
	const pulled = n ? ` (${n} new commit${n === 1 ? "" : "s"})` : "";
	emit({ phase: "done", message: `${result.message}${pulled}. ${WHEN_IDLE}`, staged: true });
}

function checkoutActivate(root: string): void {
	let noteError: string | undefined;
	phase("installing", "Swapping in the new build");
	const staged = activateCheckout(root, () => {
		noteError = noteSkills();
	});
	if (!staged) {
		emit({ phase: "done", message: "Nothing was waiting to install." });
		return;
	}
	const skills = refreshSkills(join(root, "cli", "dist", "index.js"), noteError);
	const extensionBuild = readBuildInfo(join(root, "dist-chrome"))?.id;
	writeLastUpdate({
		id: randomUUID(),
		kind: "update",
		mode: "checkout",
		at: Date.now(),
		from: staged.from,
		to: staged.to,
		commits: staged.commits?.commits,
		totalCommits: staged.commits?.total,
		url: staged.commits?.url,
		extensionBuild,
		skills,
	});
	emit({ phase: "done", message: `Installed ${staged.to}.${skillsLine(skills)}`, reload: true, extensionBuild });
}

function checkoutRollback(root: string): void {
	phase("installing", "Swapping back to the previous build");
	const { from, to } = rollbackCheckout(root);
	const extensionBuild = readBuildInfo(join(root, "dist-chrome"))?.id;
	writeLastUpdate({ id: randomUUID(), kind: "rollback", mode: "checkout", at: Date.now(), from: describeBuild(from), to: describeBuild(to), extensionBuild });
	emit({
		phase: "done",
		message: `Rolled back the build ${describeBuild(from)} to ${describeBuild(to)}. The git checkout stays where it is; Update now builds it again.`,
		reload: true,
		extensionBuild,
	});
}

// ---- entry --------------------------------------------------------------------------------

export async function runHostAction(action: HostRunAction): Promise<number> {
	currentAction = action;
	// The host may exit (the extension reloaded) while this runs: keep going without its pipe.
	process.stdout.on("error", () => {});
	const { mode, root } = detectMode();
	try {
		if (mode === "unmanaged") {
			throw new UpdateError(
				`This Tabkyra runs from ${root}, which is neither a release install nor a git checkout, so it can't update itself from the side panel. Run tabkyra update in a terminal.`,
			);
		}
		if (mode === "release") {
			if (action === "update") await releaseUpdate();
			else if (action === "activate") releaseActivate();
			else if (action === "rollback") releaseRollback();
			else releaseReinstall();
		} else if (action === "rollback") checkoutRollback(root);
		else if (action === "activate") checkoutActivate(root);
		else await checkoutUpdate(root, action === "update");
		return 0;
	} catch (err) {
		emit({ phase: "failed", message: err instanceof Error ? err.message : String(err) });
		return 1;
	}
}
