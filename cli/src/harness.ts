/**
 * Coding harnesses Tabkyra can serve: how to find them, whether the MCP server is
 * configured, and how to add it. Claude Code and Codex have `mcp add` commands; the
 * others get a config block to paste, because editing their JSON for the user would
 * risk clobbering comments and other servers.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type HarnessId = "claude" | "codex" | "opencode" | "cursor" | "omp" | "pi";

export interface Harness {
	id: HarnessId;
	name: string;
	/** True when the harness is installed for this user. */
	detected: boolean;
	/** true/false when we can tell, undefined when we can't read its config. */
	configured: boolean | undefined;
	/** Command that adds the server, when the harness has one. */
	addCommand?: string[];
	/** Where to paste `snippet`, when there is no add command. */
	configFile?: string;
	snippet?: string;
}

/** First match for `name` on PATH, or undefined. */
export function which(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/**
 * The absolute path harness configs should run. Prefer the `tabkyra` on PATH when it is
 * this same CLI (a stable npm link path); otherwise this script's own resolved path.
 */
export function tabkyraBinary(): string {
	const self = realpathSync(process.argv[1]);
	const onPath = which("tabkyra");
	if (onPath) {
		try {
			if (realpathSync(onPath) === self) return onPath;
		} catch {
			/* broken link */
		}
	}
	return self;
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** Does the JSON file at `file` have `tabkyra` under `key`? undefined if unreadable. */
function jsonHasServer(file: string, key: string): boolean | undefined {
	if (!existsSync(file)) return false;
	const data = readJson(file);
	if (!data) {
		// JSONC or hand-edited: fall back to a plain text search for the server name.
		try {
			return /"tabkyra"\s*:/.test(readFileSync(file, "utf8")) || undefined;
		} catch {
			return undefined;
		}
	}
	const servers = data[key];
	return typeof servers === "object" && servers !== null && "tabkyra" in servers;
}

/** Pretty JSON with short arrays kept on one line, ready to paste into a config. */
function snippet(value: unknown): string {
	return JSON.stringify(value, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_m, inner: string) => `[${inner.split(/,\s+/).join(", ")}]`);
}

function commandSucceeds(command: string, args: string[]): boolean {
	const result = spawnSync(command, args, { stdio: "ignore", timeout: 15000 });
	return result.status === 0;
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
		configured: claude ? commandSucceeds(claude, ["mcp", "get", "tabkyra"]) : undefined,
		addCommand: ["claude", "mcp", "add", "--scope", "user", "tabkyra", "--", binary, "mcp"],
	});

	const codex = which("codex");
	list.push({
		id: "codex",
		name: "Codex",
		detected: Boolean(codex),
		configured: codex ? commandSucceeds(codex, ["mcp", "get", "tabkyra"]) : undefined,
		addCommand: ["codex", "mcp", "add", "tabkyra", "--", binary, "mcp"],
	});

	const opencodeFile = join(configHome, "opencode", "opencode.json");
	list.push({
		id: "opencode",
		name: "OpenCode",
		detected: Boolean(which("opencode")) || existsSync(join(configHome, "opencode")),
		configured: jsonHasServer(opencodeFile, "mcp"),
		configFile: opencodeFile,
		snippet: snippet({ mcp: { tabkyra: { type: "local", command: [binary, "mcp"], enabled: true } } }),
	});

	const cursorFile = join(home, ".cursor", "mcp.json");
	list.push({
		id: "cursor",
		name: "Cursor",
		detected: Boolean(which("cursor") || which("cursor-agent")) || existsSync(join(home, ".cursor")),
		configured: jsonHasServer(cursorFile, "mcpServers"),
		configFile: cursorFile,
		snippet: snippet({ mcpServers: { tabkyra: { command: binary, args: ["mcp"] } } }),
	});

	const ompFile = join(home, ".omp", "agent", "mcp.json");
	list.push({
		id: "omp",
		name: "OMP",
		detected: Boolean(which("omp")) || existsSync(join(home, ".omp")),
		configured: jsonHasServer(ompFile, "mcpServers"),
		configFile: ompFile,
		snippet: snippet({ mcpServers: { tabkyra: { type: "stdio", command: binary, args: ["mcp"], enabled: true } } }),
	});

	// pi has no MCP client; `tabkyra pi-extension` writes a native pi extension instead.
	const piFile = join(home, ".pi", "agent", "extensions", "tabkyra.ts");
	list.push({
		id: "pi",
		name: "pi",
		detected: Boolean(which("pi")) || existsSync(join(home, ".pi")),
		configured: existsSync(piFile),
		configFile: piFile,
		addCommand: [binary, "pi-extension"],
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
