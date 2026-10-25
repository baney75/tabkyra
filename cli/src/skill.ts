/**
 * `tabkyra skill install|list|print|lint`: teach agents to use Tabkyra well. The skill texts
 * live in skills/<name>/SKILL.md and are bundled into the CLI at build time
 * (skills-catalog.ts), so every harness gets the same words the tests check. The tabkyra
 * skill is tested against the MCP server's instructions (cli/test/skill.test.mjs); every
 * skill passes the lint in skill-lint.ts before it ships or installs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { which } from "./harness.ts";
import { formatFindings, lintPath, lintText } from "./skill-lint.ts";
import { SKILLS } from "./skills-catalog.ts";
import { banner, c, sym } from "./ui.ts";

/** Written under the frontmatter, so a later install knows the file is ours to replace. */
const MARKER = "<!-- Installed by `tabkyra skill install`; reinstalling replaces this file. -->";

export interface SkillTarget {
	id: string;
	name: string;
	detected: boolean;
	/** The harness's skills folder; each skill goes in <dir>/<skill>/SKILL.md. */
	dir: string;
	/** Where the tabkyra skill goes, kept for callers that name one file. */
	file: string;
}

export function skillTargets(): SkillTarget[] {
	const home = homedir();
	const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
	const codexHome = process.env.CODEX_HOME || join(home, ".codex");
	const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
	const target = (id: string, name: string, detected: boolean, dir: string): SkillTarget => ({
		id,
		name,
		detected,
		dir,
		file: join(dir, "tabkyra", "SKILL.md"),
	});
	return [
		target("claude", "Claude Code", Boolean(which("claude")) || existsSync(claudeHome), join(claudeHome, "skills")),
		target("codex", "Codex", Boolean(which("codex")) || existsSync(codexHome), join(codexHome, "skills")),
		target("opencode", "OpenCode", Boolean(which("opencode")) || existsSync(join(configHome, "opencode")), join(configHome, "opencode", "skills")),
	];
}

function skillText(name: string): string {
	const text = SKILLS.get(name);
	if (text === undefined) throw new Error(`No bundled skill named ${name}.`);
	return text;
}

/** SKILL.md as installed: the bundled text with the marker after the frontmatter. */
export function skillFile(name = "tabkyra"): string {
	const text = skillText(name);
	const end = text.indexOf("\n---\n", 4);
	if (!text.startsWith("---\n") || end < 0) return `${MARKER}\n${text}`;
	return `${text.slice(0, end + 5)}${MARKER}\n${text.slice(end + 5)}`;
}

/** The skill without frontmatter, as a section to paste into AGENTS.md or a system prompt. */
export function agentsSnippet(name = "tabkyra"): string {
	const text = skillText(name);
	const end = text.indexOf("\n---\n", 4);
	const body = text.startsWith("---\n") && end >= 0 ? text.slice(end + 5) : text;
	// One level down, so it nests under a project's own headings.
	const nested = body.trim().replace(/^(#{2,5}) /gm, "#$1 ");
	const heading = name === "tabkyra" ? "## Browser: Tabkyra (MCP server `tabkyra`)" : `## Skill: ${name}`;
	return `${nested.replace(/^# .*/, heading)}\n`;
}

export type InstallState = "written" | "current" | "kept" | "skipped";

export interface InstallResult {
	target: SkillTarget;
	skill: string;
	file: string;
	state: InstallState;
}

/** Install the bundled skills (all, or `only`) into each detected harness. */
export function installSkills(options: { force: boolean; all: boolean; only?: string[] }): InstallResult[] {
	const names = options.only?.length ? options.only : [...SKILLS.keys()];
	for (const name of names) skillText(name);
	const results: InstallResult[] = [];
	for (const target of skillTargets()) {
		for (const skill of names) {
			const file = join(target.dir, skill, "SKILL.md");
			if (!target.detected && !options.all) {
				results.push({ target, skill, file, state: "skipped" });
				continue;
			}
			const wanted = skillFile(skill);
			if (existsSync(file)) {
				const existing = readFileSync(file, "utf8");
				if (existing === wanted) {
					results.push({ target, skill, file, state: "current" });
					continue;
				}
				// Someone else's skill of the same name, or hand edits without our marker: leave it unless --force.
				if (!existing.includes(MARKER) && !options.force) {
					results.push({ target, skill, file, state: "kept" });
					continue;
				}
			}
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, wanted);
			results.push({ target, skill, file, state: "written" });
		}
	}
	return results;
}

function printInstall(results: InstallResult[]): void {
	for (const target of skillTargets()) {
		const mine = results.filter((r) => r.target.id === target.id);
		if (mine.length === 0) continue;
		if (mine.every((r) => r.state === "skipped")) {
			console.log(`${sym.dot} ${target.name.padEnd(12)} ${c.dim("not found (--all installs anyway)")}`);
			continue;
		}
		const changed = mine.filter((r) => r.state === "written").map((r) => r.skill);
		const current = mine.filter((r) => r.state === "current").map((r) => r.skill);
		if (changed.length) console.log(`${sym.ok} ${target.name.padEnd(12)} wrote ${changed.join(", ")} ${c.dim(target.dir)}`);
		if (current.length) console.log(`${sym.ok} ${target.name.padEnd(12)} current ${current.join(", ")}`);
		for (const r of mine.filter((r) => r.state === "kept")) {
			console.log(`${sym.warn} ${target.name.padEnd(12)} left alone: ${c.dim(r.file)} is not ours ${c.dim("(--force replaces it)")}`);
		}
	}
}

export function runSkill(sub: string | undefined, args: string[], flags: { force: boolean; all: boolean }): number {
	if (sub === "print") {
		const name = args[0] ?? "tabkyra";
		if (!SKILLS.has(name)) {
			console.error(`No bundled skill named ${name}. Run tabkyra skill list.`);
			return 2;
		}
		process.stdout.write(agentsSnippet(name));
		return 0;
	}
	if (sub === "list") {
		for (const [name, text] of SKILLS) {
			const description = /^description: (.*)$/m.exec(text)?.[1] ?? "";
			console.log(`${c.bold(name.padEnd(18))} ${description.split(". ")[0]}.`);
		}
		return 0;
	}
	if (sub === "lint") {
		const findings = args.length === 0 ? [...SKILLS].flatMap(([name, text]) => lintText(`(bundled) ${name}`, text, { dirName: name })) : args.flatMap((p) => lintPath(p));
		const errors = findings.filter((f) => f.severity === "error");
		if (findings.length) console.log(formatFindings(findings));
		console.log(errors.length ? `${sym.fail} ${errors.length} problem${errors.length === 1 ? "" : "s"}. Fix each one; lint allows no exceptions.` : `${sym.ok} Clean.`);
		return errors.length ? 1 : 0;
	}
	console.log(banner("skill"));
	const unknown = args.find((a) => !SKILLS.has(a));
	if (unknown) {
		console.log(`${sym.fail} No bundled skill named ${unknown}. Run tabkyra skill list.`);
		return 2;
	}
	const results = installSkills({ ...flags, only: args });
	printInstall(results);
	console.log(`\n${sym.arrow} Other agents: ${c.bold("tabkyra skill print [name] >> AGENTS.md")} adds the same text to a project.`);
	if (results.every((r) => r.state === "skipped")) {
		console.log(`${sym.fail} No Claude Code, Codex or OpenCode found.`);
		return 1;
	}
	return results.some((r) => r.state === "kept") ? 1 : 0;
}
