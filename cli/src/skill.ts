/**
 * `tabkyra skill install|list|print|lint`: teach agents to use Tabkyra well. The skill texts
 * live in skills/<name>/SKILL.md and are bundled into the CLI at build time
 * (skills-catalog.ts), so every harness gets the same words the tests check. The tabkyra
 * skill is tested against the MCP server's instructions (cli/test/skill.test.mjs); every
 * skill passes the lint in skill-lint.ts before it ships or installs.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { which } from "./harness.ts";
import { formatFindings, lintPath, lintText, parseFrontmatter } from "./skill-lint.ts";
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

// --- Local edits (overlays) ----------------------------------------------------------------
//
// `tabkyra skill apply` (used by the rsi skill) keeps the user's edited copy of a skill in
// ~/.config/tabkyra/skills-local/<name>/SKILL.md and records the bundled text it was based
// on. Install prefers the local copy while it still passes lint, and says when the bundled
// skill has changed underneath it, so updates are never silently lost and edits are never
// silently overwritten.

function configDir(): string {
	return process.env.TABKYRA_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tabkyra");
}

export function localSkillsDir(): string {
	return join(configDir(), "skills-local");
}

function historyDir(): string {
	return join(configDir(), "skill-history");
}

interface LocalIndex {
	[name: string]: { baseSha256: string | null; appliedAt: string };
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function readIndex(): LocalIndex {
	const file = join(localSkillsDir(), "index.json");
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, "utf8")) as LocalIndex;
	} catch {
		return {};
	}
}

function writeIndex(index: LocalIndex): void {
	mkdirSync(localSkillsDir(), { recursive: true });
	writeFileSync(join(localSkillsDir(), "index.json"), `${JSON.stringify(index, null, "\t")}\n`);
}

function localFile(name: string): string {
	return join(localSkillsDir(), name, "SKILL.md");
}

/** The user's local edit of a skill, if there is one and it still passes lint. */
function localText(name: string): { text?: string; problem?: string } {
	const file = localFile(name);
	if (!existsSync(file)) return {};
	if (lstatSync(file).isSymbolicLink()) return { problem: `${file} is a symlink` };
	const text = readFileSync(file, "utf8");
	const errors = lintText(file, text, { dirName: name }).filter((f) => f.severity === "error");
	return errors.length ? { problem: `${file} fails lint (${errors[0].rule})` } : { text };
}

function localNames(): string[] {
	if (!existsSync(localSkillsDir())) return [];
	return readdirSync(localSkillsDir()).filter((n) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(n) && existsSync(localFile(n)));
}

function allNames(): string[] {
	return [...new Set([...SKILLS.keys(), ...localNames()])];
}

function skillText(name: string): string {
	const local = localText(name);
	if (local.text !== undefined) return local.text;
	const text = SKILLS.get(name);
	if (text === undefined) throw new Error(`No skill named ${name}.`);
	return text;
}

/** Warnings for local edits: failing lint, or based on an older bundled version. */
function localWarnings(names: string[]): string[] {
	const index = readIndex();
	const warnings: string[] = [];
	for (const name of names) {
		const local = localText(name);
		if (local.problem) warnings.push(`Your edit of ${name} is not used: ${local.problem}. Fix it or run tabkyra skill revert ${name}.`);
		const bundled = SKILLS.get(name);
		const base = index[name]?.baseSha256;
		if (local.text !== undefined && bundled !== undefined && base && base !== sha256(bundled)) {
			warnings.push(`The bundled ${name} skill changed since your edit. Compare ${localFile(name)} with tabkyra skill print ${name}, then re-apply or revert.`);
		}
	}
	return warnings;
}

const PROTECTED_SKILLS = new Set(["rsi", "kyraskillmaker"]);

/**
 * Apply an edited or new skill: lint it, refuse edits to the skills that govern editing,
 * refuse dropping a section the current version has, back up what it replaces, record the
 * base, and install it into each detected harness.
 */
export function applySkill(path: string): { name: string; backup?: string; results: InstallResult[] } {
	const file = basename(path) === "SKILL.md" ? path : join(path, "SKILL.md");
	if (!existsSync(file)) throw new Error(`No SKILL.md at ${path}.`);
	if (lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symlink.`);
	const text = readFileSync(file, "utf8");
	const name = parseFrontmatter(text)?.name ?? "";
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new Error(`${file} has no valid name in its frontmatter.`);
	if (PROTECTED_SKILLS.has(name)) throw new Error(`The ${name} skill governs skill edits, so it changes only through a reviewed pull request.`);
	const errors = lintPath(dirname(file)).filter((f) => f.severity === "error");
	if (basename(dirname(file)) !== name) throw new Error(`The folder holding SKILL.md must be named ${name}.`);
	if (errors.length) throw new Error(`Lint failed:\n${formatFindings(errors)}`);
	const current = allNames().includes(name) ? skillText(name) : undefined;
	if (current !== undefined) {
		const headings = (t: string) => [...t.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
		const missing = headings(current).filter((h) => !headings(text).includes(h));
		if (missing.length) throw new Error(`The edit drops section${missing.length > 1 ? "s" : ""} ${missing.map((h) => `"${h}"`).join(", ")}. Edits add or change; they don't remove sections.`);
	}
	let backup: string | undefined;
	if (current !== undefined) {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		backup = join(historyDir(), name, `${stamp}.md`);
		mkdirSync(dirname(backup), { recursive: true });
		writeFileSync(backup, current);
	}
	mkdirSync(dirname(localFile(name)), { recursive: true });
	if (file !== localFile(name)) copyFileSync(file, localFile(name));
	const index = readIndex();
	const bundled = SKILLS.get(name);
	index[name] = { baseSha256: bundled === undefined ? null : sha256(bundled), appliedAt: new Date().toISOString() };
	writeIndex(index);
	return { name, backup, results: installSkills({ force: true, all: false, only: [name] }) };
}

/** Drop the local edit (kept in history) and reinstall the bundled skill. */
export function revertSkill(name: string): { removed: boolean; results: InstallResult[] } {
	const file = localFile(name);
	if (!existsSync(file)) return { removed: false, results: [] };
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const kept = join(historyDir(), name, `${stamp}.reverted.md`);
	mkdirSync(dirname(kept), { recursive: true });
	renameSync(file, kept);
	rmSync(dirname(file), { recursive: true, force: true });
	const index = readIndex();
	delete index[name];
	writeIndex(index);
	if (!SKILLS.has(name)) {
		// A skill that only ever existed locally: remove the copies we installed.
		for (const target of skillTargets()) {
			const installed = join(target.dir, name, "SKILL.md");
			if (existsSync(installed) && readFileSync(installed, "utf8").includes(MARKER)) rmSync(dirname(installed), { recursive: true, force: true });
		}
		return { removed: true, results: [] };
	}
	return { removed: true, results: installSkills({ force: true, all: false, only: [name] }) };
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
	const names = options.only?.length ? options.only : allNames();
	for (const name of names) skillText(name);
	// --force replaces someone else's file only for skills named on the command line, or the
	// tabkyra skill when none are named, never every skill at once.
	const forced = new Set(options.force ? (options.only?.length ? options.only : ["tabkyra"]) : []);
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
				if (!existing.includes(MARKER) && !forced.has(skill)) {
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
			console.log(`${sym.warn} ${target.name.padEnd(12)} left alone: ${c.dim(r.file)} is not ours ${c.dim(`(tabkyra skill install ${r.skill} --force replaces it)`)}`);
		}
	}
}

export function runSkill(sub: string | undefined, args: string[], flags: { force: boolean; all: boolean }): number {
	if (sub === "print") {
		const name = args[0] ?? "tabkyra";
		if (!allNames().includes(name)) {
			console.error(`No skill named ${name}. Run tabkyra skill list.`);
			return 2;
		}
		process.stdout.write(agentsSnippet(name));
		return 0;
	}
	if (sub === "list") {
		const local = new Set(localNames());
		for (const name of allNames()) {
			const description = /^description: (.*)$/m.exec(skillText(name))?.[1] ?? "";
			console.log(`${c.bold(name.padEnd(18))} ${description.split(". ")[0]}.${local.has(name) ? c.dim(" (your edit)") : ""}`);
		}
		for (const w of localWarnings(allNames())) console.log(`${sym.warn} ${w}`);
		return 0;
	}
	if (sub === "apply") {
		if (args.length !== 1) {
			console.error("Usage: tabkyra skill apply <folder with SKILL.md>");
			return 2;
		}
		try {
			const { name, backup, results } = applySkill(args[0]);
			console.log(`${sym.ok} Applied your edit of ${name}.${backup ? ` Backup: ${backup}` : ""}`);
			printInstall(results);
			console.log(`${sym.arrow} Undo: tabkyra skill revert ${name}`);
			return 0;
		} catch (err) {
			console.error(`${sym.fail} ${err instanceof Error ? err.message : String(err)}`);
			return 1;
		}
	}
	if (sub === "revert") {
		if (args.length !== 1) {
			console.error("Usage: tabkyra skill revert <name>");
			return 2;
		}
		const { removed, results } = revertSkill(args[0]);
		if (!removed) {
			console.log(`${sym.dot} ${args[0]} has no local edit.`);
			return 1;
		}
		console.log(`${sym.ok} Reverted ${args[0]}; the edit is kept in ${join(historyDir(), args[0])}.`);
		printInstall(results);
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
	const unknown = args.find((a) => !allNames().includes(a));
	if (unknown) {
		console.log(`${sym.fail} No skill named ${unknown}. Run tabkyra skill list.`);
		return 2;
	}
	const results = installSkills({ ...flags, only: args });
	printInstall(results);
	for (const w of localWarnings(args.length ? args : allNames())) console.log(`${sym.warn} ${w}`);
	console.log(`\n${sym.arrow} Other agents: ${c.bold("tabkyra skill print [name] >> AGENTS.md")} adds the same text to a project.`);
	if (results.every((r) => r.state === "skipped")) {
		console.log(`${sym.fail} No Claude Code, Codex or OpenCode found.`);
		return 1;
	}
	return results.some((r) => r.state === "kept") ? 1 : 0;
}
