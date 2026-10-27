/**
 * Every `tabkyra` command, once: `--help` and the shell completions are generated from this
 * table, so neither can list a command the CLI doesn't have or miss one it does.
 */

export interface CommandSpec {
	/** The command word, e.g. "status" or "skill". */
	name: string;
	/** Usage after the name, for help. */
	args: string;
	what: string;
	/** One line for the whole command in completions, when `what` describes only its first form. */
	summary?: string;
	group: "Get started" | "Agents" | "Sessions" | "Remote" | "Library" | "Sites" | "Troubleshoot";
	flags?: string[];
	/** Second words (`skill install`, `token list`), completed after the command. */
	subcommands?: Array<{
		name: string;
		what: string;
		flags?: string[];
		/** Arguments after the subcommand, at most (default 0). */
		max?: number;
		/** Its arguments as usage shows them ("<name>"). */
		args?: string;
	}>;
	/** Arguments after the command a command takes at most (default 0). Ignored with subcommands. */
	positional?: number;
	/** The command parses its own arguments (setup, update, library, skill); checkArgs leaves it alone. */
	selfParsed?: boolean;
	/** Values completed for the first argument (`completion zsh`). */
	values?: string[];
	/** Hidden from help and completions (aliases, internal entry points). */
	hidden?: boolean;
	/** Extra help rows under the command (the same command shown with other arguments). */
	more?: Array<{ args: string; what: string }>;
}

export const COMMANDS: CommandSpec[] = [
	{ name: "setup", selfParsed: true, args: "[--yes]", what: "Build, register, load, connect and add to your agents", group: "Get started", flags: ["--yes", "--no-wait", "--timeout"] },
	{ name: "status", args: "[--json]", what: "Is the extension connected? Which sites are allowed?", group: "Get started", flags: ["--json"] },
	{ name: "mcp", args: "", what: "MCP server on stdio (what Claude Code, Codex, OpenCode run)", group: "Agents" },
	{ name: "pi-extension", positional: 1, args: "[dir]", what: "Write a pi extension to ~/.pi/agent/extensions/tabkyra.ts", group: "Agents" },
	{
		name: "skill",
		selfParsed: true,
		summary: "Install, list, lint, match and edit skills",
		args: "install [name...] [--all] [--force]",
		what: "Install the bundled skills into Claude Code, Codex and OpenCode",
		group: "Agents",
		more: [
			{ args: "list [--json]", what: "The skills in use, what each is for, its version and source" },
			{ args: "print [name] [--raw]", what: "A skill as text for AGENTS.md; --raw is the exact SKILL.md" },
			{ args: "lint [path...]", what: "Check skills for hidden text, injection and missing structure" },
			{ args: "apply <folder> [--yes]", what: "Check and show an edited skill; --yes backs up and installs it (/rsi)" },
			{ args: "revert <name>", what: "Drop your edit and go back to the bundled skill" },
			{ args: 'match "<task>" [--json] [--top N]', what: "Which skill fits a task, best first, or none" },
			{ args: "eval [--json] [--update-baseline]", what: "Run the router's regression and held-out cases and gates" },
			{ args: "versions <name> [--json]", what: "Bundled, local and backed-up versions of a skill" },
			{ args: "rollback <name> --to <version> [--yes]", what: "Restore a backed-up version, with apply's checks" },
			{ args: "edit <name> [--yes] [--draft-only]", what: "Draft an edit in $EDITOR, show the diff, apply on yes" },
			{ args: "refresh [--json]", what: "Refresh installed bundled skills you haven't edited" },
		],
		subcommands: [
			{ name: "install", what: "Install bundled skills into your agents", flags: ["--all", "--force"], max: 64 },
			{ name: "list", what: "The skills in use", flags: ["--json"], max: 0 },
			{ name: "print", what: "A skill as text for AGENTS.md", flags: ["--raw"], max: 1 },
			{ name: "lint", what: "Check skills for hidden text and injection", max: 64 },
			{ name: "apply", what: "Check and install an edited skill", flags: ["--yes"], max: 1 },
			{ name: "revert", what: "Go back to the bundled skill", max: 1 },
			{ name: "match", what: "Which skill fits a task", flags: ["--json", "--top"], max: 64 },
			{ name: "eval", what: "Run the router's regression cases", flags: ["--json", "--update-baseline", "--cases", "--base", "--router"], max: 0 },
			{ name: "versions", what: "Versions of a skill", flags: ["--json"], max: 1 },
			{ name: "rollback", what: "Restore a backed-up version", flags: ["--to", "--yes"], max: 1 },
			{ name: "edit", what: "Edit a skill in $EDITOR", flags: ["--yes", "--draft-only"], max: 1 },
			{ name: "refresh", what: "Refresh installed skills", flags: ["--json"], max: 0 },
		],
	},
	{ name: "serve", args: "[--port 8787]", what: "MCP over HTTP on loopback, for tunnels; every request needs a token", group: "Remote", flags: ["--port"] },
	{
		name: "token",
		summary: "Scoped, revocable tokens for serve",
		args: "create <name> --scope a,b",
		what: "A scoped, revocable token (tabkyra token scopes lists them)",
		group: "Remote",
		more: [{ args: "list|revoke|scopes [--json]", what: "See tokens, end one, or list the scopes" }],
		subcommands: [
			{ name: "create", what: "A scoped, revocable token", flags: ["--scope"], max: 1, args: "<name>" },
			{ name: "list", what: "Every token and when it was last used", flags: ["--json"], max: 0 },
			{ name: "revoke", what: "End a token", max: 1, args: "<id|name>" },
			{ name: "scopes", what: "The scopes a token can have", flags: ["--json"], max: 0 },
		],
	},
	{
		name: "tunnel",
		summary: "Reach serve over Tailscale or Cloudflare",
		args: "tailscale [--public] [--off]",
		what: "Reach serve from your tailnet over HTTPS (--port N)",
		group: "Remote",
		more: [{ args: "cloudflare [--port N] [--off]", what: "A free cloudflared quick tunnel" }],
		subcommands: [
			{ name: "tailscale", what: "Reach serve from your tailnet", flags: ["--port", "--public", "--off"] },
			{ name: "cloudflare", what: "A cloudflared quick tunnel", flags: ["--port", "--off"] },
		],
	},
	{
		name: "library",
		selfParsed: true,
		summary: "Verified sources: add, search, cite, export",
		args: "add <doi|arxiv>",
		what: "Save a source, verified against its registry, OpenAlex and retractions",
		group: "Library",
		more: [
			{ args: "search|list|cite", what: "Find sources and format a reference (apa, mla, chicago, ieee, ...)" },
			{ args: "export --format bibtex|ris|csl", what: "For Zotero, Word and LaTeX" },
			{ args: "obsidian <vault>", what: "One note per source in <vault>/Sources" },
			{ args: "verify [key...]", what: "Re-run the registry and retraction checks" },
			{ args: "remove <key>", what: "Drop a source from the library" },
		],
		subcommands: [
			{ name: "add", what: "Save a verified source", flags: ["--quote", "--location", "--note", "--tag"] },
			{ name: "search", what: "Find saved sources", flags: ["--json"] },
			{ name: "list", what: "Every saved source", flags: ["--json"] },
			{ name: "cite", what: "Format a reference", flags: ["--style"] },
			{ name: "export", what: "BibTeX, RIS or CSL-JSON", flags: ["--format", "--out"] },
			{ name: "obsidian", what: "One note per source", flags: ["--folder"] },
			{ name: "verify", what: "Re-run the checks" },
			{ name: "remove", what: "Drop a source" },
		],
	},
	{ name: "allow", positional: 1, args: "<host>", what: "Let agents open a site (subdomains included)", group: "Sites" },
	{ name: "ask", args: "", what: "Agents ask before opening a site not yet allowed (default)", group: "Sites" },
	{ name: "allow-all", args: "", what: "Agents may open any site without asking", group: "Sites" },
	{ name: "yolo", args: "", what: "Old name of allow-all", group: "Sites", hidden: true },
	{ name: "doctor", args: "[--json]", what: "Check everything; one fix per problem", group: "Troubleshoot", flags: ["--json"] },
	{
		name: "update",
		selfParsed: true,
		args: "[--check] [--rollback]",
		what: "Install the latest signed release (--channel stable|nightly)",
		group: "Troubleshoot",
		flags: ["--check", "--json", "--rollback", "--yes", "--channel", "--auto-check"],
	},
	{ name: "install", args: "[--force]", what: "Re-register the native host with every browser", group: "Troubleshoot", flags: ["--force"] },
	{ name: "reload", args: "", what: "Reload the extension after rebuilding dist-chrome", group: "Troubleshoot" },
	{ name: "debug", args: "", what: "Bridge state, request timings and a benchmark (JSON)", group: "Troubleshoot" },
	{ name: "completion", positional: 1, args: "zsh|bash|fish", what: "Shell completions: eval \"$(tabkyra completion zsh)\"", group: "Troubleshoot", values: ["zsh", "bash", "fish"] },
	{ name: "version", args: "[--json]", what: "This CLI's version (also --version)", group: "Troubleshoot", flags: ["--json"] },
	{ name: "help", selfParsed: true, args: "", what: "This help (also --help)", group: "Troubleshoot", hidden: true },
	{ name: "host", selfParsed: true, args: "", what: "The native host the browser starts", group: "Troubleshoot", hidden: true },
];

export const VISIBLE_COMMANDS = COMMANDS.filter((c) => !c.hidden);

/** Options that take a value (`--top 3` or `--top=3`); the value isn't a positional argument. */
export const VALUE_FLAGS = new Set([
	"--top",
	"--to",
	"--cases",
	"--base",
	"--router",
	"--port",
	"--scope",
	"--timeout",
	"--channel",
	"--auto-check",
	"--quote",
	"--location",
	"--note",
	"--tag",
	"--style",
	"--format",
	"--out",
	"--folder",
]);

export function commandSpec(name: string): CommandSpec | undefined {
	// --version and -v are the version command.
	const key = name === "--version" || name === "-v" ? "version" : name === "--help" || name === "-h" ? "help" : name;
	return COMMANDS.find((c) => c.name === key);
}

/**
 * Why `args` (everything after the command word) don't fit the command's spec, or undefined when
 * they do: an unknown option, a value option without its value, or too many arguments. Commands
 * with subcommands are checked against the subcommand's own flags.
 */
export function argsProblem(command: string, args: string[]): string | undefined {
	const spec = commandSpec(command);
	if (!spec || spec.selfParsed) return undefined;
	const name = (a: string) => a.split("=")[0];
	const positional = args.filter((a, i) => !a.startsWith("-") && !(VALUE_FLAGS.has(args[i - 1] ?? "") && !args[i - 1].includes("=")));
	let flags = spec.flags ?? [];
	let max = spec.positional ?? 0;
	// The usage line: the flags, then the arguments the help shows (anything that isn't a flag).
	const argWords = spec.args
		.replace(/\[--[^\]]*\]/g, "")
		.split(" ")
		.filter((w) => w && !w.startsWith("--"))
		.join(" ");
	let usage = `Usage: tabkyra ${spec.name}${flags.map((f) => ` [${f}]`).join("")}${argWords ? ` ${argWords}` : ""}`;
	if (spec.subcommands) {
		const sub = spec.subcommands.find((x) => x.name === positional[0]);
		// An unknown or missing subcommand is the command's own usage error, with its list.
		if (!sub) return undefined;
		flags = sub.flags ?? [];
		max = 1 + (sub.max ?? 0);
		usage = `Usage: tabkyra ${spec.name} ${sub.name}${sub.args ? ` ${sub.args}` : ""}${flags.map((f) => ` [${f}]`).join("")}`;
	}
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!a.startsWith("-")) continue;
		if (!flags.includes(name(a))) return `Unknown option "${name(a)}". ${usage}`;
		if (VALUE_FLAGS.has(name(a))) {
			const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1];
			if (value === undefined || value === "" || (!a.includes("=") && value.startsWith("-"))) return `${name(a)} needs a value. ${usage}`;
		}
	}
	if (positional.length > max) return `Unexpected argument "${positional[max]}". ${usage}`;
	return undefined;
}

/** Exit codes every command uses; also printed by --help. */
export const EXIT_CODES =
	"Exit codes: 0 success, 1 failed, not connected or nothing found, 2 usage error; update --check 100 when an update exists, library add 3 retracted and 4 unchecked.";

function sh(word: string): string {
	return word.replace(/[^A-Za-z0-9_.:,|/-]/g, "");
}

/** Descriptions are quoted for each shell; strip what could end the quote. */
function desc(text: string): string {
	return text.replace(/["'`$\\[\]:]/g, "").replace(/\s+/g, " ");
}

export function completionScript(shell: string): string | undefined {
	const cmds = VISIBLE_COMMANDS;
	if (shell === "zsh") {
		const lines = [
			"#compdef tabkyra",
			"# tabkyra completion for zsh. Load it with: eval \"$(tabkyra completion zsh)\"",
			"_tabkyra() {",
			"  local -a commands",
			"  commands=(",
			...cmds.map((c) => `    '${sh(c.name)}:${desc(c.summary ?? c.what)}'`),
			"  )",
			"  if (( CURRENT == 2 )); then",
			"    _describe -t commands 'tabkyra command' commands",
			"    return",
			"  fi",
			"  local -a subs flags",
			"  case $words[2] in",
		];
		for (const c of cmds) {
			const subs = c.subcommands ?? [];
			const flags = [...new Set([...(c.flags ?? []), ...subs.flatMap((s) => s.flags ?? [])])];
			const values = c.values ?? [];
			if (!subs.length && !flags.length && !values.length) continue;
			lines.push(`    ${sh(c.name)})`);
			if (subs.length) lines.push(`      subs=(${subs.map((s) => `'${sh(s.name)}:${desc(s.what)}'`).join(" ")})`);
			if (values.length) lines.push(`      subs=(${values.map((v) => `'${sh(v)}'`).join(" ")})`);
			if (flags.length) lines.push(`      flags=(${flags.map(sh).join(" ")})`);
			lines.push("      ;;");
		}
		lines.push(
			"  esac",
			"  if (( CURRENT == 3 )) && (( ${#subs} )); then",
			"    _describe -t subcommands 'subcommand' subs",
			"  elif (( ${#flags} )); then",
			"    compadd -- $flags",
			"  fi",
			"}",
			"# compdef exists once compinit has run; load it if the user's zshrc hasn't.",
			"if (( ! $+functions[compdef] )); then autoload -Uz compinit && compinit; fi",
			"compdef _tabkyra tabkyra",
			"",
		);
		return lines.join("\n");
	}
	if (shell === "bash") {
		const lines = [
			"# tabkyra completion for bash. Load it with: eval \"$(tabkyra completion bash)\"",
			"_tabkyra() {",
			'  local cur="${COMP_WORDS[COMP_CWORD]}"',
			"  if [ \"$COMP_CWORD\" -eq 1 ]; then",
			`    COMPREPLY=( $(compgen -W "${cmds.map((c) => sh(c.name)).join(" ")}" -- "$cur") )`,
			"    return",
			"  fi",
			'  local words=""',
			'  case "${COMP_WORDS[1]}" in',
		];
		for (const c of cmds) {
			const subs = c.subcommands ?? [];
			const flags = [...new Set([...(c.flags ?? []), ...subs.flatMap((s) => s.flags ?? [])])];
			const all = [...subs.map((s) => s.name), ...(c.values ?? []), ...flags];
			if (!all.length) continue;
			lines.push(`    ${sh(c.name)}) words="${all.map(sh).join(" ")}" ;;`);
		}
		lines.push("  esac", '  COMPREPLY=( $(compgen -W "$words" -- "$cur") )', "}", "complete -F _tabkyra tabkyra", "");
		return lines.join("\n");
	}
	if (shell === "fish") {
		const lines = ["# tabkyra completion for fish. Load it with: tabkyra completion fish | source", "complete -c tabkyra -f"];
		for (const c of cmds) lines.push(`complete -c tabkyra -n __fish_use_subcommand -a ${sh(c.name)} -d '${desc(c.summary ?? c.what)}'`);
		for (const c of cmds) {
			for (const s of c.subcommands ?? [])
				lines.push(`complete -c tabkyra -n '__fish_seen_subcommand_from ${sh(c.name)}' -a ${sh(s.name)} -d '${desc(s.what)}'`);
			for (const v of c.values ?? []) lines.push(`complete -c tabkyra -n '__fish_seen_subcommand_from ${sh(c.name)}' -a ${sh(v)}`);
			const flags = [...new Set([...(c.flags ?? []), ...(c.subcommands ?? []).flatMap((s) => s.flags ?? [])])];
			for (const f of flags) lines.push(`complete -c tabkyra -n '__fish_seen_subcommand_from ${sh(c.name)}' -l ${sh(f.replace(/^--/, ""))}`);
		}
		lines.push("");
		return lines.join("\n");
	}
	return undefined;
}
