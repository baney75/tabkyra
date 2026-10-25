/**
 * Coding harnesses Tabkyra can serve: how to find them, whether the MCP server is
 * configured, and how to add it. Claude Code and Codex have `mcp add` commands; the
 * others get a config block to paste, because editing their JSON for the user would
 * risk clobbering comments and other servers.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { cliLauncherPath } from "./install.ts";

export type Configured = boolean | "stale" | undefined;

export type HarnessId = "claude" | "codex" | "opencode" | "cursor" | "omp" | "pi";

export interface Harness {
	id: HarnessId;
	name: string;
	/** True when the harness is installed for this user. */
	detected: boolean;
	/** true: runs this CLI; "stale": runs another command; undefined: config unreadable. */
	configured: Configured;
	/** Command that removes a stale entry before re-adding it. */
	removeCommand?: string[];
	/** Command that adds the server, when the harness has one. */
	addCommand?: string[];
	/** Where to paste `snippet`, when there is no add command. */
	configFile?: string;
	snippet?: string;
}

/** First match for `name` on PATH, or undefined. */
export function which(name: string): string | undefined {
	const extensions = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const ext of extensions) {
			const candidate = join(dir, name + ext);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

/** The absolute path harness configs run: the launcher `tabkyra install` writes. */
export function tabkyraBinary(): string {
	return cliLauncherPath();
}

/** Does a configured command run this CLI? Accepts the launcher, or any path to this script. */
export function runsThisCli(command: string | undefined): boolean {
	if (!command) return false;
	if (command === cliLauncherPath()) return true;
	const resolved = isAbsolute(command) ? command : which(command);
	if (!resolved) return false;
	try {
		return realpathSync(resolved) === realpathSync(process.argv[1]);
	} catch {
		return false;
	}
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/**
 * Is `tabkyra` configured under `key` in the JSON file, running this CLI? undefined when
 * the file can't be parsed (JSONC, hand edits); "stale" when it runs some other command.
 */
function jsonServerState(file: string, key: string, commandOf: (entry: Record<string, unknown>) => unknown): Configured {
	if (!existsSync(file)) return false;
	const data = readJson(file);
	if (!data) {
		try {
			return /"tabkyra"\s*:/.test(readFileSync(file, "utf8")) || undefined;
		} catch {
			return undefined;
		}
	}
	const servers = data[key] as Record<string, Record<string, unknown>> | undefined;
	const entry = servers?.tabkyra;
	if (!entry || typeof entry !== "object") return false;
	const command = commandOf(entry);
	return runsThisCli(typeof command === "string" ? command : undefined) || "stale";
}

/** `claude mcp get` / `codex mcp get`: not found, found running this CLI, or found running something else. */
function cliServerState(binary: string, commandLine: RegExp): Configured {
	const result = spawnSync(binary, ["mcp", "get", "tabkyra"], { encoding: "utf8", timeout: 15000 });
	if (result.status !== 0) return false;
	const command = (result.stdout ?? "").match(commandLine)?.[1]?.trim();
	return command === undefined || runsThisCli(command) || "stale";
}

/** Pretty JSON with short arrays kept on one line, ready to paste into a config. */
function snippet(value: unknown): string {
	return JSON.stringify(value, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_m, inner: string) => `[${inner.split(/,\s+/).join(", ")}]`);
}

export function harnesses(binary = tabkyraBinary()): Harness[] {
	const home = homedir();
	const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
	const list: Harness[] = [];

	const claude = which("claude");
	list.push({
		id: "claude",
		name: "Claude Code",
		detected: Boolean(claude),
		configured: claude ? cliServerState(claude, /^\s*Command:\s*(.+)$/m) : undefined,
		addCommand: ["claude", "mcp", "add", "--scope", "user", "tabkyra", "--", binary, "mcp"],
		removeCommand: ["claude", "mcp", "remove", "--scope", "user", "tabkyra"],
	});

	const codex = which("codex");
	list.push({
		id: "codex",
		name: "Codex",
		detected: Boolean(codex),
		configured: codex ? cliServerState(codex, /^\s*command:\s*(.+)$/m) : undefined,
		addCommand: ["codex", "mcp", "add", "tabkyra", "--", binary, "mcp"],
		removeCommand: ["codex", "mcp", "remove", "tabkyra"],
	});

	const opencodeFile = join(configHome, "opencode", "opencode.json");
	list.push({
		id: "opencode",
		name: "OpenCode",
		detected: Boolean(which("opencode")) || existsSync(join(configHome, "opencode")),
		configured: jsonServerState(opencodeFile, "mcp", (e) => (Array.isArray(e.command) ? e.command[0] : e.command)),
		configFile: opencodeFile,
		snippet: snippet({ mcp: { tabkyra: { type: "local", command: [binary, "mcp"], enabled: true } } }),
	});

	const cursorFile = join(home, ".cursor", "mcp.json");
	list.push({
		id: "cursor",
		name: "Cursor",
		detected: Boolean(which("cursor") || which("cursor-agent")) || existsSync(join(home, ".cursor")),
		configured: jsonServerState(cursorFile, "mcpServers", (e) => e.command),
		configFile: cursorFile,
		snippet: snippet({ mcpServers: { tabkyra: { command: binary, args: ["mcp"] } } }),
	});

	const ompFile = join(home, ".omp", "agent", "mcp.json");
	list.push({
		id: "omp",
		name: "OMP",
		detected: Boolean(which("omp")) || existsSync(join(home, ".omp")),
		configured: jsonServerState(ompFile, "mcpServers", (e) => e.command),
		configFile: ompFile,
		snippet: snippet({ mcpServers: { tabkyra: { type: "stdio", command: binary, args: ["mcp"], enabled: true } } }),
	});

	// pi has no MCP client; `tabkyra pi-extension` writes a native pi extension instead.
	// Setup prints that command rather than running it, like the other print-only harnesses.
	const piFile = join(home, ".pi", "agent", "extensions", "tabkyra.ts");
	list.push({
		id: "pi",
		name: "pi",
		detected: Boolean(which("pi")) || existsSync(join(home, ".pi")),
		configured: existsSync(piFile),
		configFile: piFile,
		snippet: `${binary} pi-extension`,
	});

	return list;
}

/** Shell-quote a command for display. */
export function shellJoin(argv: string[]): string {
	return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(" ");
}

/** Run an add command, inheriting the terminal. Returns true on exit 0. */
export function runAdd(argv: string[]): boolean {
	try {
		execFileSync(argv[0], argv.slice(1), { stdio: "inherit", timeout: 30000 });
		return true;
	} catch {
		return false;
	}
}
