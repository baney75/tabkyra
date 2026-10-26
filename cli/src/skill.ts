/**
 * `tabkyra skill install|list|print|lint|apply|revert|match|eval|versions|rollback|edit`:
 * teach agents to use Tabkyra well.
 * The skill texts live in skills/<name>/SKILL.md and are bundled into the CLI at build time
 * (skills-catalog.ts), so every harness gets the same words the tests check. The tabkyra
 * skill is tested against the MCP server's instructions (cli/test/skill.test.mjs); every
 * skill passes the lint in skill-lint.ts before it ships, installs or is applied. The router
 * (skill-router.ts) picks the skill for a task; docs/skill-platform.md describes the whole.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { which } from "./harness.ts";
import { EvalError, formatBaseline, parseBaseline, parseCases, parseDrops, processRanker, type Ranker, runBaseCheck, runEval } from "./skill-eval.ts";
import { formatFindings, lintPath, lintText, parseFrontmatter } from "./skill-lint.ts";
import { buildRouterIndex, matchSkills, oneLine, type RouterIndex, type RouterSkill, type SkillMatch } from "./skill-router.ts";
import { SKILLS } from "./skills-catalog.ts";
import { banner, c, sym } from "./ui.ts";

/** Written under the frontmatter, so a later install knows the file is ours to replace. */
const MARKER = "<!-- Installed by `tabkyra skill install`; reinstalling replaces this file. -->";
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** A usable skill name: "none" is reserved for the router's "no skill fits". */
const isName = (n: string) => NAME.test(n) && n !== "none";
/** The skills that govern skill editing change only through a reviewed pull request. */
const PROTECTED_SKILLS = new Set(["rsi", "kyraskillmaker"]);

export class SkillError extends Error {}

/** Every name reaches a path, so every name is checked first: no "..", no slashes. */
export function assertName(name: string): string {
	if (!NAME.test(name) || name.length > 64) throw new SkillError(`"${name}" is not a skill name (lowercase-kebab-case).`);
	if (name === "none") throw new SkillError('"none" is reserved: the router answers "none" when no skill fits.');
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
	/**
	 * `budget`: applied by a version that enforces the size budget (skill-lint.ts). An edit
	 * applied before then is still used when it's over budget, with a warning; new applies
	 * must fit.
	 */
	[name: string]: { baseSha256: string | null; appliedAt: string; budget?: boolean };
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function readIndex(): LocalIndex {
	const file = join(localSkillsDir(), "index.json");
	if (!existsSync(file)) return {};
	try {
		const data = JSON.parse(readFileSync(file, "utf8")) as LocalIndex;
		return Object.fromEntries(Object.entries(data).filter(([name]) => isName(name)));
	} catch {
		return {};
	}
}

function indexFile(): string {
	return join(localSkillsDir(), "index.json");
}

function writeIndex(index: LocalIndex): void {
	assertNoLinks([configDir(), localSkillsDir(), indexFile()]);
	mkdirSync(localSkillsDir(), { recursive: true });
	// Temp file + rename replaces the path itself, never a file a link points at.
	const tmp = `${indexFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(index, null, "\t")}\n`, { flag: "wx" });
	renameSync(tmp, indexFile());
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

/**
 * Protected sections a draft changed in any way. They are read-only to `skill apply`: an
 * added line can cancel a rule as surely as a removed one, so these change only through a
 * reviewed pull request.
 */
function changedProtectedSections(current: string, draft: string): string[] {
	const before = sections(current);
	const after = sections(draft);
	const norm = (lines: string[] | undefined) => (lines ?? []).map((l) => l.trim()).filter(Boolean).join("\n");
	return [...before.keys()].filter((h) => PROTECTED_SECTION.test(h) && norm(before.get(h)) !== norm(after.get(h)));
}

/** Why a local copy can't be used, or its text. */
function localText(name: string): { text?: string; problem?: string; overBudget?: boolean } {
	const file = localFile(name);
	if (!existsSync(file) && !isLink(file)) return {};
	if (!readIndex()[name]) return { problem: `${file} wasn't added with tabkyra skill apply` };
	if (PROTECTED_SKILLS.has(name)) return { problem: `${name} changes only through a reviewed pull request` };
	if (isLink(file) || isLink(dirname(file))) return { problem: `${file} is a symlink` };
	if (!lstatSync(file).isFile()) return { problem: `${file} is not a file` };
	const text = readFileSync(file, "utf8");
	const all = lintText(file, text, { dirName: name }).filter((f) => f.severity === "error");
	// The budget came after some edits were applied: those stay in use, with a warning.
	const grandfathered = readIndex()[name]?.budget !== true;
	const overBudget = all.some((f) => f.rule === "budget");
	const errors = grandfathered ? all.filter((f) => f.rule !== "budget") : all;
	if (errors.length) return { problem: `${file} fails lint (${errors[0].rule})` };
	const bundled = SKILLS.get(name);
	const missing = bundled === undefined ? [] : headings(bundled).filter((h) => !headings(text).includes(h));
	if (missing.length) return { problem: `${file} drops the section "${missing[0]}"` };
	const added = bundled === undefined ? [] : headings(text).filter((h) => !headings(bundled).includes(h));
	if (added.length) return { problem: `${file} adds the section "${added[0]}"` };
	const changed = bundled === undefined ? [] : changedProtectedSections(bundled, text);
	if (changed.length) return { problem: `${file} changes the protected section "${changed[0]}"` };
	return { text, overBudget: overBudget && grandfathered };
}

/** Refuse to touch anything under a symbolic link: a link could lead outside Tabkyra's folders. */
function assertNoLinks(paths: string[]): void {
	for (const p of paths) if (isLink(p)) throw new SkillError(`${p} is a symbolic link; Tabkyra won't read or write through it. Remove it by hand.`);
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
	return readdirSync(localSkillsDir()).filter((n) => isName(n) && index[n] && existsSync(join(localSkillsDir(), n, "SKILL.md")));
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
	const names = existsSync(localSkillsDir()) ? readdirSync(localSkillsDir()).filter((n) => isName(n)) : [];
	const warnings: string[] = [];
	for (const name of names) {
		const local = localText(name);
		if (local.problem) warnings.push(`Your local copy of ${name} is not used: ${local.problem}. Fix it, re-apply it, or run tabkyra skill revert ${name}.`);
		if (local.overBudget) {
			warnings.push(
				`Your local copy of ${name} (${localFile(name)}) is over the skill budget (lint rule "budget": 150 lines and 8,000 characters). It was applied before the budget, so it is still used; trim it and apply it again, since a new apply must fit.`,
			);
		}
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
	assertNoLinks([configDir(), historyDir(), dirname(dest)]);
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
			if (existsSync(file) && !lstatSync(file).isFile()) {
				results.push({ target, skill, file, state: "kept" });
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
		const added = headings(text).filter((h) => !headings(current).includes(h));
		if (added.length) {
			throw new SkillError(`The edit adds section${added.length > 1 ? "s" : ""} ${added.map((h) => `"${h}"`).join(", ")}. Edits change existing sections; a new section could override a protected one, so it needs a reviewed pull request.`);
		}
		const changed = changedProtectedSections(current, text);
		if (changed.length) {
			throw new SkillError(`The edit changes a protected section (${changed.map((h) => `"${h}"`).join(", ")}). Safety, rules, purpose-check and done-when sections change only through a reviewed pull request.`);
		}
	}
	return { name, text, current, diff: lineDiff(current ?? "", text) };
}

/** Apply a checked plan: back up, keep the edit, install it where nothing else owns the name. */
export function applySkill(plan: ApplyPlan): { backup?: string; results: InstallResult[] } {
	assertNoLinks([configDir(), localSkillsDir(), indexFile(), historyDir(), join(historyDir(), plan.name), localSkillDir(plan.name), localFile(plan.name)]);
	let backup: string | undefined;
	if (plan.current !== undefined) {
		backup = join(historyDir(), plan.name, `${stamp()}.md`);
		mkdirSync(dirname(backup), { recursive: true });
		writeFileSync(backup, plan.current);
	}
	assertNoLinks([configDir(), localSkillsDir(), historyDir(), localSkillDir(plan.name), localFile(plan.name)]);
	mkdirSync(localSkillDir(plan.name), { recursive: true });
	// Temp file + rename replaces the path itself, never a file a link points at.
	const tmp = `${localFile(plan.name)}.${process.pid}.tmp`;
	writeFileSync(tmp, plan.text, { flag: "wx" });
	renameSync(tmp, localFile(plan.name));
	const index = readIndex();
	const bundled = SKILLS.get(plan.name);
	index[plan.name] = { baseSha256: bundled === undefined ? null : sha256(bundled), appliedAt: new Date().toISOString(), budget: true };
	writeIndex(index);
	return { backup, results: installSkills({ force: false, all: false, only: [plan.name] }) };
}

/** Drop the local edit (kept in history) and reinstall the bundled skill. */
export function revertSkill(name: string): { removed: boolean; results: InstallResult[] } {
	const dir = localSkillDir(name);
	const file = join(dir, "SKILL.md");
	const index = readIndex();
	if (!existsSync(file) && !index[name]) return { removed: false, results: [] };
	assertNoLinks([configDir(), localSkillsDir(), indexFile(), historyDir(), join(historyDir(), name), dir, file]);
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

// --- Router ------------------------------------------------------------------------------
//
// skill_match and `tabkyra skill match` route over the skills in use: the bundled ones and
// the user's applied local copies. The index is built once per process and rebuilt only
// when skills-local changes, which a few stat calls detect.

let router: { key: string; index: RouterIndex } | undefined;

/**
 * Changes whenever an apply, revert or rollback changes the local skills. Apply writes through
 * a temp file and a rename, so the inode changes even when two edits of the same size land
 * within one timestamp tick; index.json is hashed for the same reason.
 */
function localStateKey(): string {
	const dir = localSkillsDir();
	if (!existsSync(dir)) return "";
	const stat = (p: string) => {
		try {
			const s = lstatSync(p);
			return `${s.ino}:${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
		} catch {
			return "-";
		}
	};
	const index = indexFile();
	const indexHash = existsSync(index) && !isLink(index) ? sha256(readFileSync(index, "utf8")) : "-";
	return `${indexHash};${readdirSync(dir)
		.sort()
		.map((n) => `${n}=${stat(join(dir, n))}/${stat(join(dir, n, "SKILL.md"))}`)
		.join(",")}`;
}

function routerIndex(): RouterIndex {
	const key = localStateKey();
	if (!router || router.key !== key) router = { key, index: buildRouterIndex(allNames().map((name) => ({ name, text: skillText(name) }))) };
	return router.index;
}

let bundledRouter: RouterIndex | undefined;

/** The index over bundled skills only, for remote sessions. */
function bundledIndex(): RouterIndex {
	bundledRouter ??= buildRouterIndex([...SKILLS].map(([name, text]) => ({ name, text })));
	return bundledRouter;
}

/**
 * The best skills for a task, best first; empty when none fits. `bundledOnly` (remote
 * sessions) leaves out the user's local skills and edits, which stay on their devices (D6).
 */
export function matchTask(task: string, top = 3, bundledOnly = false): SkillMatch[] {
	return matchSkills(bundledOnly ? bundledIndex() : routerIndex(), task, top);
}

/**
 * The SKILL.md text in use for `name`: the applied local copy, or the bundled skill. With
 * `bundledOnly` (remote sessions) it is always the bundled text, and local-only skills don't exist.
 */
export function readSkill(name: string, bundledOnly = false): string {
	assertName(name);
	if (bundledOnly) {
		const text = SKILLS.get(name);
		if (text === undefined) throw new SkillError(`No bundled skill named ${name}. Call skill_match.`);
		return text;
	}
	if (!allNames().includes(name)) throw new SkillError(`No skill named ${name}. Call skill_match, or run tabkyra skill list.`);
	return skillText(name);
}

// --- Versions and rollback ---------------------------------------------------------------
//
// A version is the first 12 hex digits of the SHA-256 of a SKILL.md, so the same text has
// the same version wherever it is: bundled, applied locally, or kept in skill-history.

export function skillVersion(text: string): string {
	return sha256(text).slice(0, 12);
}

export interface SkillVersion {
	version: string;
	source: "bundled" | "local" | "history";
	/** ISO time the history file was written. */
	at?: string;
	/** Why it was kept: "backup" (before an apply), "reverted" or "<harness>-replaced". */
	label?: string;
	file?: string;
	inUse: boolean;
}

const HISTORY_FILE = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)(?:\.([a-z0-9-]+))?\.md$/;

/** The ISO time a history stamp stands for (stamp() writes ":" and "." as "-"). */
function stampTime(stamp: string): string {
	return stamp.replace(/^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3}Z)$/, "$1:$2:$3.$4");
}

/** Every version of a skill: bundled, applied local copy, and each file in skill-history, oldest first. */
export function skillVersions(name: string): SkillVersion[] {
	assertName(name);
	const usable = localText(name).text;
	const out: SkillVersion[] = [];
	const bundled = SKILLS.get(name);
	if (bundled !== undefined) out.push({ version: skillVersion(bundled), source: "bundled", inUse: usable === undefined });
	if (usable !== undefined) out.push({ version: skillVersion(usable), source: "local", file: localFile(name), inUse: true });
	const dir = join(historyDir(), name);
	assertNoLinks([configDir(), historyDir(), dir]);
	if (existsSync(dir)) {
		for (const entry of readdirSync(dir).sort()) {
			const m = HISTORY_FILE.exec(entry);
			const file = join(dir, entry);
			if (!m || isLink(file) || !lstatSync(file).isFile()) continue;
			const version = skillVersion(readFileSync(file, "utf8"));
			out.push({ version, source: "history", at: stampTime(m[1]), label: m[2] ?? "backup", file, inUse: false });
		}
	}
	if (out.length === 0) throw new SkillError(`No skill named ${name}, and no history for it. Run tabkyra skill list.`);
	return out;
}

/**
 * Check a rollback to a version kept in skill-history, named by version (6 or more hex
 * digits) or by its time. The text goes through planApply, so a rollback meets every check
 * an edit does: lint, protected skills and protected sections.
 */
export function planRollback(name: string, to: string): { plan: ApplyPlan; from: SkillVersion } {
	const history = skillVersions(name).filter((v) => v.source === "history");
	const wanted = to.trim().toLowerCase();
	const hits = history.filter((v) => (/^[0-9a-f]{6,12}$/.test(wanted) && v.version.startsWith(wanted)) || v.at?.toLowerCase() === wanted || (v.file && basename(v.file).startsWith(`${to.trim()}.`)));
	const versions = new Set(hits.map((v) => v.version));
	if (versions.size === 0) {
		const known = history.map((v) => `${v.version} (${v.at})`).join(", ") || "none";
		throw new SkillError(`${name} has no version ${to} in its history. Versions in history: ${known}. Run tabkyra skill versions ${name}.`);
	}
	if (versions.size > 1) throw new SkillError(`${to} matches more than one version of ${name} (${[...versions].join(", ")}). Give more of the version.`);
	const from = hits[hits.length - 1];
	const work = mkdtempSync(join(tmpdir(), "tabkyra-rollback-"));
	try {
		const dir = join(work, name);
		mkdirSync(dir);
		writeFileSync(join(dir, "SKILL.md"), readFileSync(from.file ?? "", "utf8"));
		return { plan: planApply(dir), from };
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

// --- Editor ------------------------------------------------------------------------------

function draftsDir(): string {
	return join(configDir(), "skill-drafts");
}

/**
 * The draft folder for `name`, holding the exact source in use. The version a draft was
 * taken from is kept in skill-drafts/.bases/<name>, outside the skill folder. A draft that
 * differs from the current source is resumed only when it was taken from that source; a
 * draft taken from an older version (an apply or rollback has happened since) would drop
 * those changes, so it is moved to skill-drafts/.backups/<name>/ and a fresh draft started.
 */
export function prepareDraft(name: string, options: { keepExisting?: boolean } = {}): { dir: string; file: string; resumed: boolean; stale?: string; held?: boolean } {
	assertName(name);
	if (PROTECTED_SKILLS.has(name)) throw new SkillError(`The ${name} skill governs skill edits, so it changes only through a reviewed pull request.`);
	const source = readSkill(name);
	const root = resolve(draftsDir());
	const dir = resolve(root, name);
	if (relative(root, dir) !== name) throw new SkillError(`${name} resolves outside ${root}.`);
	const file = join(dir, "SKILL.md");
	const basesDir = join(root, ".bases");
	const baseFile = join(basesDir, name);
	const backupsDir = join(root, ".backups", name);
	assertNoLinks([configDir(), draftsDir(), dir, file, basesDir, baseFile, join(root, ".backups"), backupsDir]);
	if (existsSync(file) && !lstatSync(file).isFile()) throw new SkillError(`${file} is not a file.`);
	const current = skillVersion(source);
	let stale: string | undefined;
	if (existsSync(file)) {
		const draft = readFileSync(file, "utf8");
		const base = existsSync(baseFile) ? readFileSync(baseFile, "utf8").trim() : undefined;
		// Changed by someone: the draft differs from the version it was taken from (or, with no
		// record of that, from the current source). An untouched draft holds nothing to keep.
		const changed = base === undefined ? draft !== source : skillVersion(draft) !== base;
		// keepExisting (--draft-only, for agents): a draft with unapplied changes is the user's
		// work. Leave it exactly as it is, and let the caller stop and ask.
		if (options.keepExisting && changed) return { dir, file, resumed: false, held: true };
		if (draft !== source && base === current) return { dir, file, resumed: true };
		// Anything the user typed is moved aside, never replaced; an untouched draft is refreshed.
		if (changed) {
			mkdirSync(backupsDir, { recursive: true });
			stale = join(backupsDir, `${stamp()}.md`);
			renameSync(file, stale);
		}
	}
	mkdirSync(dir, { recursive: true });
	mkdirSync(basesDir, { recursive: true });
	writeFileSync(file, source);
	writeFileSync(baseFile, `${current}\n`);
	return { dir, file, resumed: false, stale };
}

/** Open `file` in the user's editor; the editor string may carry arguments ("code --wait"). */
function openEditor(editor: string, file: string): number {
	const r =
		process.platform === "win32"
			? spawnSync(`${editor} "${file}"`, { stdio: "inherit", shell: true })
			: spawnSync("/bin/sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
	return r.status ?? 1;
}

/** One line from the terminal, read synchronously. */
function askLine(question: string): string {
	process.stdout.write(question);
	const buf = Buffer.alloc(1);
	let line = "";
	for (;;) {
		let n = 0;
		try {
			n = readSync(0, buf, 0, 1, null);
		} catch {
			break;
		}
		if (n === 0 || buf[0] === 10) break;
		line += String.fromCharCode(buf[0]);
	}
	return line.trim();
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

export interface SkillFlags {
	force: boolean;
	all: boolean;
	raw?: boolean;
	yes?: boolean;
	json?: boolean;
	updateBaseline?: boolean;
	draftOnly?: boolean;
	/** Values of --top, --to, --cases, --base and --router. */
	top?: string;
	to?: string;
	cases?: string;
	base?: string;
	router?: string;
}

export function runSkill(sub: string | undefined, args: string[], flags: SkillFlags): number {
	try {
		return runSkillCommand(sub, args, flags);
	} catch (err) {
		if (!(err instanceof SkillError) && !(err instanceof EvalError)) throw err;
		console.error(`${sym.fail} ${err.message}`);
		return 1;
	}
}

/** Print the outcome of an apply, the way `skill apply --yes` does. */
function reportApplied(plan: ApplyPlan, what: string): number {
	const { backup, results } = applySkill(plan);
	console.log(`${sym.ok} ${what}${backup ? ` Backup: ${backup}` : ""}`);
	printInstall(results);
	console.log(`${sym.arrow} Undo: tabkyra skill revert ${plan.name}`);
	return results.some((r) => r.state === "kept" || r.state === "linked") ? 1 : 0;
}

/** skills-eval/router-cases.jsonl in this folder or the nearest one above it. */
function findCases(start: string): string | undefined {
	for (let dir = resolve(start); ; dir = dirname(dir)) {
		const file = join(dir, "skills-eval", "router-cases.jsonl");
		if (existsSync(file)) return file;
		if (dirname(dir) === dir) return undefined;
	}
}

function readIfExists(file: string): string | undefined {
	return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

function runEvalCommand(flags: SkillFlags): number {
	const casesFile = flags.cases ? resolve(flags.cases) : findCases(process.cwd());
	if (!casesFile || !existsSync(casesFile)) throw new SkillError("No skills-eval/router-cases.jsonl here or above. Run this in a Tabkyra checkout, or pass --cases <file>.");
	const dir = dirname(casesFile);
	const baselineFile = join(dir, "baseline.json");
	const heldoutText = readIfExists(join(dir, "router-heldout.jsonl"));
	const skills = [...SKILLS].map(([name, text]) => ({ name, text }));
	// --router: a router built as its own script (cli/src/router-worker.ts), run in a child process.
	if (flags.router && !existsSync(resolve(flags.router))) throw new SkillError(`No router script at ${flags.router}.`);
	const ranker = flags.router ? processRanker(resolve(flags.router)) : undefined;
	if (flags.base) return runBaseCommand(flags, skills, casesFile, heldoutText, ranker);
	const cases = parseCases(readFileSync(casesFile, "utf8"));
	const heldout = heldoutText === undefined ? undefined : parseCases(heldoutText, "router-heldout.jsonl");
	// Each accepted drop is that skill's floor, with no tolerance (the last entry for a skill wins).
	const floors = new Map(parseDrops(readIfExists(join(dir, "accepted-drops.json"))).map((d) => [d.skill, d.value]));
	let baseline = existsSync(baselineFile) ? parseBaseline(readFileSync(baselineFile, "utf8")) : undefined;
	if (flags.updateBaseline) {
		writeFileSync(baselineFile, formatBaseline(runEval(skills, cases, undefined, undefined, { ranker })));
		baseline = parseBaseline(readFileSync(baselineFile, "utf8"));
	}
	const report = runEval(skills, cases, baseline, heldout, { floors, ranker });
	if (flags.json) {
		console.log(JSON.stringify(report, null, "\t"));
		return report.ok ? 0 : 1;
	}
	const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
	console.log(`${c.bold("Skill router")} ${report.skills} skills, ${report.cases} cases (${report.positives} positive, ${report.negatives} none) ${c.dim(casesFile)}`);
	for (const [name, s] of Object.entries(report.perSkill)) {
		const base = s.baseline === undefined ? "" : c.dim(` baseline ${pct(s.baseline)}`);
		console.log(`  ${name.padEnd(20)} ${pct(s.accuracy).padStart(6)}  ${String(s.correct).padStart(3)}/${s.cases}${base}`);
	}
	for (const m of report.misses) console.log(`  ${sym.dot} ${c.dim(`expected ${m.expected}, got ${m.got}:`)} ${m.task}`);
	if (report.heldout) {
		console.log(`${c.bold("Held-out")} ${report.heldout.cases} cases the scorer was never tuned on: top-1 ${pct(report.heldout.top1)}, false invokes ${pct(report.heldout.falseInvoke)}`);
		for (const m of report.heldout.misses) console.log(`  ${sym.dot} ${c.dim(`expected ${m.expected}, got ${m.got}:`)} ${m.task}`);
	}
	for (const k of report.skipped) console.log(`  ${sym.warn} line ${k.line}: no bundled skill named ${k.skill}; skipped`);
	for (const g of report.gates) console.log(`${g.ok ? sym.ok : sym.fail} ${g.gate.padEnd(16)} ${g.detail}`);
	if (flags.updateBaseline) console.log(`${sym.arrow} Wrote ${baselineFile}. Commit it with the change that moved the numbers.`);
	return report.ok ? 0 : 1;
}

/**
 * `skill eval --base <checkout>`: run by the base branch's build, with the pull request's
 * skills bundled, from the pull request's checkout. The pull request's eval source sits at
 * cli/src/skill-eval.ts beside its skills-eval folder.
 */
function runBaseCommand(flags: SkillFlags, skills: RouterSkill[], casesFile: string, heldoutText: string | undefined, ranker?: Ranker): number {
	const baseDir = join(resolve(flags.base ?? ""), "skills-eval");
	if (!existsSync(baseDir)) throw new SkillError(`No skills-eval folder in ${flags.base}.`);
	const headRoot = dirname(dirname(casesFile));
	const headDir = dirname(casesFile);
	const { ok, skills: indexed, gates } = runBaseCheck(
		skills,
		{
			cases: readFileSync(casesFile, "utf8"),
			heldout: heldoutText,
			baseline: readIfExists(join(headDir, "baseline.json")),
			drops: readIfExists(join(headDir, "accepted-drops.json")),
			evalSource: readIfExists(join(headRoot, "cli", "src", "skill-eval.ts")),
		},
		{
			cases: readIfExists(join(baseDir, "router-cases.jsonl")),
			heldout: readIfExists(join(baseDir, "router-heldout.jsonl")),
			baseline: readIfExists(join(baseDir, "baseline.json")),
			drops: readIfExists(join(baseDir, "accepted-drops.json")),
		},
		ranker,
	);
	if (flags.json) console.log(JSON.stringify({ ok, skills: indexed, gates }, null, "\t"));
	else {
		console.log(`${c.bold("Base check")} ${indexed} skills indexed`);
		for (const g of gates) console.log(`${g.ok ? sym.ok : sym.fail} ${g.gate.padEnd(16)} ${g.detail}`);
	}
	return ok ? 0 : 1;
}

function runSkillCommand(sub: string | undefined, args: string[], flags: SkillFlags): number {
	if (sub === "match") {
		const task = args.join(" ").trim();
		if (!task) throw new SkillError('Usage: tabkyra skill match "<task>" [--json] [--top N]');
		const top = flags.top === undefined ? 3 : Number(flags.top);
		if (!Number.isInteger(top) || top < 1 || top > 20) throw new SkillError("--top takes a whole number from 1 to 20.");
		const matches = matchTask(task, top);
		if (flags.json) console.log(JSON.stringify(matches.length ? matches : [{ name: "none", score: 0, description: "No skill fits this task." }]));
		else if (matches.length === 0) console.log(`${sym.dot} none: no skill fits this task.`);
		else for (const m of matches) console.log(`${c.bold(m.name.padEnd(20))} ${String(m.score).padStart(6)}  ${m.description}`);
		return 0;
	}
	if (sub === "eval") return runEvalCommand(flags);
	if (sub === "versions") {
		if (args.length !== 1) throw new SkillError("Usage: tabkyra skill versions <name> [--json]");
		const versions = skillVersions(args[0]);
		if (flags.json) {
			console.log(JSON.stringify(versions));
			return 0;
		}
		for (const v of versions) {
			const where = v.source === "history" ? `history  ${v.at} ${c.dim(`${v.label} ${v.file}`)}` : v.source === "local" ? `local    ${c.dim(v.file ?? "")}` : "bundled";
			console.log(`${v.inUse ? sym.ok : sym.dot} ${c.bold(v.version)}  ${where}${v.inUse ? " (in use)" : ""}`);
		}
		if (versions.some((v) => v.source === "history")) console.log(`${sym.arrow} Restore one: tabkyra skill rollback ${args[0]} --to <version>`);
		return 0;
	}
	if (sub === "rollback") {
		if (args.length !== 1 || !flags.to) throw new SkillError("Usage: tabkyra skill rollback <name> --to <version|time> [--yes]");
		const { plan, from } = planRollback(args[0], flags.to);
		if (plan.current === plan.text) {
			console.log(`${sym.ok} ${plan.name} is already at version ${from.version}.`);
			return 0;
		}
		console.log(`${c.bold(`Roll ${plan.name} back to ${from.version} (${from.at}):`)}\n${plan.diff}\n`);
		// The bundled text isn't kept as a local copy: that would pin it and stop updates.
		const toBundled = plan.text === SKILLS.get(plan.name);
		if (!flags.yes) {
			console.log(
				toBundled
					? `${sym.arrow} That is the bundled version, so --yes removes your local edit (as tabkyra skill revert ${plan.name} does) and updates reach you again. Nothing changed yet.`
					: `${sym.arrow} Lint passed. Nothing changed yet. Show this to the user; run again with --yes once they approve.`,
			);
			return 3;
		}
		if (toBundled) {
			const { results } = revertSkill(plan.name);
			console.log(`${sym.ok} Rolled ${plan.name} back to the bundled version ${from.version}; your edit is kept in ${join(historyDir(), plan.name)}.`);
			printInstall(results);
			return 0;
		}
		return reportApplied(plan, `Rolled ${plan.name} back to ${from.version}.`);
	}
	if (sub === "edit") {
		if (args.length !== 1) throw new SkillError("Usage: tabkyra skill edit <name> [--yes] [--draft-only]");
		const { dir, file, resumed, stale, held } = prepareDraft(args[0], { keepExisting: flags.draftOnly });
		if (held) {
			console.log(`${sym.fail} ${file} holds unapplied changes to ${args[0]}. It was left as it is. Don't overwrite or delete it: ask the user whether to finish and apply it, or to discard it themselves.`);
			return 1;
		}
		const name = basename(dir);
		const source = readSkill(name);
		const editor = process.env.VISUAL || process.env.EDITOR;
		const later = `tabkyra skill apply ${dir}`;
		if (stale) console.log(`${sym.warn} Your earlier draft was taken from an older version of ${name}, so it would undo changes made since. It is kept at ${stale}; starting a fresh draft.`);
		console.log(`${sym.ok} ${resumed ? "Your earlier draft" : "Draft"} of ${name}: ${file}`);
		// --draft-only: for agents, whose shell may be a terminal with the user's $EDITOR.
		if (flags.draftOnly || !process.stdin.isTTY || !process.stdout.isTTY || !editor) {
			if (!flags.draftOnly && process.stdin.isTTY && !editor) console.log(`${sym.dot} Set $VISUAL or $EDITOR to open it from here.`);
			console.log(`${sym.arrow} Edit it, then check it with: ${c.bold(later)} (add --yes to apply)`);
			return 0;
		}
		const status = openEditor(editor, file);
		if (status !== 0) {
			console.log(`${sym.fail} The editor exited with ${status}. Nothing applied; the draft is kept at ${file}.`);
			return 1;
		}
		if (readFileSync(file, "utf8") === source) {
			console.log(`${sym.dot} No changes.`);
			return 0;
		}
		// Another apply, revert or rollback while the editor was open would be undone by this one.
		const changedUnderneath = () => {
			if (readSkill(name) === source) return false;
			console.log(
				`${sym.fail} ${name} changed while you were editing (now version ${skillVersion(readSkill(name))}, you started from ${skillVersion(source)}). Nothing applied, so that change isn't undone. Your draft is kept at ${file}; run tabkyra skill edit ${name} to start again from the new version (your draft moves to skill-drafts/.backups).`,
			);
			return true;
		};
		if (changedUnderneath()) return 1;
		const plan = planApply(dir);
		console.log(`${c.bold(`Change to ${plan.name}:`)}\n${plan.diff}\n`);
		if (!flags.yes && !/^y(es)?$/i.test(askLine("Apply? [y/N] "))) {
			console.log(`${sym.dot} Not applied. The draft is kept; apply it later with ${c.bold(later)} --yes`);
			return 3;
		}
		if (changedUnderneath()) return 1;
		return reportApplied(plan, `Applied your edit of ${plan.name}.`);
	}
	if (sub === "print") {
		const name = assertName(args[0] ?? "tabkyra");
		if (!allNames().includes(name)) throw new SkillError(`No skill named ${name}. Run tabkyra skill list.`);
		// --raw: the exact SKILL.md source in use, the starting point for an edit.
		process.stdout.write(flags.raw ? skillText(name) : agentsSnippet(name));
		return 0;
	}
	if (sub === "list") {
		const local = new Set(localNames().filter((n) => localText(n).text !== undefined));
		if (flags.json) {
			const list = allNames().map((name) => {
				const text = skillText(name);
				return { name, description: /^description: (.*)$/m.exec(text)?.[1] ?? "", version: skillVersion(text), source: local.has(name) ? "local" : "bundled" };
			});
			console.log(JSON.stringify(list));
			return 0;
		}
		for (const name of allNames()) {
			const description = /^description: (.*)$/m.exec(skillText(name))?.[1] ?? "";
			console.log(`${c.bold(name.padEnd(18))} ${oneLine(description)}${local.has(name) ? c.dim(" (your edit)") : ""}`);
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
		return reportApplied(plan, `Applied your edit of ${plan.name}.`);
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
