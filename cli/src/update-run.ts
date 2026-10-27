/**
 * `tabkyra update --host [--rollback|--reinstall]`: the update the native host runs for the
 * side panel, as a child process. It prints one JSON line per step ({phase, message}) and a
 * last one with phase "done" or "failed"; the host forwards them to the extension.
 *
 * What "update" means depends on how Tabkyra runs (detectMode):
 *   release:   the signed GitHub release flow of update.ts, with its checks unchanged.
 *   checkout:  fetch, git pull --ff-only on main, setup-siblings, build, swap (checkout.ts).
 *   unmanaged: an npm install or copied folder; refused, with what to run instead.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LastUpdate, UpdatePhase } from "../../src/bridge/protocol.ts";
import { describeBuild } from "../../src/update/build.ts";
import { detectMode, readBuildInfo, rollbackCheckout, updateCheckout } from "./checkout.ts";
import { noteUneditedSkills } from "./skill.ts";
import {
	appDir,
	checkForUpdate,
	downloadVerified,
	installedVersion,
	installRoot,
	latestRelease,
	previousDir,
	readSettings,
	recover,
	reinstallHost,
	stage,
	swapBack,
	swapIn,
	UpdateError,
	withLock,
	writeLastUpdate,
	writeStatus,
} from "./update.ts";

export type HostRunAction = "update" | "rollback" | "reinstall";

interface Event {
	phase: UpdatePhase;
	message: string;
	reload?: boolean;
	extensionBuild?: string;
}

function emit(event: Event): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

const phase = (p: UpdatePhase, message: string) => emit({ phase: p, message });

/** Refresh unedited installed skills with the CLI now installed in `root`. */
function refreshSkills(cli: string): LastUpdate["skills"] {
	phase("skills", "Refreshing the bundled skills you haven't edited");
	try {
		const out = execFileSync(process.execPath, [cli, "skill", "refresh", "--json"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
		const line = out.trim().split("\n").pop() ?? "{}";
		const r = JSON.parse(line) as { refreshed?: string[]; skipped?: Array<{ skill: string; file: string; reason: string }> };
		return { refreshed: r.refreshed ?? [], skipped: r.skipped ?? [] };
	} catch (err) {
		const e = err as { stdout?: string; message: string };
		return { refreshed: [], skipped: [{ skill: "*", file: cli, reason: `skill refresh failed: ${(e.stdout || e.message).trim().slice(0, 300)}` }] };
	}
}

function skillsLine(skills: LastUpdate["skills"]): string {
	if (!skills) return "";
	const parts: string[] = [];
	if (skills.refreshed.length) parts.push(`${skills.refreshed.length} skill file${skills.refreshed.length === 1 ? "" : "s"} refreshed`);
	if (skills.skipped.length) parts.push(`${skills.skipped.length} left alone because you edited them`);
	return parts.length ? ` ${parts.join("; ")}.` : "";
}

/** Swallow the log lines of the terminal flow; the steps are reported as phases instead. */
const quiet = (_line: string) => {};

// ---- release mode -------------------------------------------------------------------------

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
	phase("installing", `Installing ${release.version}`);
	noteUneditedSkills();
	withLock(() => {
		recover();
		swapIn(stage(zip, release.version));
	});
	reinstallHost(quiet);
	writeStatus({ ...status, current: release.version, available: false, checkedAt: Date.now() });
	const skills = refreshSkills(join(appDir(), "cli", "dist", "index.js"));
	const extensionBuild = readBuildInfo(join(appDir(), "dist-chrome"))?.id;
	writeLastUpdate({
		id: randomUUID(),
		kind: "update",
		mode: "release",
		at: Date.now(),
		from: status.current,
		to: release.version,
		notes: release.notes,
		url: release.url,
		extensionBuild,
		skills,
	});
	emit({ phase: "done", message: `Installed ${release.version}.${skillsLine(skills)}`, reload: true, extensionBuild });
}

function releaseRollback(): void {
	phase("installing", `Rolling back to the release in ${previousDir()}`);
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
	const result = await updateCheckout(root, phase, { pull, beforeSwap: () => void noteUneditedSkills() });
	if (!result.changed) {
		emit({ phase: "done", message: result.message });
		return;
	}
	const skills = refreshSkills(join(root, "cli", "dist", "index.js"));
	const extensionBuild = readBuildInfo(join(root, "dist-chrome"))?.id;
	writeLastUpdate({
		id: randomUUID(),
		kind: pull ? "update" : "reinstall",
		mode: "checkout",
		at: Date.now(),
		from: result.from ?? "?",
		to: result.to ?? "?",
		commits: result.commits?.commits,
		totalCommits: result.commits?.total,
		url: result.commits?.url,
		extensionBuild,
		skills,
	});
	const pulled = result.commits ? ` ${result.commits.total} new commit${result.commits.total === 1 ? "" : "s"}.` : "";
	emit({ phase: "done", message: `${result.message}.${pulled}${skillsLine(skills)}`, reload: true, extensionBuild });
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
	const { mode, root } = detectMode();
	try {
		if (mode === "unmanaged") {
			throw new UpdateError(
				`This Tabkyra runs from ${root}, which is neither a release install nor a git checkout, so it can't update itself from the side panel. Run tabkyra update in a terminal.`,
			);
		}
		if (mode === "release") {
			if (action === "update") await releaseUpdate();
			else if (action === "rollback") releaseRollback();
			else releaseReinstall();
		} else if (action === "rollback") checkoutRollback(root);
		else await checkoutUpdate(root, action === "update");
		return 0;
	} catch (err) {
		emit({ phase: "failed", message: err instanceof Error ? err.message : String(err) });
		return 1;
	}
}
