/**
 * `tabkyra skill install|print`: teach agents to use Tabkyra well. The skill text is
 * skills/tabkyra/SKILL.md, bundled into the CLI at build time, so every harness gets the
 * same words the MCP server's instructions are tested against (cli/test/skill.test.mjs).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import SKILL from "../../skills/tabkyra/SKILL.md";
import { which } from "./harness.ts";
import { banner, c, sym } from "./ui.ts";

/** Written under the frontmatter, so a later install knows the file is ours to replace. */
const MARKER = "<!-- Installed by `tabkyra skill install`; reinstalling replaces this file. -->";

export interface SkillTarget {
	id: string;
	name: string;
	detected: boolean;
	file: string;
}

export function skillTargets(): SkillTarget[] {
	const home = homedir();
	const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
	const codexHome = process.env.CODEX_HOME || join(home, ".codex");
	const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
	return [
		{
			id: "claude",
			name: "Claude Code",
			detected: Boolean(which("claude")) || existsSync(claudeHome),
			file: join(claudeHome, "skills", "tabkyra", "SKILL.md"),
		},
		{
			id: "codex",
			name: "Codex",
			detected: Boolean(which("codex")) || existsSync(codexHome),
			file: join(codexHome, "skills", "tabkyra", "SKILL.md"),
		},
		{
			id: "opencode",
			name: "OpenCode",
			detected: Boolean(which("opencode")) || existsSync(join(configHome, "opencode")),
			file: join(configHome, "opencode", "skills", "tabkyra", "SKILL.md"),
		},
	];
}

/** SKILL.md as installed: the bundled text with the marker after the frontmatter. */
export function skillFile(): string {
	const end = SKILL.indexOf("\n---\n", 4);
	if (!SKILL.startsWith("---\n") || end < 0) return `${MARKER}\n${SKILL}`;
	return `${SKILL.slice(0, end + 5)}${MARKER}\n${SKILL.slice(end + 5)}`;
}

/** The skill without frontmatter, as a section to paste into AGENTS.md or a system prompt. */
export function agentsSnippet(): string {
	const end = SKILL.indexOf("\n---\n", 4);
	const body = SKILL.startsWith("---\n") && end >= 0 ? SKILL.slice(end + 5) : SKILL;
	// One level down, so it nests under a project's own headings.
	const nested = body.trim().replace(/^(#{2,5}) /gm, "#$1 ");
	return `${nested.replace(/^# .*/, "## Browser: Tabkyra (MCP server `tabkyra`)")}\n`;
}

export type InstallState = "written" | "current" | "kept" | "skipped";

export function installSkill(options: { force: boolean; all: boolean }): Array<SkillTarget & { state: InstallState }> {
	const wanted = skillFile();
	return skillTargets().map((target) => {
		if (!target.detected && !options.all) return { ...target, state: "skipped" as const };
		if (existsSync(target.file)) {
			const existing = readFileSync(target.file, "utf8");
			if (existing === wanted) return { ...target, state: "current" as const };
			// Someone else's tabkyra skill, or hand edits without our marker: leave it unless --force.
			if (!existing.includes(MARKER) && !options.force) return { ...target, state: "kept" as const };
		}
		mkdirSync(join(target.file, ".."), { recursive: true });
		writeFileSync(target.file, wanted);
		return { ...target, state: "written" as const };
	});
}

export function runSkill(sub: string | undefined, flags: { force: boolean; all: boolean }): number {
	if (sub === "print") {
		process.stdout.write(agentsSnippet());
		return 0;
	}
	console.log(banner("skill"));
	const results = installSkill(flags);
	for (const r of results) {
		const where = c.dim(r.file);
		if (r.state === "written") console.log(`${sym.ok} ${r.name.padEnd(12)} wrote ${where}`);
		else if (r.state === "current") console.log(`${sym.ok} ${r.name.padEnd(12)} current ${where}`);
		else if (r.state === "kept") console.log(`${sym.warn} ${r.name.padEnd(12)} left alone: ${where} is not ours ${c.dim("(--force replaces it)")}`);
		else console.log(`${sym.dot} ${r.name.padEnd(12)} ${c.dim("not found (--all installs anyway)")}`);
	}
	console.log(`\n${sym.arrow} Other agents: ${c.bold("tabkyra skill print >> AGENTS.md")} adds the same text to a project.`);
	if (results.every((r) => r.state === "skipped")) {
		console.log(`${sym.fail} No Claude Code, Codex or OpenCode found.`);
		return 1;
	}
	return results.some((r) => r.state === "kept") ? 1 : 0;
}
