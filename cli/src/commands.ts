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
	subcommands?: Array<{ name: string; what: string; flags?: string[] }>;
	/** Values completed for the first argument (`completion zsh`). */
	values?: string[];
	/** Hidden from help and completions (aliases, internal entry points). */
	hidden?: boolean;
	/** Extra help rows under the command (the same command shown with other arguments). */
	more?: Array<{ args: string; what: string }>;
}

export const COMMANDS: CommandSpec[] = [
	{ name: "setup", args: "[--yes]", what: "Build, register, load, connect and add to your agents", group: "Get started", flags: ["--yes", "--no-wait", "--timeout"] },
	{ name: "status", args: "[--json]", what: "Is the extension connected? Which sites are allowed?", group: "Get started", flags: ["--json"] },
	{ name: "mcp", args: "", what: "MCP server on stdio (what Claude Code, Codex, OpenCode run)", group: "Agents" },
	{ name: "pi-extension", args: "", what: "Write a pi extension to ~/.pi/agent/extensions/tabkyra.ts", group: "Agents" },
	{
		name: "skill",
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
		],
		subcommands: [
			{ name: "install", what: "Install bundled skills into your agents", flags: ["--all", "--force"] },
			{ name: "list", what: "The skills in use", flags: ["--json"] },
			{ name: "print", what: "A skill as text for AGENTS.md", flags: ["--raw"] },
			{ name: "lint", what: "Check skills for hidden text and injection" },
			{ name: "apply", what: "Check and install an edited skill", flags: ["--yes"] },
			{ name: "revert", what: "Go back to the bundled skill" },
			{ name: "match", what: "Which skill fits a task", flags: ["--json", "--top"] },
			{ name: "eval", what: "Run the router's regression cases", flags: ["--json", "--update-baseline", "--cases", "--base", "--router"] },
			{ name: "versions", what: "Versions of a skill", flags: ["--json"] },
			{ name: "rollback", what: "Restore a backed-up version", flags: ["--to", "--yes"] },
			{ name: "edit", what: "Edit a skill in $EDITOR", flags: ["--yes", "--draft-only"] },
			{ name: "refresh", what: "Refresh installed skills", flags: ["--json"] },
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
			{ name: "create", what: "A scoped, revocable token", flags: ["--scope"] },
			{ name: "list", what: "Every token and when it was last used", flags: ["--json"] },
			{ name: "revoke", what: "End a token" },
			{ name: "scopes", what: "The scopes a token can have", flags: ["--json"] },
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
	{ name: "allow", args: "<host>", what: "Let agents open a site (subdomains included)", group: "Sites" },
	{ name: "ask", args: "", what: "Agents ask before opening a site not yet allowed (default)", group: "Sites" },
	{ name: "allow-all", args: "", what: "Agents may open any site without asking", group: "Sites" },
	{ name: "yolo", args: "", what: "Old name of allow-all", group: "Sites", hidden: true },
	{ name: "doctor", args: "[--json]", what: "Check everything; one fix per problem", group: "Troubleshoot", flags: ["--json"] },
	{
		name: "update",
		args: "[--check] [--rollback]",
		what: "Install the latest signed release (--channel stable|nightly)",
		group: "Troubleshoot",
		flags: ["--check", "--json", "--rollback", "--yes", "--channel", "--auto-check"],
	},
	{ name: "install", args: "[--force]", what: "Re-register the native host with every browser", group: "Troubleshoot", flags: ["--force"] },
	{ name: "reload", args: "", what: "Reload the extension after rebuilding dist-chrome", group: "Troubleshoot" },
	{ name: "debug", args: "", what: "Bridge state, request timings and a benchmark (JSON)", group: "Troubleshoot" },
	{ name: "completion", args: "zsh|bash|fish", what: "Shell completions: eval \"$(tabkyra completion zsh)\"", group: "Troubleshoot", values: ["zsh", "bash", "fish"] },
	{ name: "version", args: "[--json]", what: "This CLI's version (also --version)", group: "Troubleshoot", flags: ["--json"] },
	{ name: "help", args: "", what: "This help (also --help)", group: "Troubleshoot", hidden: true },
	{ name: "host", args: "", what: "The native host the browser starts", group: "Troubleshoot", hidden: true },
];

export const VISIBLE_COMMANDS = COMMANDS.filter((c) => !c.hidden);

/** Exit codes every command uses; also printed by --help. */
export const EXIT_CODES = "Exit codes: 0 success, 1 failed or not connected, 2 usage error.";

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
