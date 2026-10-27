// The update system's decisions (src/update/logic.ts): the no-parameters rule for update
// requests, the idle gate before a reload, where the extension runs from, version mismatches,
// automatic updates and the "What's new" card.
import assert from "node:assert/strict";
import test from "node:test";
import {
	AUTO_UPDATE_QUIET_MS,
	BRIDGE_RUN_GAP_MS,
	diagnoseVersions,
	idleGate,
	locateExtension,
	offerKey,
	parseUpdateRequest,
	safeLink,
	shouldAutoUpdate,
	UPDATE_ACTIONS,
	whatsNewFor,
} from "../src/update/logic.ts";

const build = (id, commit, version = "1.2.0") => ({ id, commit, version, builtAt: "" });

test("an update request is exactly {type, action} with a known action", () => {
	for (const action of UPDATE_ACTIONS) assert.equal(parseUpdateRequest({ type: "update_action", action }), action);
	const refused = [
		{ type: "update_action", action: "update", channel: "nightly" },
		{ type: "update_action", action: "update", args: ["--yes"] },
		{ type: "update_action", action: "update; rm -rf ~" },
		{ type: "update_action", action: "--rollback" },
		{ type: "update_action", action: ["update"] },
		{ type: "update_action" },
		{ type: "hello", action: "update" },
		{ action: "update" },
		["update_action", "update"],
		"update",
		null,
		undefined,
		Object.assign(Object.create({ inherited: 1 }), { type: "update_action", action: "toString" }),
	];
	for (const frame of refused) assert.equal(parseUpdateRequest(frame), undefined, JSON.stringify(frame));
});

test("the idle gate waits for side panel runs and bridge requests", () => {
	const now = 1_000_000;
	const quiet = { now, busyPanels: 0, lastPanelRunAt: 0, bridge: [] };
	assert.deepEqual(idleGate(quiet), { idle: true });

	const panel = idleGate({ ...quiet, busyPanels: 1 });
	assert.equal(panel.idle, false);
	assert.match(panel.reason, /side panel/);
	assert.match(idleGate({ ...quiet, busyPanels: 2 }).reason, /2 side panels/);

	const harness = idleGate({ ...quiet, bridge: [{ name: "claude", inFlight: true, lastActivityAt: now }] });
	assert.equal(harness.idle, false);
	assert.match(harness.reason, /claude is using the browser/);

	// A harness between two calls of one run still counts as running for a moment.
	const between = { ...quiet, bridge: [{ name: "codex", inFlight: false, lastActivityAt: now - 5000 }] };
	assert.equal(idleGate(between).idle, false);
	assert.equal(idleGate({ ...between, now: now + BRIDGE_RUN_GAP_MS }).idle, true);

	// Automatic updates also want a few quiet minutes after the last panel run.
	const justEnded = { ...quiet, lastPanelRunAt: now - 60_000 };
	assert.equal(idleGate(justEnded).idle, true);
	assert.equal(idleGate(justEnded, AUTO_UPDATE_QUIET_MS).idle, false);
	assert.equal(idleGate({ ...justEnded, now: now - 60_000 + AUTO_UPDATE_QUIET_MS }, AUTO_UPDATE_QUIET_MS).idle, true);
	const harnessEarlier = { ...quiet, bridge: [{ name: "pi", inFlight: false, lastActivityAt: now - 2 * 60_000 }] };
	assert.equal(idleGate(harnessEarlier).idle, true);
	assert.equal(idleGate(harnessEarlier, AUTO_UPDATE_QUIET_MS).idle, false);
});

test("the extension is located by the build-info.json its folder serves", () => {
	assert.equal(locateExtension("a", "a"), "here");
	assert.equal(locateExtension("a", "b"), "elsewhere");
	assert.equal(locateExtension(undefined, "b"), "unknown");
	assert.equal(locateExtension("a", undefined), "unknown");
});

test("version mismatch: a half-installed update, a stale extension, a stale host", () => {
	const a = build("ext-a", "aaa");
	const aCli = build("cli-a", "aaa");
	const b = build("ext-b", "bbb", "1.2.1");
	const bCli = build("cli-b", "bbb", "1.2.1");

	assert.equal(diagnoseVersions({ extension: b, extensionOnDisk: b, location: "here", host: bCli, cliOnDisk: bCli }), undefined);

	const partial = diagnoseVersions({ extension: a, extensionOnDisk: b, location: "here", host: aCli, cliOnDisk: aCli });
	assert.equal(partial.fix, "reinstall");
	assert.match(partial.reason, /stopped partway/);

	const stale = diagnoseVersions({ extension: a, extensionOnDisk: b, location: "here", host: bCli, cliOnDisk: bCli });
	assert.equal(stale.fix, "reload");
	assert.match(stale.reason, /browser still runs 1\.2\.0 \(aaa\)/);

	// Loaded from another folder: reloading wouldn't help, so it isn't offered.
	assert.equal(diagnoseVersions({ extension: a, extensionOnDisk: b, location: "elsewhere", host: bCli, cliOnDisk: bCli }), undefined);

	const host = diagnoseVersions({ extension: b, extensionOnDisk: b, location: "here", host: aCli, cliOnDisk: bCli });
	assert.equal(host.fix, "reload");
	assert.match(host.reason, /native host/);

	// A rebuild of the same commit is not a mismatch; builds without build-info are skipped.
	const rebuilt = build("ext-a2", "aaa");
	assert.equal(diagnoseVersions({ extension: rebuilt, extensionOnDisk: a, location: "here", host: aCli, cliOnDisk: aCli }), undefined);
	assert.equal(diagnoseVersions({ location: "unknown" }), undefined);
	assert.equal(diagnoseVersions({ extension: a, location: "here", host: aCli }), undefined);
});

test("automatic updates: only with the setting, only something new, never twice", () => {
	const release = { type: "update_status", mode: "release", policy: "auto", available: true, current: "1.2.0", latest: "1.2.1", channel: "stable", checkedAt: 0 };
	assert.equal(shouldAutoUpdate(release), true);
	assert.equal(shouldAutoUpdate({ ...release, policy: "notify" }), false);
	assert.equal(shouldAutoUpdate({ ...release, policy: "off" }), false);
	assert.equal(shouldAutoUpdate({ ...release, available: false }), false);
	assert.equal(shouldAutoUpdate({ ...release, blocked: "local changes" }), false);
	assert.equal(shouldAutoUpdate({ ...release, error: "offline" }), false);
	assert.equal(shouldAutoUpdate({ ...release, mismatch: { fix: "reload", reason: "x" } }), false);
	assert.equal(shouldAutoUpdate({ ...release, mode: "unmanaged" }), false);
	assert.equal(shouldAutoUpdate(release, offerKey(release)), false, "a failed attempt is not retried");
	assert.equal(shouldAutoUpdate(release, "release:1.2.0"), true);
	// The user rolled back from 1.2.1: don't put it straight back.
	const rolledBack = { ...release, lastUpdate: { id: "x", kind: "rollback", mode: "release", at: 0, from: "1.2.1", to: "1.2.0" } };
	assert.equal(shouldAutoUpdate(rolledBack), false);
	assert.equal(shouldAutoUpdate({ ...rolledBack, latest: "1.2.2" }), true);

	const checkout = { ...release, mode: "checkout", latest: "abc1234", behind: 2 };
	assert.equal(shouldAutoUpdate(checkout), true);
	// After a checkout rollback only the build is behind; that waits for the user or a new commit.
	assert.equal(shouldAutoUpdate({ ...checkout, behind: 0, needsBuild: true }), false);
	assert.equal(shouldAutoUpdate(undefined), false);
});

test("what's new shows after the reload into the new build, until dismissed", () => {
	const last = { id: "u1", kind: "update", mode: "checkout", at: 0, from: "a", to: "b", extensionBuild: "new" };
	assert.equal(whatsNewFor(last, undefined, "old"), undefined, "not before the reload");
	assert.equal(whatsNewFor(last, undefined, "new"), last);
	assert.equal(whatsNewFor(last, "u1", "new"), undefined);
	assert.equal(whatsNewFor({ ...last, kind: "rollback" }, undefined, "new"), undefined);
	assert.equal(whatsNewFor({ ...last, extensionBuild: undefined }, undefined, undefined), undefined);
	assert.equal(whatsNewFor(undefined, undefined, "new"), undefined);
});

test("only https links reach the What's new card", () => {
	assert.equal(safeLink("https://github.com/baney75/tabkyra/compare/a...b"), "https://github.com/baney75/tabkyra/compare/a...b");
	assert.equal(safeLink("javascript:alert(1)"), undefined);
	assert.equal(safeLink("http://example.com"), undefined);
	assert.equal(safeLink("not a url"), undefined);
	assert.equal(safeLink(undefined), undefined);
});
