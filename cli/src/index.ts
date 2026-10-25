import { existsSync } from "node:fs";
import { join } from "node:path";
import { BridgeClient, listSockets } from "./client.ts";
import { runNativeHost } from "./host.ts";
import { runDoctor } from "./doctor.ts";
import { hostStatus, install, isInstalled } from "./install.ts";
import { runMcpServer } from "./mcp.ts";
import { EXTENSION_FILES, extensionDir } from "./paths.ts";
import { writePiExtension } from "./pi-extension.ts";
import { runSetup, type SetupOptions } from "./setup.ts";
import { VERSION } from "./version.ts";

const HELP = `tabkyra ${VERSION} - browser bridge for coding harnesses

Usage:
  tabkyra setup           Build, register, connect agents, load the extension (--yes accepts every offer)
  tabkyra doctor          Check every piece and print one fix per problem
  tabkyra mcp             Run the MCP server on stdio (installs the native host on first run)
  tabkyra install         Write the native messaging manifest for every Chromium browser found
  tabkyra status          Show whether the extension is reachable
  tabkyra reload          Reload the extension (picks up a rebuilt dist-chrome)
  tabkyra allow <host>    Allow agents to open a site (subdomains included)
  tabkyra yolo            Allow agents to open ANY site (no per-site prompts)
  tabkyra ask             Require a prompt before agents open an un-allowed site (default)
  tabkyra debug           Print the extension's bridge state and recent timing log
  tabkyra pi-extension    Write a pi extension to ~/.pi/agent/extensions/tabkyra.ts
  tabkyra host            (internal) native messaging host, spawned by the browser

Harness setup:
  claude mcp add tabkyra -- tabkyra mcp
  codex:  [mcp_servers.tabkyra]  command = "tabkyra"  args = ["mcp"]
  omp:    add an MCP server entry running "tabkyra mcp"
  pi:     tabkyra pi-extension
`;

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

async function status(): Promise<void> {
	const sockets = listSockets();
	console.log(`native host manifest: ${isInstalled() ? "installed" : "missing (run: tabkyra install)"}`);
	for (const b of hostStatus()) console.log(`  ${b.name.padEnd(14)} ${b.state.padEnd(8)} ${b.file}`);
	if (sockets.length === 0) {
		console.log("bridge sockets: none. Is the tabkyra extension loaded in a running Chromium browser?");
		process.exitCode = 1;
		return;
	}
	for (const path of sockets) {
		const client = new BridgeClient({ name: "status" });
		try {
			await client.connect(path);
			console.log(`${path}: host ok, extension ${client.extensionConnected ? "connected" : "not connected"}`);
			if (client.extensionConnected) {
				const ctx = (await client.call("tabs.context", {}, 5000)) as { tabs: unknown[] };
				console.log(`  session tabs: ${ctx.tabs.length}`);
			}
		} catch (err) {
			console.log(`${path}: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			client.close();
		}
	}
}

async function main(): Promise<void> {
	const [command] = process.argv.slice(2);
	switch (command) {
		case "setup": {
			const parsed = parseSetupArgs(process.argv.slice(3));
			if (typeof parsed === "string") {
				console.error(`${parsed}\nUsage: tabkyra setup [--yes] [--no-wait] [--timeout <seconds>]`);
				process.exitCode = 2;
				return;
			}
			process.exitCode = await runSetup(parsed);
			return;
		}
		case "doctor":
			process.exitCode = await runDoctor({ json: process.argv.includes("--json") });
			return;
		case "host":
			runNativeHost();
			return;
		case "mcp":
			await runMcpServer();
			return;
		case "install": {
			const result = install({ force: process.argv.includes("--force") });
			console.log(`launcher: ${result.launcher}`);
			for (const f of result.written) console.log(`wrote   ${f}`);
			for (const f of result.skipped) console.log(`current ${f}`);
			if (result.written.length + result.skipped.length === 0) console.log("no Chromium browser profile directories found");
			console.log("Reload the tabkyra extension once if it was loaded before this install.");
			return;
		}
		case "status":
			await status();
			return;
		case "allow": {
			const host = process.argv[3];
			if (!host) throw new Error("usage: tabkyra allow <host>");
			const client = new BridgeClient({ name: "allow" });
			await client.connect();
			console.log(JSON.stringify(await client.call("permission.allow", { host }, 5000)));
			client.close();
			return;
		}
		case "yolo":
		case "ask": {
			const mode = command === "yolo" ? "allow_all" : "ask";
			const client = new BridgeClient({ name: command });
			await client.connect();
			console.log(JSON.stringify(await client.call("permission.setMode", { mode }, 5000)));
			client.close();
			return;
		}
		case "debug": {
			const client = new BridgeClient({ name: "debug" });
			await client.connect();
			const info = (await client.call("bridge.debug", {}, 5000)) as Record<string, unknown>;
			const bench = (await client.call("bridge.bench", {}, 30000)) as Record<string, unknown>;
			console.log(JSON.stringify({ ...info, bench }, null, 2));
			client.close();
			return;
		}
		case "reload": {
			// Refuse to reload onto a broken bundle: a half-written dist-chrome unloads the extension.
			const dist = extensionDir();
			const missing = EXTENSION_FILES.filter((f) => !existsSync(join(dist, f)));
			if (existsSync(dist) && missing.length > 0) {
				throw new Error(`dist-chrome is incomplete (missing ${missing.join(", ")}); run \`npm run build\` first`);
			}
			const client = new BridgeClient({ name: "reload" });
			await client.connect();
			console.log(JSON.stringify(await client.call("bridge.reload", {}, 5000)));
			client.close();
			return;
		}
		case "pi-extension":
			console.log(`wrote ${writePiExtension(process.argv[3])}`);
			return;
		case "--version":
		case "-v":
			console.log(VERSION);
			return;
		default:
			process.stdout.write(HELP);
			if (command && command !== "--help" && command !== "-h") process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
