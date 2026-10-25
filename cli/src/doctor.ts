/**
 * `tabkyra doctor`: every check that has to pass for an agent to drive a tab, with
 * one exact fix per failure. Exits 1 when any check fails.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_HOST_NAME } from "../../src/bridge/protocol.ts";
import { BridgeClient, listSockets } from "./client.ts";
import { harnesses, shellJoin } from "./harness.ts";
import { browserDirs, EXTENSION_ID, launcherPath } from "./install.ts";
import { EXTENSION_FILES, extensionDir, repoRoot } from "./paths.ts";
import { banner, c, sym } from "./ui.ts";
import { VERSION } from "./version.ts";

export interface Check {
	id: string;
	/** "warn" is shown but does not fail the run. */
	status: "ok" | "fail" | "warn";
	label: string;
	detail?: string;
	fix?: string;
}

const MIN_NODE_MAJOR = 20;

function nodeCheck(): Check {
	const major = Number(process.versions.node.split(".")[0]);
	return major >= MIN_NODE_MAJOR
		? { id: "node", status: "ok", label: `Node ${process.versions.node}` }
		: {
				id: "node",
				status: "fail",
				label: `Node ${process.versions.node} is too old`,
				detail: `Tabkyra needs Node ${MIN_NODE_MAJOR} or newer.`,
				fix: process.platform === "darwin" ? "brew install node" : "Install Node 20+ from https://nodejs.org",
			};
}

/** Reads dist-chrome/manifest.json; undefined when the build is missing or incomplete. */
export function builtVersion(): string | undefined {
	const dir = extensionDir();
	if (!EXTENSION_FILES.every((f) => existsSync(join(dir, f)))) return undefined;
	try {
		return (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version?: string }).version;
	} catch {
		return undefined;
	}
}

/** Version in the checkout's static/manifest.chrome.json, which every build copies. */
export function sourceVersion(): string | undefined {
	try {
		return (JSON.parse(readFileSync(join(repoRoot(), "static", "manifest.chrome.json"), "utf8")) as { version?: string }).version;
	} catch {
		return undefined;
	}
}

/** "missing", "stale" (built from another version of this checkout) or "ok". */
export function buildState(): "missing" | "stale" | "ok" {
	const built = builtVersion();
	if (!built) return "missing";
	const source = sourceVersion();
	return source && source !== built ? "stale" : "ok";
}

function buildCheck(): Check {
	const dir = extensionDir();
	const state = buildState();
	if (state === "missing") {
		return { id: "build", status: "fail", label: "Extension build missing", detail: `${dir} is missing or incomplete.`, fix: "tabkyra setup" };
	}
	if (state === "stale") {
		return {
			id: "build",
			status: "fail",
			label: `Extension build ${builtVersion()} is older than this checkout (${sourceVersion()})`,
			detail: "The checkout changed since dist-chrome was built.",
			fix: "tabkyra setup",
		};
	}
	return { id: "build", status: "ok", label: `Extension build ${builtVersion()}`, detail: dir };
}

function hostChecks(): Check[] {
	if (process.platform === "win32") return [];
	const origin = `chrome-extension://${EXTENSION_ID}/`;
	const launcher = launcherPath();
	const found = browserDirs().filter(({ dir }) => existsSync(dir));
	if (found.length === 0) {
		return [
			{
				id: "host",
				status: "fail",
				label: "No Chromium browser found",
				detail: "Tabkyra works with Helium, Chrome, Chromium, Brave, Edge, Arc, Vivaldi and Opera.",
				fix: "Install a Chromium browser, then run: tabkyra setup",
			},
		];
	}
	return found.map(({ name, dir }) => {
		const file = join(dir, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
		const fail = (detail: string): Check => ({
			id: `host:${name}`,
			status: "fail",
			label: `${name}: native host ${existsSync(file) ? "manifest is wrong" : "not registered"}`,
			detail,
			fix: "tabkyra install --force",
		});
		if (!existsSync(file)) return fail(file);
		let manifest: { name?: string; path?: string; allowed_origins?: string[] };
		try {
			manifest = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return fail(`${file} is not valid JSON`);
		}
		if (manifest.name !== NATIVE_HOST_NAME) return fail(`name is ${manifest.name}, expected ${NATIVE_HOST_NAME}`);
		const origins = manifest.allowed_origins ?? [];
		if (origins.length !== 1 || origins[0] !== origin) {
			return fail(`allowed_origins is ${JSON.stringify(origins)}, expected ["${origin}"] (extension id ${EXTENSION_ID})`);
		}
		if (manifest.path !== launcher) return fail(`path is ${manifest.path}, expected ${launcher}`);
		if (!existsSync(launcher) || (statSync(launcher).mode & 0o111) === 0) return fail(`${launcher} is missing or not executable`);
		return { id: `host:${name}`, status: "ok", label: `${name}: native host registered`, detail: file };
	});
}

interface DebugInfo {
	version?: string;
	userScriptsApi?: boolean;
}

async function connectionChecks(): Promise<Check[]> {
	const notConnected: Check = {
		id: "connected",
		status: "fail",
		label: "Extension not connected",
		detail: "No running browser has the Tabkyra extension loaded, or it has not reached the native host yet.",
		fix: "tabkyra setup",
	};
	let sockets: string[];
	try {
		sockets = listSockets();
	} catch (err) {
		return [{ ...notConnected, detail: err instanceof Error ? err.message : String(err) }];
	}
	for (const path of sockets) {
		const client = new BridgeClient({ name: "doctor" });
		try {
			await client.connect(path);
		} catch {
			client.close();
			continue;
		}
		if (!client.extensionConnected) {
			client.close();
			continue;
		}
		try {
			const info = (await client.call("bridge.debug", {}, 5000)) as DebugInfo;
			const checks: Check[] = [{ id: "connected", status: "ok", label: `Extension connected (${info.version ?? "unknown version"})`, detail: path }];
			const built = builtVersion();
			if (built && info.version && built !== info.version) {
				checks.push({
					id: "loaded-version",
					status: "fail",
					label: `The browser runs extension ${info.version}, the build is ${built}`,
					fix: "tabkyra reload",
				});
			}
			if (info.userScriptsApi === false) {
				checks.push({
					id: "user-scripts",
					status: "warn",
					label: '"Allow user scripts" is off',
					detail: "Page scripts fall back to a slower path. Turn it on in the extension's Details page.",
				});
			}
			return checks;
		} catch (err) {
			return [
				{
					id: "connected",
					status: "fail",
					label: "Extension connected but not responding",
					detail: err instanceof Error ? err.message : String(err),
					fix: "tabkyra reload",
				},
			];
		} finally {
			client.close();
		}
	}
	return [notConnected];
}

function harnessChecks(): Check[] {
	return harnesses()
		.filter((h) => h.detected)
		.map((h): Check => {
			if (h.configured === true) return { id: `mcp:${h.id}`, status: "ok", label: `${h.name}: Tabkyra MCP server configured` };
			const stale = h.configured === "stale";
			let fix: string;
			if (h.addCommand) fix = stale && h.removeCommand ? `${shellJoin(h.removeCommand)} && ${shellJoin(h.addCommand)}` : shellJoin(h.addCommand);
			else if (h.snippet?.startsWith("{")) fix = `${stale ? "Replace the tabkyra entry in" : "Add this to"} ${h.configFile}:\n${h.snippet}`;
			else fix = h.snippet ?? "";
			const state = stale ? "runs a different command" : h.configured === undefined ? "unknown (config unreadable)" : "not configured";
			return {
				id: `mcp:${h.id}`,
				// A harness the user doesn't browse from shouldn't fail the run; Claude Code and
				// Codex are fixed with one command, and a stale entry is always broken, so those count.
				status: stale || h.id === "claude" || h.id === "codex" ? "fail" : "warn",
				label: `${h.name}: Tabkyra MCP server ${state}`,
				fix,
			};
		});
}

export async function runDoctor(options: { json: boolean }): Promise<number> {
	const checks: Check[] = [nodeCheck(), buildCheck(), ...hostChecks(), ...(await connectionChecks()), ...harnessChecks()];
	const failed = checks.filter((check) => check.status === "fail").length;
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ ok: failed === 0, version: VERSION, checks }, null, 2)}\n`);
		return failed === 0 ? 0 : 1;
	}
	console.log(banner(`doctor ${VERSION}`));
	console.log();
	for (const check of checks) {
		const mark = check.status === "ok" ? sym.ok : check.status === "warn" ? sym.warn : sym.fail;
		console.log(`${mark} ${check.label}`);
		if (check.detail && check.status !== "ok") console.log(`  ${c.dim(check.detail)}`);
		if (check.fix) {
			const [first, ...rest] = check.fix.split("\n");
			console.log(`  ${sym.arrow} ${c.bold(first)}`);
			for (const line of rest) console.log(`    ${line}`);
		}
	}
	console.log();
	console.log(
		failed === 0
			? `${sym.ok} ${c.bold("All checks passed.")}`
			: `${sym.fail} ${c.bold(`${failed} check${failed === 1 ? "" : "s"} failed.`)} Run the ${sym.arrow} command under each, then run ${c.bold("tabkyra doctor")} again.`,
	);
	return failed === 0 ? 0 : 1;
}
