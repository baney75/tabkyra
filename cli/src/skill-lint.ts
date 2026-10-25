/**
 * `tabkyra skill lint`: the gate every skill passes before it ships, installs or gets
 * applied by the rsi loop. One rule set serves CI, the CLI and `tabkyra skill apply`.
 *
 * A skill is instructions a model will follow with the user's sign-in, so the checks treat
 * it as untrusted input. They look for hidden text (format characters, bidi overrides,
 * lookalike letters, HTML), instructions that override the user or the system, remote code,
 * instructions fetched at run time, secrets leaving the machine, writes to agent or shell
 * config, encoded blobs and links that hide where they go. They also enforce the structure
 * that lets a small model follow a skill: strict frontmatter, when to use it, numbered steps
 * and a stop condition.
 *
 * Every line is checked, fence lines and code blocks included: a model reads the raw file,
 * so a fence changes nothing about what it will follow. Lint is a gate, not a proof. A clean
 * result means none of these patterns matched; review still reads every line
 * (docs/skill-security.md).
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";

export type Severity = "error" | "warning";

export interface Finding {
	file: string;
	line: number;
	rule: string;
	severity: Severity;
	message: string;
}

/** The only frontmatter keys a skill may carry. Unknown keys are where harness-specific escalation hides. */
const FRONTMATTER_KEYS = ["name", "description", "license"];
const MAX_BYTES = 40_000;
const MAX_LINES = 500;
const MAX_DESCRIPTION = 1024;
/** Written by `tabkyra skill install`; the one HTML comment a skill may contain. */
const INSTALL_MARKER = "<!-- Installed by `tabkyra skill install`; reinstalling replaces this file. -->";

/**
 * A clause that starts with a direct prohibition ("Never print the password") is guidance,
 * not an attack. Only these words count, only at the start of the clause that holds the
 * match, and clauses end at punctuation and at "but", "then" and "and then".
 */
const DIRECTIVE_NEGATION = /^\s*(?:[-*>]\s+|\d+\.\s+)?(?:\*\*)?\s*(never|don't|do not|must not|mustn't|refuse to)\b/i;
const CLAUSE_BREAK = /[.;:!?,()]|\bbut\b|\bthen\b|\botherwise\b|\binstead\b|\bunless\b|\bif\b|\bwhen\b/gi;

interface PatternRule {
	rule: string;
	pattern: RegExp;
	message: string;
	/** A clause that starts with a direct prohibition of the act is allowed. */
	negatable: boolean;
}

const SHELLS = "(?:sh|bash|zsh|fish|dash|ksh|python3?|node|deno|bun|ruby|perl|php|iex|pwsh|powershell)";
const FETCHERS = "(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)";

const PATTERN_RULES: PatternRule[] = [
	{
		rule: "override-instructions",
		pattern:
			/\b(ignore|disregard|forget|override|bypass|drop)\b[^.\n]{0,30}\b(previous|prior|above|earlier|all|any|other|system|developer|user's|safety)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|messages?|guidelines?|policies)\b/i,
		message: "Tells the model to drop its other instructions.",
		negatable: false,
	},
	{
		rule: "role-hijack",
		pattern:
			/(^|\n)\s*(system|assistant|developer|user)\s*:|<\/?\s*(system|im_start|im_end|instructions?|user|assistant)\s*>|\byou are now\b|\bnew system prompt\b|\bdeveloper mode\b|\bjailbreak\b|\bDAN mode\b/i,
		message: "Impersonates a system, developer or user turn, or tries to reassign the model's role.",
		negatable: false,
	},
	{
		rule: "conceal-from-user",
		pattern:
			/\b(without (telling|asking|informing|notifying|showing) (the )?user|without asking\b|(don't|do not|never) (tell|mention|show|inform|notify|reveal)\b[^.\n]{0,20}\buser\b|hide (this|it|that)\b[^.\n]{0,20}\buser|secretly|covertly|quietly|silently)\b/i,
		message: "Asks the model to act without the user knowing.",
		negatable: false,
	},
	{
		rule: "remote-code",
		pattern: new RegExp(
			[
				`\\b${FETCHERS}\\b[^|\\n]*\\|\\s*(sudo\\s+)?(-?\\w+\\s+)?${SHELLS}\\b`,
				`\\b${SHELLS}\\b[^\\n]*\\$\\(\\s*${FETCHERS}\\b`,
				`<\\(\\s*${FETCHERS}\\b`,
				`\\beval\\b[^\\n]*${FETCHERS}\\b`,
				`\\biex\\b[^\\n]*\\(\\s*(irm|iwr|invoke-webrequest|invoke-restmethod|new-object)\\b`,
				`\\bbase64\\s+(-d|--decode|-D)\\b[^|\\n]*\\|\\s*${SHELLS}\\b`,
				`\\b(npx|pnpx|bunx|uvx|pipx run)\\s+(-y\\s+)?[\\w@/.-]+@latest\\b`,
			].join("|"),
			"i",
		),
		message: "Runs downloaded or decoded code, or an unpinned package, straight from the network.",
		negatable: true,
	},
	{
		rule: "remote-instructions",
		pattern:
			/\b(follow|obey|execute|apply|load|adopt|read and do|do what)\b[^.\n]{0,25}\b(instructions?|steps|commands|rules|prompt|says)\b[^.\n]{0,25}\b(from|at|in|on)\b[^.\n]{0,15}(https?:\/\/|the (url|page|link|site|website|gist|pastebin|issue|comment))/i,
		message: "Pulls instructions from the web at run time, where nobody reviewed them.",
		negatable: true,
	},
	{
		rule: "secret-exfiltration",
		pattern:
			/\b(print|echo|cat|log|send|post|paste|upload|share|reveal|show|display|copy|email|include|return|output|type|write|save|store|forward|tell)\b[^.\n]{0,40}\b(passwords?|passphrases?|api[ _-]?keys?|access tokens?|bearer tokens?|auth tokens?|secrets?|private keys?|seed phrases?|recovery phrases?|mnemonic|credentials|session cookies?|cookies|card numbers?|cvv|cvc|2fa codes?|otp codes?|one-time codes?)\b/i,
		message: "Moves a secret into the model's output, a file or off the machine.",
		negatable: true,
	},
	{
		rule: "credential-files",
		pattern:
			/(~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+|%USERPROFILE%)[/\\]\.(ssh|aws|gnupg|netrc|docker[/\\]config\.json|kube[/\\]config|config[/\\]gh[/\\]hosts\.yml|password-store|git-credentials)|\bid_(rsa|ed25519|ecdsa|dsa)\b|\bLogin Data\b|\bCookies\.binarycookies\b|\bkey4\.db\b|\blogins\.json\b|\bfind-(generic|internet)-password\b[^\n]*-w\b|\bauth\.json\b|\bcredentials\.json\b|(^|[\s/"'`=])\.env(\.local|\.production|\.development)?(?![\w.-])/i,
		message: "Reads a credential store or key file directly.",
		negatable: true,
	},
	{
		rule: "config-tamper",
		pattern:
			/(\.claude[/\\]settings(\.local)?\.json|\.claude\.json\b|\.codex[/\\]config\.toml|\bmcp\.json\b|\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.profile\b|\bcrontab\b|LaunchAgents|LaunchDaemons|systemctl\s+(--user\s+)?enable|\bgit config --global\b|\bhooks?\.json\b)/i,
		message: "Changes agent, shell or startup config, which outlives the task.",
		negatable: true,
	},
	{
		rule: "safety-bypass",
		pattern:
			/(--dangerously[\w-]*|--no-verify\b|--ignore-certificate-errors|\bbypass ?permissions\b|\btabkyra (allow-all|yolo)\b|\bdisable (the )?(sandbox|safety|guard|guardrails?|confirmation|prompts?|lint)\b|\bskip (all |the )?(confirmation|approval|review|lint)s?\b|--yolo\b|--no-sandbox\b|\bchmod\s+777\b)/i,
		message: "Turns off a permission prompt, sandbox, review or safety check.",
		negatable: true,
	},
];

/** Characters that render as nothing or reorder text: hidden instructions live here. */
const INVISIBLE = /[\p{Cf}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u2028\u2029\u00AD\u115F\u1160\u3164\uFFA0]/u;
/** A word mixing Latin with Cyrillic or Greek letters: a lookalike that dodges review and filters. */
const MIXED_SCRIPT = /(?=[\p{L}]*\p{Script=Latin})(?=[\p{L}]*[\p{Script=Cyrillic}\p{Script=Greek}])[\p{L}]{2,}/u;
const BLOB = /[A-Za-z0-9+/_-]{100,}={0,2}/;
const URL_RE = /\b(?:https?|ftp|data|javascript|file|vbscript):[^\s)>\]"'`]*/gi;
const SHORTENERS = /^(bit\.ly|t\.co|tinyurl\.com|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|rb\.gy|t\.ly|s\.id|tiny\.cc|lnkd\.in)$/i;
/** A fence line: the marker and at most one info word, nothing else. */
const FENCE = /^\s*(```+|~~~+)/;
const CLEAN_FENCE = /^\s*(```+|~~~+)\s*[\w-]*\s*$/;
/** An HTML tag (not an autolink like <https://...>, which has a colon after the name). */
const HTML_TAG = /<\s*\/?\s*[a-z][\w-]*(\s|>|\/>)/i;

function findingsForUrl(raw: string): string | undefined {
	const url = raw.replace(/[.,;:]+$/, "");
	if (/^(data|javascript|file|vbscript):/i.test(url)) return `${url.split(":")[0]}: URL`;
	let parsed: URL;
	try {
		parsed = new globalThis.URL(url);
	} catch {
		return undefined;
	}
	const host = parsed.hostname;
	const local =
		host === "localhost" ||
		host === "127.0.0.1" ||
		host.endsWith(".localhost") ||
		host.endsWith(".example") ||
		/^example\.(com|org|net)$/.test(host) ||
		host.endsWith(".example.com");
	if (parsed.protocol === "http:" && !local) return "plain http (use https)";
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !local) return "a raw IP address";
	if (host.startsWith("[")) return "a raw IP address";
	if (host.includes("xn--")) return "a punycode host";
	if (SHORTENERS.test(host)) return "a link shortener, which hides the destination";
	if (parsed.username || parsed.password) return "credentials in the URL";
	return undefined;
}

/** Inline code spans render as literal text, so tags inside them don't hide anything. */
function withoutInlineCode(line: string): string {
	return line.replace(/`[^`]*`/g, "``");
}

/** Start of the clause that holds `index`, after the last clause break before it. */
function clauseBefore(text: string, index: number): string {
	const head = text.slice(0, index);
	let start = 0;
	for (const m of head.matchAll(CLAUSE_BREAK)) start = (m.index ?? 0) + m[0].length;
	return head.slice(start);
}

/** True when every match of the rule on this line sits in a clause that starts by forbidding it. */
function everyMatchNegated(line: string, pattern: RegExp): boolean {
	const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
	let any = false;
	for (const m of line.matchAll(global)) {
		any = true;
		if (!DIRECTIVE_NEGATION.test(clauseBefore(line, m.index ?? 0))) return false;
	}
	return any;
}

export interface SkillMeta {
	name?: string;
	description?: string;
	bodyStart: number;
	problems: Array<{ line: number; message: string }>;
}

/**
 * Frontmatter is parsed strictly: each line is exactly `key: value` for an allowed key, once.
 * Quoted keys, indentation, flow or block syntax and duplicates are refused, because a
 * harness's YAML parser would accept keys a looser check here would miss.
 */
export function parseFrontmatter(text: string): SkillMeta | undefined {
	if (!text.startsWith("---\n")) return undefined;
	const end = text.indexOf("\n---\n", 4);
	if (end < 0) return undefined;
	const meta: SkillMeta = { bodyStart: end + 5, problems: [] };
	const seen = new Set<string>();
	text
		.slice(4, end)
		.split("\n")
		.forEach((line, i) => {
			const n = i + 2;
			if (line.trim() === "") return;
			const m = /^([a-z]+): (\S.*)$/.exec(line);
			if (!m || !FRONTMATTER_KEYS.includes(m[1])) {
				meta.problems.push({ line: n, message: `Frontmatter line must be "key: value" with a key from ${FRONTMATTER_KEYS.join(", ")}: ${JSON.stringify(line.slice(0, 60))}` });
				return;
			}
			if (seen.has(m[1])) meta.problems.push({ line: n, message: `Duplicate frontmatter key "${m[1]}".` });
			seen.add(m[1]);
			if (/^["'[{|>&*!]/.test(m[2])) meta.problems.push({ line: n, message: `Write ${m[1]} as plain text, without YAML quotes or syntax.` });
			if (m[1] === "name") meta.name = m[2].trim();
			if (m[1] === "description") meta.description = m[2].trim();
		});
	return meta;
}

/** Lint one SKILL.md (or a reference .md beside it, with `reference: true`). */
export function lintText(file: string, text: string, options: { reference?: boolean; dirName?: string } = {}): Finding[] {
	const findings: Finding[] = [];
	const add = (line: number, rule: string, message: string, severity: Severity = "error") => findings.push({ file, line, rule, severity, message });

	if (Buffer.byteLength(text) > MAX_BYTES) add(1, "size", `Over ${MAX_BYTES} bytes. Move detail into references/*.md.`);
	const lines = text.split("\n");
	if (lines.length > MAX_LINES) add(MAX_LINES, "size", `Over ${MAX_LINES} lines. Move detail into references/*.md.`);
	if (text.includes("\r")) add(1, "hidden-text", "Carriage returns can hide text in some viewers. Use \\n line endings.");

	if (!options.reference) {
		const meta = parseFrontmatter(text);
		if (!meta) add(1, "frontmatter", "Must start with --- frontmatter holding name and description.");
		else {
			for (const p of meta.problems) add(p.line, "frontmatter", p.message);
			if (!meta.name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.name) || meta.name.length > 64) add(2, "frontmatter", "name must be lowercase-kebab-case, 64 characters or fewer.");
			else if (options.dirName && meta.name !== options.dirName) add(2, "frontmatter", `name "${meta.name}" must match its folder "${options.dirName}".`);
			if (!meta.description) add(3, "frontmatter", "description is missing.");
			else {
				if (meta.description.length > MAX_DESCRIPTION) add(3, "frontmatter", `description is over ${MAX_DESCRIPTION} characters.`);
				if (!/\bUse when\b/.test(meta.description)) add(3, "frontmatter", 'description must say when to use the skill ("Use when ...") so harnesses invoke it at the right time.');
			}
			const body = text.slice(meta.bodyStart);
			if (!/^## When to use/m.test(body)) add(1, "structure", 'Needs a "## When to use" section.');
			if (!/^## (Steps|Step 1)/m.test(body) || !/^1\. /m.test(body)) add(1, "structure", 'Needs a "## Steps" section with numbered steps a small model can follow in order.');
			if (!/^## Done when/m.test(body)) add(1, "structure", 'Needs a "## Done when" section so the model knows when to stop.');
		}
	}

	let inFence = false;
	lines.forEach((line, i) => {
		const n = i + 1;
		if (FENCE.test(line)) {
			if (!CLEAN_FENCE.test(line)) add(n, "structure", "A fence line holds only the fence and one info word. Put text on its own line.");
			inFence = !inFence;
		}

		if (INVISIBLE.test(line)) add(n, "hidden-text", "Contains an invisible or text-reordering character.");
		if (MIXED_SCRIPT.test(line)) add(n, "hidden-text", "A word mixes Latin with Cyrillic or Greek lookalike letters.");
		// Outside a fence, markup renders: it can hide text from a reviewer or load content.
		if (!inFence && !FENCE.test(line)) {
			const visible = withoutInlineCode(line);
			if (/<!--/.test(visible) && line.trim() !== INSTALL_MARKER) add(n, "hidden-text", "HTML comments don't render, so reviewers miss them. Write it as visible text.");
			else if (HTML_TAG.test(visible)) add(n, "hidden-text", "Raw HTML can hide text or load content. Write Markdown, or put markup in a code fence.");
		}
		if (BLOB.test(line)) add(n, "encoded-blob", "A long encoded string can carry hidden instructions. Link to a reviewed file instead.");
		if (/!\[[^\]]*\]\s*\((?!\s*(\.{0,2}\/)?[\w-]+(\/[\w.-]+)*\.(png|jpe?g|gif|svg|webp)\s*\))/i.test(line) || /!\[[^\]]*\]\s*\[/.test(line)) {
			add(n, "remote-image", "Images must be relative paths to files in the skill. A remote image loads on render and can leak data in its URL.");
		}

		for (const url of line.matchAll(URL_RE)) {
			const problem = findingsForUrl(url[0]);
			if (problem) add(n, "suspicious-link", `Link uses ${problem}: ${url[0]}`);
		}
		if (/(^|[\s("'<[])\/\/[a-z0-9-]+\.[a-z]/i.test(line)) add(n, "suspicious-link", "Protocol-relative links (//host) hide which protocol loads. Use the full https URL.");

		for (const r of PATTERN_RULES) {
			if (!r.pattern.test(line)) continue;
			if (r.negatable && everyMatchNegated(line, r.pattern)) continue;
			add(n, r.rule, r.message);
		}
	});
	if (inFence) add(lines.length, "structure", "A code fence is never closed.");
	return findings;
}

/** Files a skill folder may hold. Scripts need a code review path of their own, so they're refused here. */
const ALLOWED_FILES = /^(SKILL\.md|references\/[\w.-]+\.md|LICENSE(\.md|\.txt)?)$/;

function symlinkFinding(file: string): Finding {
	return { file, line: 0, rule: "file-type", severity: "error", message: "Symbolic links are refused: they let a file outside review change the skill." };
}

/** Lint a skill folder, a SKILL.md, or a folder of skill folders. Never follows a symlink. */
export function lintPath(path: string): Finding[] {
	if (!existsSync(path) && !isLink(path)) return [{ file: path, line: 0, rule: "missing", severity: "error", message: "No such file or folder." }];
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) return [symlinkFinding(path)];
	if (stat.isFile()) {
		const reference = basename(path) !== "SKILL.md";
		return lintText(path, readFileSync(path, "utf8"), { reference, dirName: reference ? undefined : basename(dirname(path)) });
	}
	if (existsSync(join(path, "SKILL.md")) || isLink(join(path, "SKILL.md"))) return lintSkillDir(path);
	const findings: Finding[] = [];
	for (const entry of readdirSync(path).sort()) {
		const sub = join(path, entry);
		const s = lstatSync(sub);
		if (s.isSymbolicLink()) findings.push(symlinkFinding(sub));
		else if (s.isDirectory()) {
			findings.push(
				...(existsSync(join(sub, "SKILL.md")) || isLink(join(sub, "SKILL.md"))
					? lintSkillDir(sub)
					: [{ file: sub, line: 0, rule: "structure", severity: "error" as const, message: "Folder has no SKILL.md." }]),
			);
		}
	}
	return findings;
}

function isLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Every entry under `dir`, relative and with / separators; symlinks are listed, never followed. */
function walk(dir: string, root = dir): Array<{ rel: string; link: boolean }> {
	return readdirSync(dir).flatMap((entry) => {
		const p = join(dir, entry);
		const s = lstatSync(p);
		const rel = relative(root, p).split(sep).join("/");
		if (s.isSymbolicLink()) return [{ rel, link: true }];
		return s.isDirectory() ? walk(p, root) : [{ rel, link: false }];
	});
}

function lintSkillDir(dir: string): Finding[] {
	const findings: Finding[] = [];
	for (const { rel, link } of walk(dir).sort((a, b) => a.rel.localeCompare(b.rel))) {
		const file = join(dir, rel);
		if (link) {
			findings.push(symlinkFinding(file));
			continue;
		}
		if (!ALLOWED_FILES.test(rel)) {
			findings.push({ file, line: 0, rule: "file-type", severity: "error", message: "Skill folders hold SKILL.md, references/*.md and a LICENSE only." });
			continue;
		}
		if (extname(rel) !== ".md") continue;
		findings.push(...lintText(file, readFileSync(file, "utf8"), { reference: rel !== "SKILL.md", dirName: basename(dir) }));
	}
	return findings;
}

export function formatFindings(findings: Finding[]): string {
	return findings.map((f) => `${f.file}:${f.line}  ${f.severity}  ${f.rule}  ${f.message}`).join("\n");
}
