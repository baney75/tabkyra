/**
 * `tabkyra skill install|list|print|lint|apply|revert`: teach agents to use Tabkyra well.
 * The skill texts live in skills/<name>/SKILL.md and are bundled into the CLI at build time
 * (skills-catalog.ts), so every harness gets the same words the tests check. The tabkyra
 * skill is tested against the MCP server's instructions (cli/test/skill.test.mjs); every
 * skill passes the lint in skill-lint.ts before it ships, installs or is applied.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { which } from "./harness.ts";
import { formatFindings, lintPath, lintText, parseFrontmatter } from "./skill-lint.ts";
import { SKILLS } from "./skills-catalog.ts";
import { banner, c, sym } from "./ui.ts";

/** Written under the frontmatter, so a later install knows the file is ours to replace. */
const MARKER = "<!-- Installed by `tabkyra skill install`; reinstalling replaces this file. -->";
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** The skills that govern skill editing change only through a reviewed pull request. */
const PROTECTED_SKILLS = new Set(["rsi", "kyraskillmaker"]);

export class SkillError extends Error {}

/** Every name reaches a path, so every name is checked first: no "..", no slashes. */
function assertName(name: string): string {
	if (!NAME.test(name) || name.length > 64) throw new SkillError(`"${name}" is not a skill name (lowercase-kebab-case).`);
	return name;
}

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
// ~/.config/tabkyra/skills-local/<name>/SKILL.md and records it in index.json with the
// bundled text it was based on. A local copy is used only when the index records it, it
// passes lint, it isn't a protected skill, and it keeps every section of the bundled text;
// otherwise install falls back to the bundled skill and says why. Install also says when
// the bundled skill changed underneath an edit, so updates are never silently lost.

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
		const data = JSON.parse(readFileSync(file, "utf8")) as LocalIndex;
		return Object.fromEntries(Object.entries(data).filter(([name]) => NAME.test(name)));
	} catch {
		return {};
	}
}

function writeIndex(index: LocalIndex): void {
	mkdirSync(localSkillsDir(), { recursive: true });
	writeFileSync(join(localSkillsDir(), "index.json"), `${JSON.stringify(index, null, "\t")}\n`);
}

/** The folder for one local skill, proven to sit directly inside skills-local. */
function localSkillDir(name: string): string {
	const root = resolve(localSkillsDir());
	const dir = resolve(root, assertName(name));
	if (relative(root, dir) !== name) throw new SkillError(`${name} resolves outside ${root}.`);
	return dir;
}

function localFile(name: string): string {
	return join(localSkillDir(name), "SKILL.md");
}

/** Sections by `## ` heading, ignoring headings inside code fences. */
function sections(text: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	let current: string[] | undefined;
	let fence = "";
	for (const line of text.split("\n")) {
		const mark = /^ {0,3}(```+|~~~+)/.exec(line)?.[1];
		if (mark && !fence) fence = mark;
		else if (mark && fence && mark[0] === fence[0] && mark.length >= fence.length) fence = "";
		const heading = !fence && !mark ? /^## (.+)$/.exec(line)?.[1]?.trim() : undefined;
		if (heading !== undefined) {
			current = [];
			out.set(heading, current);
		} else current?.push(line);
	}
	return out;
}

const headings = (t: string) => [...sections(t).keys()];

/** Sections whose every line an edit must keep: safety rules, stop conditions, purpose checks. */
const PROTECTED_SECTION = /safety|rules|done when|ethics|purpose check|limits|never/i;

/** Lines a draft removed from a protected section of the current text. */
function droppedProtectedLines(current: string, draft: string): string[] {
	const before = sections(current);
	const after = sections(draft);
	const dropped: string[] = [];
	for (const [heading, lines] of before) {
		if (!PROTECTED_SECTION.test(heading)) continue;
		const kept = new Set((after.get(heading) ?? []).map((l) => l.trim()));
		for (const line of lines) if (line.trim() && !kept.has(line.trim())) dropped.push(`${heading}: ${line.trim()}`);
	}
	return dropped;
}

/** Why a local copy can't be used, or its text. */
function localText(name: string): { text?: string; problem?: string } {
	const file = localFile(name);
	if (!existsSync(file) && !isLink(file)) return {};
	if (!readIndex()[name]) return { problem: `${file} wasn't added with tabkyra skill apply` };
	if (PROTECTED_SKILLS.has(name)) return { problem: `${name} changes only through a reviewed pull request` };
	if (isLink(file) || isLink(dirname(file))) return { problem: `${file} is a symlink` };
	const text = readFileSync(file, "utf8");
	const errors = lintText(file, text, { dirName: name }).filter((f) => f.severity === "error");
	if (errors.length) return { problem: `${file} fails lint (${errors[0].rule})` };
	const bundled = SKILLS.get(name);
	const missing = bundled === undefined ? [] : headings(bundled).filter((h) => !headings(text).includes(h));
	if (missing.length) return { problem: `${file} drops the section "${missing[0]}"` };
	const dropped = bundled === undefined ? [] : droppedProtectedLines(bundled, text);
	if (dropped.length) return { problem: `${file} removes a protected line (${dropped[0].slice(0, 80)})` };
	return { text };
}

function isLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Local skill folders that index.json records, valid names only. */
function localNames(): string[] {
	if (!existsSync(localSkillsDir())) return [];
	const index = readIndex();
	return readdirSync(localSkillsDir()).filter((n) => NAME.test(n) && index[n] && existsSync(join(localSkillsDir(), n, "SKILL.md")));
}

/** Bundled skills, plus local-only skills whose copy is usable. */
function allNames(): string[] {
	const usableLocal = localNames().filter((n) => SKILLS.has(n) || localText(n).text !== undefined);
	return [...new Set([...SKILLS.keys(), ...usableLocal])];
}

function skillText(name: string): string {
	const local = localText(name);
	if (local.text !== undefined) return local.text;
	const text = SKILLS.get(name);
	if (text === undefined) throw new SkillError(`No skill named ${name}. Run tabkyra skill list.`);
	return text;
}

/** Warnings for local edits: unusable, or based on an older bundled version. */
function localWarnings(): string[] {
	const index = readIndex();
	const names = existsSync(localSkillsDir()) ? readdirSync(localSkillsDir()).filter((n) => NAME.test(n)) : [];
	const warnings: string[] = [];
	for (const name of names) {
		const local = localText(name);
		if (local.problem) warnings.push(`Your local copy of ${name} is not used: ${local.problem}. Fix it, re-apply it, or run tabkyra skill revert ${name}.`);
		const bundled = SKILLS.get(name);
		const base = index[name]?.baseSha256;
		if (local.text !== undefined && bundled !== undefined && base && base !== sha256(bundled)) {
			warnings.push(`The bundled ${name} skill changed since your edit. Compare tabkyra skill print ${name} --raw with the bundled text, then re-apply or revert.`);
		}
	}
	return warnings;
}

// --- Rendering ---------------------------------------------------------------------------

/** SKILL.md as installed: the text with the marker after the frontmatter. */
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

// --- Install -----------------------------------------------------------------------------

export type InstallState = "written" | "current" | "kept" | "linked" | "skipped";

export interface InstallResult {
	target: SkillTarget;
	skill: string;
	file: string;
	state: InstallState;
	backup?: string;
}

function stamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Copy a file we're about to replace into skill-history/<name>/. */
function backUp(name: string, file: string, label: string): string {
	const dest = join(historyDir(), assertName(name), `${stamp()}.${label}.md`);
	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, readFileSync(file));
	return dest;
}

/**
 * Install skills (all, or `only`) into each detected harness. A file without our marker is
 * someone else's and is left alone, unless `force` names it: only skills named on the
 * command line, or tabkyra when none are. Anything replaced is backed up first.
 */
export function installSkills(options: { force: boolean; all: boolean; only?: string[] }): InstallResult[] {
	const names = (options.only?.length ? options.only : allNames()).map(assertName);
	for (const name of names) skillText(name);
	const forced = new Set(options.force ? (options.only?.length ? options.only : ["tabkyra"]) : []);
	const results: InstallResult[] = [];
	for (const target of skillTargets()) {
		for (const skill of names) {
			const file = join(target.dir, skill, "SKILL.md");
			if (!target.detected && !options.all) {
				results.push({ target, skill, file, state: "skipped" });
				continue;
			}
			if (isLink(file) || isLink(dirname(file))) {
				results.push({ target, skill, file, state: "linked" });
				continue;
			}
			const wanted = skillFile(skill);
			let backup: string | undefined;
			if (existsSync(file)) {
				const existing = readFileSync(file, "utf8");
				if (existing === wanted) {
					results.push({ target, skill, file, state: "current" });
					continue;
				}
				// Someone else's skill of the same name, or hand edits without our marker: leave it unless forced.
				if (!existing.includes(MARKER) && !forced.has(skill)) {
					results.push({ target, skill, file, state: "kept" });
					continue;
				}
				if (!existing.includes(MARKER)) backup = backUp(skill, file, `${target.id}-replaced`);
			}
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, wanted);
			results.push({ target, skill, file, state: "written", backup });
		}
	}
	return results;
}

// --- Apply and revert --------------------------------------------------------------------

/** A line diff in order (longest common subsequence), so reordered or repeated lines show. */
function lineDiff(before: string, after: string): string {
	const a = before.split("\n");
	const b = after.split("\n");
	const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
	}
	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			i++;
			j++;
		} else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) out.push(`+ ${b[j++]}`);
		else out.push(`- ${a[i++]}`);
	}
	return out.length ? out.join("\n") : "(no changes)";
}

function withoutMarker(text: string): string {
	return text
		.split("\n")
		.filter((l) => l.trim() !== MARKER)
		.join("\n");
}

export interface ApplyPlan {
	name: string;
	text: string;
	current?: string;
	diff: string;
}

/** Check an edited or new skill without changing anything. */
export function planApply(path: string): ApplyPlan {
	const file = basename(path) === "SKILL.md" ? path : join(path, "SKILL.md");
	if (!existsSync(file)) throw new SkillError(`No SKILL.md at ${path}.`);
	if (isLink(file) || isLink(dirname(file))) throw new SkillError(`${file} is a symlink.`);
	const text = withoutMarker(readFileSync(file, "utf8"));
	const name = parseFrontmatter(text)?.name ?? "";
	assertName(name);
	if (PROTECTED_SKILLS.has(name)) throw new SkillError(`The ${name} skill governs skill edits, so it changes only through a reviewed pull request.`);
	if (basename(dirname(file)) !== name) throw new SkillError(`The folder holding SKILL.md must be named ${name}.`);
	const errors = [...lintPath(dirname(file)), ...lintText(file, text, { dirName: name })].filter((f) => f.severity === "error");
	if (errors.length) throw new SkillError(`Lint failed:\n${formatFindings(errors)}`);
	const current = SKILLS.has(name) || localText(name).text !== undefined ? skillText(name) : undefined;
	if (current !== undefined) {
		const missing = headings(current).filter((h) => !headings(text).includes(h));
		if (missing.length) throw new SkillError(`The edit drops section${missing.length > 1 ? "s" : ""} ${missing.map((h) => `"${h}"`).join(", ")}. Edits add or change; they don't remove sections.`);
		const dropped = droppedProtectedLines(current, text);
		if (dropped.length) {
			throw new SkillError(`The edit removes lines from a protected section (safety, rules, done when). Add to those sections; don't take away:\n${dropped.map((d) => `  ${d}`).join("\n")}`);
		}
	}
	return { name, text, current, diff: lineDiff(current ?? "", text) };
}

/** Apply a checked plan: back up, keep the edit, install it where nothing else owns the name. */
export function applySkill(plan: ApplyPlan): { backup?: string; results: InstallResult[] } {
	let backup: string | undefined;
	if (plan.current !== undefined) {
		backup = join(historyDir(), plan.name, `${stamp()}.md`);
		mkdirSync(dirname(backup), { recursive: true });
		writeFileSync(backup, plan.current);
	}
	for (const p of [configDir(), localSkillsDir(), localSkillDir(plan.name), localFile(plan.name)]) {
		if (isLink(p)) throw new SkillError(`${p} is a symbolic link; Tabkyra won't write through it. Remove it by hand.`);
	}
	mkdirSync(localSkillDir(plan.name), { recursive: true });
	// Temp file + rename replaces the path itself, never a file a link points at.
	const tmp = `${localFile(plan.name)}.${process.pid}.tmp`;
	writeFileSync(tmp, plan.text, { flag: "wx" });
	renameSync(tmp, localFile(plan.name));
	const index = readIndex();
	const bundled = SKILLS.get(plan.name);
	index[plan.name] = { baseSha256: bundled === undefined ? null : sha256(bundled), appliedAt: new Date().toISOString() };
	writeIndex(index);
	return { backup, results: installSkills({ force: false, all: false, only: [plan.name] }) };
}

/** Drop the local edit (kept in history) and reinstall the bundled skill. */
export function revertSkill(name: string): { removed: boolean; results: InstallResult[] } {
	const dir = localSkillDir(name);
	const file = join(dir, "SKILL.md");
	const index = readIndex();
	if (!existsSync(file) && !index[name]) return { removed: false, results: [] };
	if (isLink(dir) || isLink(file)) throw new SkillError(`${file} is a symlink; remove it by hand.`);
	if (existsSync(file)) {
		const kept = join(historyDir(), name, `${stamp()}.reverted.md`);
		mkdirSync(dirname(kept), { recursive: true });
		renameSync(file, kept);
	}
	rmSync(dir, { recursive: true, force: true });
	delete index[name];
	writeIndex(index);
	if (!SKILLS.has(name)) {
		// A skill that only ever existed locally: remove the copies we installed, never anyone else's.
		for (const target of skillTargets()) {
			const installed = join(target.dir, name, "SKILL.md");
			if (isLink(installed) || isLink(dirname(installed))) continue;
			if (existsSync(installed) && readFileSync(installed, "utf8").includes(MARKER)) rmSync(installed);
		}
		return { removed: true, results: [] };
	}
	return { removed: true, results: installSkills({ force: false, all: false, only: [name] }) };
}

// --- CLI ---------------------------------------------------------------------------------

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
		for (const r of mine.filter((r) => r.backup)) console.log(`${sym.dot} ${target.name.padEnd(12)} replaced ${r.file}; the old file is in ${c.dim(r.backup ?? "")}`);
		for (const r of mine.filter((r) => r.state === "linked")) {
			console.log(`${sym.warn} ${target.name.padEnd(12)} left alone: ${c.dim(r.file)} is a symbolic link, and Tabkyra won't write through one. Replace the link by hand to install it.`);
		}
		for (const r of mine.filter((r) => r.state === "kept")) {
			console.log(`${sym.warn} ${target.name.padEnd(12)} left alone: ${c.dim(r.file)} is not ours ${c.dim(`(tabkyra skill install ${r.skill} --force replaces it)`)}`);
		}
	}
}

export function runSkill(sub: string | undefined, args: string[], flags: { force: boolean; all: boolean; raw?: boolean; yes?: boolean }): number {
	try {
		return runSkillCommand(sub, args, flags);
	} catch (err) {
		if (!(err instanceof SkillError)) throw err;
		console.error(`${sym.fail} ${err.message}`);
		return 1;
	}
}

function runSkillCommand(sub: string | undefined, args: string[], flags: { force: boolean; all: boolean; raw?: boolean; yes?: boolean }): number {
	if (sub === "print") {
		const name = assertName(args[0] ?? "tabkyra");
		if (!allNames().includes(name)) throw new SkillError(`No skill named ${name}. Run tabkyra skill list.`);
		// --raw: the exact SKILL.md source in use, the starting point for an edit.
		process.stdout.write(flags.raw ? skillText(name) : agentsSnippet(name));
		return 0;
	}
	if (sub === "list") {
		const local = new Set(localNames().filter((n) => localText(n).text !== undefined));
		for (const name of allNames()) {
			const description = /^description: (.*)$/m.exec(skillText(name))?.[1] ?? "";
			console.log(`${c.bold(name.padEnd(18))} ${description.split(". ")[0]}.${local.has(name) ? c.dim(" (your edit)") : ""}`);
		}
		for (const w of localWarnings()) console.log(`${sym.warn} ${w}`);
		return 0;
	}
	if (sub === "lint") {
		const findings = args.length === 0 ? [...SKILLS].flatMap(([name, text]) => lintText(`(bundled) ${name}`, text, { dirName: name })) : args.flatMap((p) => lintPath(p));
		const errors = findings.filter((f) => f.severity === "error");
		if (findings.length) console.log(formatFindings(findings));
		console.log(errors.length ? `${sym.fail} ${errors.length} problem${errors.length === 1 ? "" : "s"}. Fix each one; lint allows no exceptions.` : `${sym.ok} Clean.`);
		return errors.length ? 1 : 0;
	}
	if (sub === "apply") {
		if (args.length !== 1) throw new SkillError("Usage: tabkyra skill apply <folder with SKILL.md> [--yes]");
		const plan = planApply(args[0]);
		console.log(`${c.bold(`Change to ${plan.name}:`)}\n${plan.diff}\n`);
		if (!flags.yes) {
			console.log(`${sym.arrow} Lint passed. Nothing changed yet. Show this to the user; run again with --yes once they approve.`);
			return 3;
		}
		const { backup, results } = applySkill(plan);
		console.log(`${sym.ok} Applied your edit of ${plan.name}.${backup ? ` Backup: ${backup}` : ""}`);
		printInstall(results);
		console.log(`${sym.arrow} Undo: tabkyra skill revert ${plan.name}`);
		return results.some((r) => r.state === "kept" || r.state === "linked") ? 1 : 0;
	}
	if (sub === "revert") {
		if (args.length !== 1) throw new SkillError("Usage: tabkyra skill revert <name>");
		const name = assertName(args[0]);
		const { removed, results } = revertSkill(name);
		if (!removed) {
			console.log(`${sym.dot} ${name} has no local edit.`);
			return 1;
		}
		console.log(`${sym.ok} Reverted ${name}; the edit is kept in ${join(historyDir(), name)}.`);
		printInstall(results);
		return 0;
	}
	console.log(banner("skill"));
	for (const a of args) assertName(a);
	const unknown = args.find((a) => !allNames().includes(a));
	if (unknown) {
		console.log(`${sym.fail} No skill named ${unknown}. Run tabkyra skill list.`);
		return 2;
	}
	const results = installSkills({ ...flags, only: args });
	printInstall(results);
	for (const w of localWarnings()) console.log(`${sym.warn} ${w}`);
	console.log(`\n${sym.arrow} Other agents: ${c.bold("tabkyra skill print [name] >> AGENTS.md")} adds the same text to a project.`);
	if (results.every((r) => r.state === "skipped")) {
		console.log(`${sym.fail} No Claude Code, Codex or OpenCode found.`);
		return 1;
	}
	return results.some((r) => r.state === "kept" || r.state === "linked") ? 1 : 0;
}
