/**
 * `tabkyra setup`: build, register, wire up the harnesses, then load and connect.
 * Interactive by default; `--yes` accepts every offer. It edits a harness config only
 * after a yes and always points harnesses at the absolute path of the tabkyra launcher.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BridgeClient, listSockets } from "./client.ts";
import { buildState, builtVersion, sourceVersion } from "./doctor.ts";
import { harnesses, runAdd, shellJoin, tabkyraBinary, which } from "./harness.ts";
import { browserDirs, install } from "./install.ts";
import { extensionDir, repoRoot } from "./paths.ts";
import { banner, box, c, confirm, sym } from "./ui.ts";
import { VERSION } from "./version.ts";

export interface SetupOptions {
	yes: boolean;
	/** Skip waiting for the extension to connect. */
	wait: boolean;
	/** Seconds to wait for the extension; 0 waits until Ctrl+C. */
	timeoutS: number;
}

/** Without a terminal nobody can press Ctrl+C on an endless wait, so it gets a bound. */
export const UNATTENDED_TIMEOUT_S = 300;

function step(n: number, title: string): void {
	console.log();
	console.log(`${c.brass(`${n}.`)} ${c.bold(title)}`);
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
	console.log(`  ${c.dim(`$ ${shellJoin([command, ...args])}`)}`);
	const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
	return result.status === 0;
}

async function ensureBuild(options: SetupOptions): Promise<boolean> {
	const state = buildState();
	if (state === "ok") {
		console.log(`  ${sym.ok} Extension built ${c.dim(`(${builtVersion()}, ${extensionDir()})`)}`);
		return true;
	}
	const root = repoRoot();
	console.log(
		state === "missing"
			? `  ${sym.warn} No extension build at ${extensionDir()}`
			: `  ${sym.warn} The extension build (${builtVersion()}) is older than this checkout (${sourceVersion()})`,
	);
	if (!(await confirm(`  ${state === "missing" ? "Build" : "Rebuild"} it now? This takes about a minute.`, { assumeYes: options.yes }))) {
		console.log(`  Build it yourself with: ${c.bold(`cd ${shellJoin([root])} && ./scripts/setup-siblings.sh && npm run build`)}`);
		return false;
	}
	// The extension compiles against sibling checkouts of pi-mono and mini-lit.
	if (!existsSync(join(root, "..", "pi-mono")) || !existsSync(join(root, "node_modules"))) {
		if (!run("./scripts/setup-siblings.sh", [], root)) {
			console.log(`  ${sym.fail} Sibling setup failed. Fix the error above, then run ${c.bold("tabkyra setup")} again.`);
			return false;
		}
	}
	if (!run("npm", ["run", "build"], root, { ...process.env, TABKYRA_NO_BUMP: "1" }) || buildState() !== "ok") {
		console.log(`  ${sym.fail} The build failed. Fix the error above, then run ${c.bold("tabkyra setup")} again.`);
		return false;
	}
	console.log(`  ${sym.ok} Extension built ${c.dim(`(${builtVersion()})`)}`);
	return true;
}

function registerHost(): boolean {
	const result = install();
	if (process.platform === "win32") {
		for (const key of result.written) console.log(`  ${sym.ok} ${key}`);
		return result.written.length > 0;
	}
	const present = browserDirs().filter(({ dir }) => existsSync(dir));
	if (present.length === 0) {
		console.log(`  ${sym.fail} No Chromium browser profile found. Open your browser once, then run ${c.bold("tabkyra setup")} again.`);
		return false;
	}
	for (const { name, dir } of present) {
		const changed = result.written.some((w) => w.startsWith(join(dir, "NativeMessagingHosts")));
		console.log(`  ${sym.ok} ${name.padEnd(13)} ${c.dim(changed ? "registered" : "already registered")}`);
	}
	return true;
}

function copyToClipboard(text: string): boolean {
	const candidates: Array<[string, string[]]> =
		process.platform === "darwin"
			? [["pbcopy", []]]
			: process.platform === "win32"
				? [["clip", []]]
				: [
						["wl-copy", []],
						["xclip", ["-selection", "clipboard"]],
						["xsel", ["--clipboard", "--input"]],
					];
	for (const [command, args] of candidates) {
		if (process.platform !== "win32" && !which(command)) continue;
		try {
			execFileSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
			return true;
		} catch {
			/* try the next one */
		}
	}
	return false;
}

/** True when some live bridge socket reports the extension connected. */
async function extensionConnected(): Promise<boolean> {
	let sockets: string[] = [];
	try {
		sockets = listSockets();
	} catch {
		return false;
	}
	for (const path of sockets) {
		const client = new BridgeClient({ name: "setup" });
		try {
			await client.connect(path);
			if (client.extensionConnected) return true;
		} catch {
			/* not this one */
		} finally {
			client.close();
		}
	}
	return false;
}

/** Offer each detected harness the MCP server. Returns false if an attempted add failed. */
async function connectHarnesses(options: SetupOptions): Promise<boolean> {
	const binary = tabkyraBinary();
	const found = harnesses(binary).filter((h) => h.detected);
	if (found.length === 0) {
		console.log(`  No coding harness found. Any MCP client can run: ${c.bold(`${binary} mcp`)}`);
		return true;
	}
	let ok = true;
	for (const h of found) {
		if (h.configured === true) {
			console.log(`  ${sym.ok} ${h.name.padEnd(12)} ${c.dim("already has Tabkyra")}`);
			continue;
		}
		const stale = h.configured === "stale";
		if (h.addCommand) {
			const commands = stale && h.removeCommand ? [h.removeCommand, h.addCommand] : [h.addCommand];
			const shown = commands.map(shellJoin).join(" && ");
			// Windows harness CLIs are .cmd shims that need a shell; print the command there instead.
			if (process.platform === "win32") {
				console.log(`  ${sym.dot} ${c.bold(h.name)}: run ${shown}`);
				continue;
			}
			const question = stale ? `Point ${c.bold(h.name)}'s tabkyra entry at this install?` : `Add Tabkyra to ${c.bold(h.name)}?`;
			if (await confirm(`  ${sym.dot} ${question} ${c.dim(`(${shown})`)}`, { assumeYes: options.yes })) {
				if (commands.every(runAdd)) console.log(`  ${sym.ok} ${h.name} is set up.`);
				else {
					ok = false;
					console.log(`  ${sym.fail} That failed. Run it yourself: ${c.bold(shown)}`);
				}
			} else {
				console.log(`    ${c.dim("Later:")} ${shown}`);
			}
			continue;
		}
		if (h.snippet?.startsWith("{")) {
			console.log(`  ${sym.dot} ${c.bold(h.name)}: ${stale ? "replace the tabkyra entry in" : "add this to"} ${c.cyan(h.configFile ?? "its MCP config")}`);
			for (const line of h.snippet.split("\n")) console.log(`    ${line}`);
		} else if (h.snippet) {
			console.log(`  ${sym.dot} ${c.bold(h.name)}: run ${c.bold(h.snippet)}`);
		}
	}
	return ok;
}

async function loadExtension(options: SetupOptions): Promise<boolean> {
	if (await extensionConnected()) {
		console.log(`  ${sym.ok} The extension is loaded and connected.`);
		return true;
	}
	const dir = extensionDir();
	console.log(
		box(
			[
				`${c.brass("1")}  Open ${c.bold("chrome://extensions")}, turn on ${c.bold("Developer mode")},`,
				`   and click ${c.bold("Load unpacked")}.`,
				`${c.brass("2")}  Pick this folder:`,
				`   ${c.cyan(dir)}`,
				`${c.brass("3")}  Click ${c.bold("Details")} on Tabkyra and turn on ${c.bold("Allow user scripts")}.`,
			],
			"One step in your browser",
		),
	);
	console.log(c.dim("  Browsers require this step by hand. In Helium, Brave or Edge the page is the same."));
	// Offered only at a terminal: --yes and scripted runs never overwrite the clipboard.
	if (process.stdin.isTTY && !options.yes && (await confirm("  Copy the folder path to the clipboard?", { assumeYes: false }))) {
		console.log(copyToClipboard(dir) ? `  ${sym.ok} Copied.` : `  ${sym.warn} No clipboard tool found; copy the path above.`);
	}
	if (!options.wait) {
		console.log(`  ${c.dim("Not waiting (--no-wait). Check later with")} ${c.bold("tabkyra status")}`);
		return false;
	}

	const deadline = options.timeoutS > 0 ? Date.now() + options.timeoutS * 1000 : Number.POSITIVE_INFINITY;
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	const live = Boolean(process.stdout.isTTY);
	let frame = 0;
	if (!live) console.log(`  Waiting up to ${options.timeoutS} s for the extension to connect...`);
	while (Date.now() < deadline) {
		if (await extensionConnected()) {
			if (live) process.stdout.write("\r\x1b[2K");
			console.log(`  ${sym.ok} ${c.bold("Connected.")} Tabkyra can reach your browser.`);
			return true;
		}
		if (live) process.stdout.write(`\r  ${c.brass(frames[frame++ % frames.length])} Waiting for the extension to connect ${c.dim("(Ctrl+C to stop)")}`);
		await new Promise((r) => setTimeout(r, 1000));
	}
	if (live) process.stdout.write("\r\x1b[2K");
	console.log(`  ${sym.fail} The extension did not connect within ${options.timeoutS} s.`);
	console.log(`  If it is loaded, reload it once on chrome://extensions, then run ${c.bold("tabkyra doctor")}.`);
	return false;
}

export async function runSetup(options: SetupOptions): Promise<number> {
	const timeoutS = options.timeoutS || (process.stdin.isTTY ? 0 : UNATTENDED_TIMEOUT_S);
	const opts = { ...options, timeoutS };
	console.log(banner(`setup ${VERSION}`));
	console.log(c.dim("You steer. Your agents work the tabs."));

	step(1, "Build the extension");
	if (!(await ensureBuild(opts))) return 1;

	step(2, "Register the native host with your browsers");
	if (!registerHost()) return 1;

	// Harnesses come before the wait, so an unattended run configures them even if the
	// browser step is still to come.
	step(3, "Connect your coding agents");
	const harnessesOk = await connectHarnesses(opts);

	step(4, "Load the extension");
	const connected = await loadExtension(opts);

	console.log();
	if (connected && harnessesOk) {
		console.log(`${sym.ok} ${c.bold("Tabkyra is ready.")} Ask your agent to open a page, for example:`);
		console.log(`  ${c.dim('"Use tabkyra to open news.ycombinator.com and list the top five stories."')}`);
		return 0;
	}
	const next = connected ? "fix the agent step above" : "load the extension";
	console.log(`${sym.warn} ${c.bold("Almost there.")} ${next[0].toUpperCase()}${next.slice(1)}, then run ${c.bold("tabkyra doctor")} to check everything.`);
	return 1;
}
