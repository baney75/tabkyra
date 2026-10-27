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
import { LIBRARY_USAGE, runLibrary } from "./library.ts";
import { createToken, loadTokens, loadUsage, revokeToken, SCOPES, serve } from "./remote.ts";
import { cloudflareTunnel, DEFAULT_PORT, tailscaleTunnel } from "./tunnel.ts";
import { runSkill } from "./skill.ts";
import { banner, c, sym } from "./ui.ts";
import { type Channel, runUpdate, UpdateError, type UpdateOptions } from "./update.ts";
import { detectMode, recoverCheckoutQuietly } from "./checkout.ts";
import { type HostRunAction, runHostAction } from "./update-run.ts";
import { BUILD } from "../../src/update/build.ts";
import { argsProblem, COMMANDS, completionScript, EXIT_CODES, helpRows, VALUE_FLAGS, VISIBLE_COMMANDS } from "./commands.ts";
import { VERSION } from "./version.ts";

/** One help row. Padding counts visible characters, so color codes don't shift the column. */
const cmd = (usage: string, what: string) => {
	const [name, ...rest] = usage.split(" ");
	const full = `tabkyra ${usage}`;
	const head = `  ${c.bold(`tabkyra ${name}`)}${rest.length ? ` ${rest.join(" ")}` : ""}`;
	// A long usage puts its description on the next line, in the same column.
	if (full.length > 56) return `${head}\n${" ".repeat(60)}${what}`;
	return `${head}${" ".repeat(58 - full.length)}${what}`;
};

/** Grouped from the one command table (commands.ts), so help can't drift from the CLI. */
function help(): string {
	const section = (title: string) => `\n${c.brass(title)}`;
	const groups = [...new Set(VISIBLE_COMMANDS.map((x) => x.group))];
	const rows: string[] = [];
	for (const group of groups) {
		rows.push(section(group));
		for (const spec of VISIBLE_COMMANDS.filter((x) => x.group === group)) for (const [usage, what] of helpRows(spec)) rows.push(cmd(usage, what));
		if (group === "Agents") {
			rows.push(
				`  ${c.dim("Claude Code:")} claude mcp add --scope user tabkyra -- ~/.config/tabkyra/tabkyra mcp`,
				`  ${c.dim("Codex:")}       codex mcp add tabkyra -- ~/.config/tabkyra/tabkyra mcp`,
				`  ${c.dim("(tabkyra setup adds these for you; tabkyra doctor checks them.)")}`,
			);
		}
	}
	return [
		`${banner(VERSION)}`,
		c.dim("A browser your coding agents can drive, in its own tab group, under your command."),
		...rows,
		"",
		`${c.dim("Flags:")} --help, --version. Read commands that list [--json] print JSON for scripts.`,
		c.dim(EXIT_CODES),
		`${c.dim("Docs:")} https://github.com/baney75/tabkyra`,
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

const UPDATE_USAGE = "Usage: tabkyra update [--check] [--json] [--rollback] [--yes] [--channel stable|nightly] [--auto-check on|off]";
/** The fixed command lines the native host runs for the side panel (cli/src/update-host.ts). */
const HOST_UPDATE_ACTIONS: Record<string, HostRunAction> = {
	"--host": "update",
	"--host --activate": "activate",
	"--host --rollback": "rollback",
	"--host --reinstall": "reinstall",
};

/** Parse `update` flags strictly, like setup. */
function parseUpdateArgs(args: string[]): UpdateOptions | string {
	const options: UpdateOptions = { check: false, rollback: false, json: false, yes: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const value = (name: string) => (arg === name ? args[++i] : arg.slice(name.length + 1));
		if (arg === "--check") options.check = true;
		else if (arg === "--rollback") options.rollback = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--yes" || arg === "-y") options.yes = true;
		else if (arg === "--channel" || arg.startsWith("--channel=")) {
			const channel = value("--channel");
			if (channel !== "stable" && channel !== "nightly") return `--channel is stable or nightly, got "${channel ?? ""}".`;
			options.channel = channel as Channel;
		} else if (arg === "--auto-check" || arg.startsWith("--auto-check=")) {
			const v = value("--auto-check");
			if (v !== "on" && v !== "off") return `--auto-check is on or off, got "${v ?? ""}".`;
			options.autoCheck = v === "on";
		} else return `Unknown option "${arg}".`;
	}
	if (options.rollback && options.check) return "--rollback and --check don't go together.";
	if (options.json && !options.check) return "--json goes with --check.";
	return options;
}

function checkArgs(command: string, args: string[]): void {
	const problem = argsProblem(command, args);
	if (problem) throw new UsageError(problem);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const [command] = argv;
	const flag = (name: string) => argv.includes(name);
	/** `--name value` or `--name=value`. */
	const option = (name: string): string | undefined => {
		const eq = argv.find((a) => a.startsWith(`${name}=`));
		if (eq) return eq.slice(name.length + 1);
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	if (command && command !== "host" && (flag("--help") || flag("-h"))) {
		process.stdout.write(help());
		return;
	}
	// `host` is spawned by the browser with its origin as an argument; leave it alone.
	if (command && command !== "host") checkArgs(command, argv.slice(1));
	// Bad setup or update options are refused before anything below touches the checkout.
	const setupArgs = command === "setup" ? parseSetupArgs(argv.slice(1)) : undefined;
	if (typeof setupArgs === "string") throw new UsageError(`${setupArgs} Usage: tabkyra setup [--yes] [--no-wait] [--timeout <seconds>]`);
	const updateArgs = command === "update" && argv[1] !== "--host" ? parseUpdateArgs(argv.slice(1)) : undefined;
	if (typeof updateArgs === "string") throw new UsageError(`${updateArgs} ${UPDATE_USAGE}`);
	// A checkout whose install or rollback a crash interrupted is repaired by any of these, so
	// the side panel isn't the only way back (docs/updates.md).
	if (command === "doctor" || command === "status" || command === "update" || command === "setup") {
		const { mode, root } = detectMode();
		if (mode === "checkout") {
			const note = recoverCheckoutQuietly(root);
			if (note) console.error(`${sym.warn} ${note}`);
		}
	}
	switch (command) {
		case "setup": {
			if (!setupArgs) throw new UsageError("Usage: tabkyra setup [--yes] [--no-wait] [--timeout <seconds>]");
			process.exitCode = await runSetup(setupArgs);
			return;
		}
		case "doctor":
			process.exitCode = await runDoctor({ json: flag("--json") });
			return;
		case "update": {
			if (argv[1] === "--host") {
				// Run by the native host, never with anything the extension sent (docs/updates.md).
				const action = HOST_UPDATE_ACTIONS[argv.slice(1).join(" ")];
				if (!action) throw new UsageError(`Unknown host update action. ${UPDATE_USAGE}`);
				process.exitCode = await runHostAction(action);
				return;
			}
			if (!updateArgs) throw new UsageError(UPDATE_USAGE);
			process.exitCode = await runUpdate(updateArgs);
			return;
		}
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
		case "skill": {
			const args = argv.slice(1);
			const flagName = (a: string) => (VALUE_FLAGS.has(a.split("=")[0]) ? a.split("=")[0] : a);
			const [sub, ...rest] = args.filter((a, i) => !a.startsWith("-") && !VALUE_FLAGS.has(args[i - 1] ?? ""));
			// Flags and argument counts each subcommand accepts; anything else is a usage error.
			const SKILL_SUB: Record<string, { flags: string[]; max: number }> = Object.fromEntries(
				(COMMANDS.find((x) => x.name === "skill")?.subcommands ?? []).map((x) => [x.name, { flags: x.flags ?? [], max: x.max ?? 0 }]),
			);
			const spec = sub && Object.hasOwn(SKILL_SUB, sub) ? SKILL_SUB[sub] : undefined;
			const badFlag = args.find((a) => a.startsWith("-") && !(spec?.flags ?? []).includes(flagName(a)));
			if (spec && (badFlag || rest.length > spec.max)) {
				throw new UsageError(`tabkyra skill ${sub} ${badFlag ? `doesn't take ${badFlag}` : "takes fewer arguments"}. Flags: ${spec.flags.join(" ") || "none"}.`);
			}
			if (!sub || !spec) {
				throw new UsageError(
					'Usage: tabkyra skill install [name...] [--all] [--force] | list [--json] | print [name] [--raw] | lint [path...] | apply <folder> [--yes] | revert <name> | match "<task>" [--json] [--top N] | eval [--json] [--update-baseline] [--cases <file>] [--base <checkout>] [--router <script>] | versions <name> | rollback <name> --to <version> [--yes] | edit <name> [--yes] [--draft-only] | refresh [--json]',
				);
			}
			for (const name of VALUE_FLAGS) {
				if (spec.flags.includes(name) && flag(name) && option(name) === undefined) throw new UsageError(`${name} needs a value.`);
			}
			process.exitCode = runSkill(sub, rest, {
				force: flag("--force"),
				all: flag("--all"),
				raw: flag("--raw"),
				yes: flag("--yes"),
				json: flag("--json"),
				updateBaseline: flag("--update-baseline"),
				draftOnly: flag("--draft-only"),
				top: option("--top"),
				to: option("--to"),
				cases: option("--cases"),
				base: option("--base"),
				router: option("--router"),
			});
			return;
		}
		case "library": {
			try {
				process.exitCode = await runLibrary(argv.slice(1));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (message.includes(LIBRARY_USAGE)) throw new UsageError(message);
				// A bad DOI or an unreachable registry is the input's problem, not the install's.
				console.error(`${sym.fail} ${message}`);
				process.exitCode = 1;
			}
			return;
		}
		case "serve": {
			const port = Number(option("--port") ?? DEFAULT_PORT);
			if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("--port takes a port number.");
			if (loadTokens().every((t) => t.revokedAt)) console.log(`${sym.warn} No tokens yet; every request will be refused. Create one: tabkyra token create <name> --scope browser.read`);
			const { url } = await serve({ port, host: "127.0.0.1" });
			console.log(`${sym.ok} MCP over HTTP at ${url} (loopback only; every request needs a token). Ctrl-C stops it.`);
			await new Promise(() => {});
			return;
		}
		case "token": {
			const [sub, name] = argv.slice(1).filter((a) => !a.startsWith("-") && a !== option("--scope"));
			if (sub === "create") {
				if (!name) throw new UsageError("Usage: tabkyra token create <name> --scope browser.read,library.read");
				const scopes = (option("--scope") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
				try {
					const { record, token } = createToken(name, scopes);
					console.log(`${sym.ok} Token ${record.id} for ${record.name}: ${record.scopes.join(", ")}`);
					console.log(`\n  ${token}\n`);
					console.log(c.dim("Shown once. Give it to the agent as an Authorization: Bearer header. tabkyra token revoke " + record.id + " ends it."));
				} catch (err) {
					throw new UsageError(err instanceof Error ? err.message : String(err));
				}
				return;
			}
			if (sub === "list") {
				const usage = loadUsage();
				if (flag("--json")) {
					// The token is never stored; its hash stays out of the output too.
					console.log(JSON.stringify(loadTokens().map(({ sha256: _hash, lastUsedAt, ...t }) => ({ ...t, lastUsed: usage[t.id] ?? lastUsedAt ?? null })), null, 2));
					return;
				}
				for (const t of loadTokens()) {
					const lastUsed = usage[t.id] ?? t.lastUsedAt;
					console.log(`${t.id}  ${t.name.padEnd(16)} ${t.revokedAt ? c.dim("revoked") : "active "}  ${t.scopes.join(",")}  ${c.dim(lastUsed ? `last used ${lastUsed}` : "never used")}`);
				}
				return;
			}
			if (sub === "revoke") {
				if (!name) throw new UsageError("Usage: tabkyra token revoke <id|name>");
				const n = revokeToken(name);
				console.log(n ? `${sym.ok} Revoked ${n} token${n === 1 ? "" : "s"}.` : `${sym.dot} No active token matches ${name}.`);
				process.exitCode = n ? 0 : 1;
				return;
			}
			if (sub === "scopes") {
				if (flag("--json")) {
					console.log(JSON.stringify(SCOPES, null, 2));
					return;
				}
				for (const [scope, { what, tools }] of Object.entries(SCOPES)) console.log(`${c.bold(scope.padEnd(18))} ${what}\n${"".padEnd(19)}${c.dim(tools.join(", "))}`);
				return;
			}
			throw new UsageError("Usage: tabkyra token create <name> --scope a,b | list | revoke <id|name> | scopes");
		}
		case "tunnel": {
			const kind = argv.slice(1).find((a) => !a.startsWith("-") && a !== option("--port"));
			const port = Number(option("--port") ?? DEFAULT_PORT);
			if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError("--port takes a port number from 1 to 65535.");
			const result =
				kind === "tailscale"
					? tailscaleTunnel({ port, public: flag("--public"), off: flag("--off") })
					: kind === "cloudflare"
						? await cloudflareTunnel({ port, off: flag("--off") })
						: undefined;
			if (!result) throw new UsageError("Usage: tabkyra tunnel tailscale|cloudflare [--port N] [--public] [--off]");
			if (flag("--public") && kind === "tailscale" && !flag("--off")) console.log(`${sym.warn} --public uses Tailscale Funnel: anyone on the internet can reach it, and the token is the only lock.`);
			console.log(`${result.ok ? sym.ok : sym.fail} ${result.message}`);
			process.exitCode = result.ok ? 0 : 1;
			return;
		}
		case "pi-extension":
			console.log(`${sym.ok} Wrote ${writePiExtension(argv[1])}`);
			return;
		case "completion": {
			const script = completionScript(argv[1] ?? "");
			if (!script) throw new UsageError("Usage: tabkyra completion zsh|bash|fish. For zsh: eval \"$(tabkyra completion zsh)\" in ~/.zshrc");
			process.stdout.write(script);
			return;
		}
		case "--version":
		case "-v":
		case "version":
			if (flag("--json")) console.log(JSON.stringify({ version: VERSION, commit: BUILD?.commit ?? "", builtAt: BUILD?.builtAt ?? "" }));
			else console.log(VERSION);
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
	if (!(err instanceof UsageError) && !(err instanceof UpdateError) && message !== NOT_CONNECTED) console.error(`${sym.arrow} Run ${c.bold("tabkyra doctor")} to find the cause.`);
	process.exit(err instanceof UsageError ? 2 : 1);
});
