import { existsSync } from "node:fs";
import { join } from "node:path";
import { BridgeClient, BridgeRpcError, isConnectionError, listSockets, NOT_CONNECTED } from "./client.ts";
import { runDoctor } from "./doctor.ts";
import { runNativeHost } from "./host.ts";
import { hostStatus, install, isInstalled } from "./install.ts";
import { runMcpServer } from "./mcp.ts";
import { EXTENSION_FILES, extensionDir } from "./paths.ts";
import { writePiExtension } from "./pi-extension.ts";
import { runSetup, type SetupOptions } from "./setup.ts";
import { banner, c, sym } from "./ui.ts";
import { VERSION } from "./version.ts";

const cmd = (name: string, args: string, what: string) => `  ${c.bold(`tabkyra ${name}`)}${args ? ` ${args}` : ""}`.padEnd(40) + what;

function help(): string {
	const section = (title: string) => `\n${c.brass(title)}`;
	return [
		`${banner(VERSION)}`,
		c.dim("A browser your coding agents can drive, in its own tab group, under your command."),
		section("Get started"),
		cmd("setup", "[--yes]", "Build, register, load, connect and add to your agents"),
		cmd("status", "[--json]", "Is the extension connected? Which sites are allowed?"),
		section("Agents"),
		cmd("mcp", "", "MCP server on stdio (what Claude Code, Codex, OpenCode run)"),
		cmd("pi-extension", "", "Write a pi extension to ~/.pi/agent/extensions/tabkyra.ts"),
		`  ${c.dim("Claude Code:")} claude mcp add --scope user tabkyra -- ~/.config/tabkyra/tabkyra mcp`,
		`  ${c.dim("Codex:")}       codex mcp add tabkyra -- ~/.config/tabkyra/tabkyra mcp`,
		`  ${c.dim("(tabkyra setup adds these for you.)")}`,
		section("Sites"),
		cmd("allow", "<host>", "Let agents open a site (subdomains included)"),
		cmd("ask", "", "Agents ask before opening a site not yet allowed (default)"),
		cmd("allow-all", "", "Agents may open any site without asking"),
		section("Troubleshoot"),
		cmd("doctor", "[--json]", "Check everything; one fix per problem"),
		cmd("install", "[--force]", "Re-register the native host with every browser"),
		cmd("reload", "", "Reload the extension after rebuilding dist-chrome"),
		cmd("debug", "", "Bridge state, request timings and a benchmark"),
		"",
		`${c.dim("Flags:")} --help, --version. ${c.dim("Docs:")} https://github.com/baney75/tabkyra`,
		"",
	].join("\n");
}

/** NOT_CONNECTED is written for agents; people at the terminal get the direct version. */
const NOT_CONNECTED_HERE =
	"Tabkyra isn't connected. Open Helium or Chrome with the Tabkyra extension loaded, or run `tabkyra doctor` to see why.";
const forPeople = (message: string) => (message === NOT_CONNECTED ? NOT_CONNECTED_HERE : message);

/** "https://GitHub.com/x" or "github.com" -> "github.com"; undefined for anything that isn't a host. */
function siteHost(value: string | undefined): string | undefined {
	if (!value || value.startsWith("-")) return undefined;
	let host = value.trim().toLowerCase();
	if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
		try {
			host = new URL(host).hostname;
		} catch {
			return undefined;
		}
	}
	host = host.replace(/\/.*$/, "").replace(/:\d+$/, "");
	// A real site has a dot ("github.com", "127.0.0.1"); a bare label like "com" would allow a whole TLD.
	if (host !== "localhost" && !host.includes(".")) return undefined;
	return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host) ? host : undefined;
}

/** Errors that end a command: say what went wrong and the next step. */
class UsageError extends Error {}

async function withBridge<T>(name: string, fn: (client: BridgeClient) => Promise<T>): Promise<T> {
	const client = new BridgeClient({ name });
	try {
		try {
			await client.connect();
		} catch (err) {
			// No socket, a refused one, a wedged host: all mean the same thing to the person.
			if (isConnectionError(err) || (err instanceof Error && err.message.startsWith("The bridge at "))) throw new Error(NOT_CONNECTED);
			throw err;
		}
		if (!client.extensionConnected) throw new Error(NOT_CONNECTED);
		return await fn(client);
	} finally {
		client.close();
	}
}

/** Parse `setup` flags strictly: a typo should not silently change what setup does. */
function parseSetupArgs(args: string[]): SetupOptions | string {
	const options: SetupOptions = { yes: false, wait: true, timeoutS: 0 };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--yes" || arg === "-y") options.yes = true;
		else if (arg === "--no-wait") options.wait = false;
		else if (arg === "--timeout" || arg.startsWith("--timeout=")) {
			const raw = arg === "--timeout" ? args[++i] : arg.slice("--timeout=".length);
			const seconds = Number(raw);
			if (!raw || !Number.isFinite(seconds) || seconds <= 0) return `--timeout needs a number of seconds above 0, got "${raw ?? ""}".`;
			options.timeoutS = seconds;
		} else return `Unknown option "${arg}".`;
	}
	return options;
}

interface StatusReport {
	connected: boolean;
	hosts: Array<{ browser: string; state: string; file: string }>;
	extensionVersion?: string;
	permissionMode?: string;
	allowedHosts?: string[];
	message?: string;
}

async function status(json: boolean): Promise<number> {
	const report: StatusReport = {
		connected: false,
		hosts: hostStatus().map((b) => ({ browser: b.name, state: b.state, file: b.file })),
	};
	try {
		for (const path of listSockets()) {
			const client = new BridgeClient({ name: "status" });
			try {
				await client.connect(path);
				if (!client.extensionConnected) continue;
				// 20 s: above the extension's 15 s session-open limit.
				const info = (await client.call("status", {}, 20000, { retry: false })) as {
					extensionVersion: string;
					permissionMode: string;
					allowedHosts: string[];
				};
				report.connected = true;
				report.extensionVersion = info.extensionVersion;
				report.permissionMode = info.permissionMode;
				report.allowedHosts = info.allowedHosts;
				report.message = undefined;
				break;
			} catch (err) {
				// Keep the reason; a later socket may still answer.
				report.message =
					err instanceof BridgeRpcError ? `The extension answered with an error: ${err.rpc.code}: ${err.rpc.message}` : err instanceof Error ? err.message : String(err);
			} finally {
				client.close();
			}
		}
	} catch (err) {
		report.message = err instanceof Error ? err.message : String(err);
	}
	if (!report.connected) report.message = forPeople(report.message ?? NOT_CONNECTED);

	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return report.connected ? 0 : 1;
	}
	console.log(banner("status"));
	console.log();
	if (report.connected) {
		console.log(`${sym.ok} Extension connected ${c.dim(`(${report.extensionVersion})`)}`);
		const allowed = report.allowedHosts?.length ? report.allowedHosts.join(", ") : "none yet";
		console.log(
			report.permissionMode === "allow_all"
				? `${sym.warn} Agents may open any site ${c.dim("(tabkyra ask turns prompts back on)")}`
				: `${sym.ok} Agents ask before opening a new site. Allowed: ${allowed}`,
		);
	} else {
		console.log(`${sym.fail} ${report.message}`);
	}
	if (!isInstalled()) console.log(`${sym.fail} Native host not registered ${sym.arrow} ${c.bold("tabkyra setup")}`);
	for (const h of report.hosts) {
		const mark = h.state === "current" ? sym.ok : sym.fail;
		console.log(`${mark} ${h.browser.padEnd(13)} ${c.dim(h.state === "current" ? "host registered" : `host ${h.state}`)}`);
	}
	if (!report.connected) console.log(`\n${sym.arrow} Run ${c.bold("tabkyra doctor")} for the exact fix.`);
	return report.connected ? 0 : 1;
}

/** Options each command accepts; anything else is a usage error. `setup` parses its own. */
const ACCEPTS: Record<string, { flags: string[]; positional: number }> = {
	doctor: { flags: ["--json"], positional: 0 },
	status: { flags: ["--json"], positional: 0 },
	install: { flags: ["--force"], positional: 0 },
	allow: { flags: [], positional: 1 },
	"allow-all": { flags: [], positional: 0 },
	yolo: { flags: [], positional: 0 },
	ask: { flags: [], positional: 0 },
	reload: { flags: [], positional: 0 },
	debug: { flags: [], positional: 0 },
	mcp: { flags: [], positional: 0 },
	"pi-extension": { flags: [], positional: 1 },
};

function checkArgs(command: string, args: string[]): void {
	const accepts = ACCEPTS[command];
	if (!accepts) return;
	const flags = args.filter((a) => a.startsWith("-"));
	const positional = args.filter((a) => !a.startsWith("-"));
	const unknown = flags.find((f) => !accepts.flags.includes(f));
	const usage = `Usage: tabkyra ${command}${accepts.flags.map((f) => ` [${f}]`).join("")}${command === "allow" ? " <host>" : command === "pi-extension" ? " [dir]" : ""}`;
	if (unknown) throw new UsageError(`Unknown option "${unknown}". ${usage}`);
	if (positional.length > accepts.positional) throw new UsageError(`Unexpected argument "${positional[accepts.positional]}". ${usage}`);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const [command] = argv;
	const flag = (name: string) => argv.includes(name);
	if (command && command !== "host" && (flag("--help") || flag("-h"))) {
		process.stdout.write(help());
		return;
	}
	// `host` is spawned by the browser with its origin as an argument; leave it alone.
	if (command && command !== "host") checkArgs(command, argv.slice(1));
	switch (command) {
		case "setup": {
			const parsed = parseSetupArgs(argv.slice(1));
			if (typeof parsed === "string") throw new UsageError(`${parsed} Usage: tabkyra setup [--yes] [--no-wait] [--timeout <seconds>]`);
			process.exitCode = await runSetup(parsed);
			return;
		}
		case "doctor":
			process.exitCode = await runDoctor({ json: flag("--json") });
			return;
		case "status":
			process.exitCode = await status(flag("--json"));
			return;
		case "host":
			runNativeHost();
			return;
		case "mcp":
			await runMcpServer();
			return;
		case "install": {
			const result = install({ force: flag("--force") });
			console.log(`${sym.ok} Launcher ${c.dim(result.launcher)}`);
			for (const f of result.written) console.log(`${sym.ok} Wrote ${c.dim(f)}`);
			for (const f of result.skipped) console.log(`${sym.ok} Current ${c.dim(f)}`);
			if (result.written.length + result.skipped.length === 0) {
				console.log(`${sym.fail} No Chromium browser profile found. Open your browser once, then run this again.`);
				process.exitCode = 1;
				return;
			}
			if (result.written.length > 0) console.log(c.dim("If the extension was already loaded, reload it once on chrome://extensions."));
			return;
		}
		case "allow": {
			const host = siteHost(argv[1]);
			if (!host) throw new UsageError("Which site? Give a host name, for example: tabkyra allow github.com");
			const result = await withBridge("allow", (client) => client.call("permission.allow", { host }, 5000));
			const stored = (result as { allowed?: string }).allowed ?? host;
			console.log(`${sym.ok} Agents may open ${c.bold(stored)} and its subdomains.`);
			return;
		}
		case "allow-all":
		case "yolo": // old name, kept as a hidden alias
		case "ask": {
			const mode = command === "ask" ? "ask" : "allow_all";
			await withBridge(command, (client) => client.call("permission.setMode", { mode }, 5000));
			console.log(
				mode === "ask"
					? `${sym.ok} Agents will ask before opening a site you haven't allowed.`
					: `${sym.warn} Agents may now open any site without asking. ${c.dim("Undo with: tabkyra ask")}`,
			);
			return;
		}
		case "debug": {
			await withBridge("debug", async (client) => {
				const info = (await client.call("bridge.debug", {}, 5000)) as Record<string, unknown>;
				const bench = (await client.call("bridge.bench", {}, 30000)) as Record<string, unknown>;
				console.log(JSON.stringify({ ...info, bench }, null, 2));
			});
			return;
		}
		case "reload": {
			// Refuse to reload onto a broken bundle: a half-written dist-chrome unloads the extension.
			const dist = extensionDir();
			const missing = EXTENSION_FILES.filter((f) => !existsSync(join(dist, f)));
			if (existsSync(dist) && missing.length > 0) {
				throw new Error(`dist-chrome is incomplete (missing ${missing.join(", ")}). Run \`npm run build\` in the repo first.`);
			}
			await withBridge("reload", (client) => client.call("bridge.reload", {}, 5000));
			console.log(`${sym.ok} Reloading the extension. It reconnects in a few seconds.`);
			return;
		}
		case "pi-extension":
			console.log(`${sym.ok} Wrote ${writePiExtension(argv[1])}`);
			return;
		case "--version":
		case "-v":
		case "version":
			console.log(VERSION);
			return;
		case undefined:
		case "--help":
		case "-h":
		case "help":
			process.stdout.write(help());
			return;
		default:
			throw new UsageError(`Unknown command "${command}". Run \`tabkyra --help\` to see the commands.`);
	}
}

main().catch((err) => {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`${sym.fail} ${forPeople(message)}`);
	if (!(err instanceof UsageError) && message !== NOT_CONNECTED) console.error(`${sym.arrow} Run ${c.bold("tabkyra doctor")} to find the cause.`);
	process.exit(err instanceof UsageError ? 2 : 1);
});
