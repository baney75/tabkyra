/**
 * `tabkyra skill lint`: the gate every skill passes before it ships, installs or gets
 * proposed by an agent. One rule set serves CI, the CLI and the self-improvement loop.
 *
 * A skill is instructions a model will follow with the user's sign-in, so the checks treat
 * it as untrusted input. They look for hidden text (format characters, bidi overrides,
 * HTML comments), instructions that override the user or the system, remote code piped into
 * a shell, instructions fetched at run time, secrets leaving the machine, writes to agent
 * or shell config, encoded blobs and links that hide where they go. They also enforce the
 * structure that lets a small model follow a skill: frontmatter, when to use it, numbered
 * steps and a stop condition.
 *
 * Lint is a gate, not a proof. A clean result means none of these patterns matched; review
 * still reads every line (docs/skill-security.md).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

export type Severity = "error" | "warning";

export interface Finding {
	file: string;
	line: number;
	rule: string;
	severity: Severity;
	message: string;
}

/** The only frontmatter keys a skill may carry. Unknown keys are where harness-specific escalation hides. */
const FRONTMATTER_KEYS = new Set(["name", "description", "license"]);
const MAX_BYTES = 40_000;
const MAX_LINES = 500;
const MAX_DESCRIPTION = 1024;
/** Written by `tabkyra skill install`; the one HTML comment a skill may contain. */
const INSTALL_MARKER = "<!-- Installed by `tabkyra skill install`; reinstalling replaces this file. -->";

/** A line that forbids the thing it names ("Never print the password") is guidance, not an attack. */
const NEGATION = /\b(never|don't|do not|doesn't|does not|must not|mustn't|cannot|can't|won't|refuse|no one|nothing|not|without asking)\b/i;

interface PatternRule {
	rule: string;
	pattern: RegExp;
	message: string;
	/** Skip lines that negate the pattern, such as "never do X". */
	negatable: boolean;
	/** Also check inside ```untrusted fences, which exist to quote attacks. */
	inUntrusted: boolean;
}

const PATTERN_RULES: PatternRule[] = [
	{
		rule: "override-instructions",
		pattern:
			/\b(ignore|disregard|forget|override)\b[^.\n]{0,30}\b(previous|prior|above|earlier|all|any|system|developer|user's)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|messages?)\b/i,
		message: "Tells the model to drop its other instructions.",
		negatable: false,
		inUntrusted: false,
	},
	{
		rule: "role-hijack",
		pattern:
			/(^|\n)\s*(system|assistant|developer)\s*:|<\/?\s*(system|im_start|im_end|instructions?)\s*>|\byou are now\b|\bnew system prompt\b|\bdeveloper mode\b|\bjailbreak\b/i,
		message: "Impersonates a system or developer turn, or tries to reassign the model's role.",
		negatable: false,
		inUntrusted: false,
	},
	{
		rule: "conceal-from-user",
		pattern:
			/\b(without (telling|asking|informing|notifying) the user|don't (tell|mention|show|inform) (it to )?the user|do not (tell|mention|show|inform) the user|hide (this|it) from the user|secretly|silently (send|upload|post|delete|run|install))\b/i,
		message: "Asks the model to hide what it does from the user.",
		negatable: false,
		inUntrusted: false,
	},
	{
		rule: "remote-code",
		pattern:
			/\b(curl|wget|iwr|invoke-webrequest|fetch)\b[^|\n]*\|\s*(sudo\s+)?(sh|bash|zsh|fish|python3?|node|ruby|perl|iex|pwsh|powershell)\b|\beval\s*["'(]?\s*\$\((curl|wget)|\bbase64\s+(-d|--decode)\b[^|\n]*\|\s*(sh|bash|zsh|python3?|node)\b/i,
		message: "Pipes downloaded or decoded code straight into an interpreter.",
		negatable: true,
		inUntrusted: true,
	},
	{
		rule: "remote-instructions",
		pattern:
			/\b(follow|obey|execute|apply|load|adopt)\b[^.\n]{0,25}\b(instructions?|steps|commands|rules|prompt)\b[^.\n]{0,25}\b(from|at|in|on)\b[^.\n]{0,15}(https?:\/\/|the (url|page|link|site|website|gist|pastebin))/i,
		message: "Pulls instructions from the web at run time, where nobody reviewed them.",
		negatable: true,
		inUntrusted: false,
	},
	{
		rule: "secret-exfiltration",
		pattern:
			/\b(print|echo|cat|log|send|post|paste|upload|share|reveal|show|display|copy|email|include|return|output)\b[^.\n]{0,40}\b(passwords?|passphrases?|api[ _-]?keys?|access tokens?|bearer tokens?|secrets?|private keys?|seed phrases?|recovery phrases?|credentials|session cookies?|cookies|card numbers?|cvv|2fa codes?|otp codes?)\b/i,
		message: "Moves a secret into the model's output or off the machine.",
		negatable: true,
		inUntrusted: true,
	},
	{
		rule: "credential-files",
		pattern:
			/(~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.(ssh|aws|gnupg|netrc|docker\/config\.json|kube\/config|config\/gh\/hosts\.yml)|\bid_(rsa|ed25519|ecdsa)\b|\bLogin Data\b|\bCookies\.binarycookies\b|\bfind-(generic|internet)-password\b[^\n]*-w\b|\bauth\.json\b|(^|[\s/"'`=])\.env(\.local|\.production|\.development)?(?![\w.-])/i,
		message: "Reads a credential store or key file directly.",
		negatable: true,
		inUntrusted: true,
	},
	{
		rule: "config-tamper",
		pattern:
			/(\.claude\/settings(\.local)?\.json|\.codex\/config\.toml|\bmcp\.json\b|\.bashrc|\.zshrc|\.profile\b|\bcrontab\b|LaunchAgents|LaunchDaemons|systemctl\s+(--user\s+)?enable|\bgit config --global\b|\bhooks?\.json\b)/i,
		message: "Changes agent, shell or startup config, which outlives the task.",
		negatable: true,
		inUntrusted: true,
	},
	{
		rule: "safety-bypass",
		pattern:
			/(--dangerously[\w-]*|--no-verify\b|\bbypass ?permissions\b|\btabkyra (allow-all|yolo)\b|\bdisable (the )?(sandbox|safety|guard|guardrails?|confirmation|prompts?)\b|\bskip (all )?(confirmation|approval)s?\b|--yolo\b)/i,
		message: "Turns off a permission prompt, sandbox or safety check.",
		negatable: true,
		inUntrusted: true,
	},
];

/** Characters that render as nothing or reorder text: hidden instructions live here. */
const INVISIBLE = /[\p{Cf}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u2028\u2029]/u;
/** A word mixing Latin with Cyrillic or Greek letters: a lookalike that dodges review and filters. */
const MIXED_SCRIPT = /(?=[\p{L}]*\p{Script=Latin})(?=[\p{L}]*[\p{Script=Cyrillic}\p{Script=Greek}])[\p{L}]{2,}/u;
const BLOB = /[A-Za-z0-9+/_-]{100,}={0,2}/;
const URL = /\b(?:https?|ftp|data|javascript|file):[^\s)>\]"'`]*/gi;
const SHORTENERS = /^(bit\.ly|t\.co|tinyurl\.com|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|rb\.gy|t\.ly|s\.id)$/i;

function findingsForUrl(raw: string): string | undefined {
	const url = raw.replace(/[.,;:]+$/, "");
	if (/^(data|javascript|file):/i.test(url)) return `${url.split(":")[0]}: URL`;
	let parsed: URL;
	try {
		parsed = new globalThis.URL(url);
	} catch {
		return undefined;
	}
	const host = parsed.hostname;
	const local = host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost") || host.endsWith(".example") || /^example\.(com|org|net)$/.test(host) || host.endsWith(".example.com");
	if (parsed.protocol === "http:" && !local) return "plain http (use https)";
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !local) return "a raw IP address";
	if (host.includes("xn--")) return "a punycode host";
	if (SHORTENERS.test(host)) return "a link shortener, which hides the destination";
	if (parsed.username || parsed.password) return "credentials in the URL";
	return undefined;
}

/**
 * The line plus the wrapped lines before it in the same list item or paragraph, so a
 * "Never ..." that starts on the previous line still counts for a negatable rule.
 */
function sentenceContext(lines: string[], i: number): string {
	const parts = [lines[i]];
	for (let j = i; j > 0 && i - j < 3; j--) {
		const current = lines[j];
		if (/^\s*([-*|#>]|\d+\.)\s/.test(current) || current.trim() === "") break;
		const prev = lines[j - 1];
		if (prev.trim() === "" || /^\s*[|#]/.test(prev)) break;
		parts.unshift(prev);
		if (/^\s*([-*>]|\d+\.)\s/.test(prev)) break;
	}
	return parts.join(" ");
}

/** The prohibition must come before the act it forbids: "Never print X", not "Print X, never mind". */
function negatedBeforeMatch(context: string, pattern: RegExp): boolean {
	const m = pattern.exec(context);
	if (!m) return false;
	const before = context.slice(Math.max(0, m.index - 80), m.index + m[0].length);
	const clause = before.split(/[.;!?]\s/).pop() ?? before;
	const negation = NEGATION.exec(clause);
	return negation !== null && negation.index < clause.length - m[0].length;
}

export interface SkillMeta {
	name?: string;
	description?: string;
	keys: string[];
	bodyStart: number;
}

export function parseFrontmatter(text: string): SkillMeta | undefined {
	if (!text.startsWith("---\n")) return undefined;
	const end = text.indexOf("\n---\n", 4);
	if (end < 0) return undefined;
	const meta: SkillMeta = { keys: [], bodyStart: end + 5 };
	for (const line of text.slice(4, end).split("\n")) {
		const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
		if (!m) continue;
		meta.keys.push(m[1]);
		if (m[1] === "name") meta.name = m[2].trim();
		if (m[1] === "description") meta.description = m[2].trim();
	}
	return meta;
}

/** Lint one SKILL.md (or a reference .md beside it, with `reference: true`). */
export function lintText(file: string, text: string, options: { reference?: boolean; dirName?: string } = {}): Finding[] {
	const findings: Finding[] = [];
	const add = (line: number, rule: string, message: string, severity: Severity = "error") => findings.push({ file, line, rule, severity, message });

	if (Buffer.byteLength(text) > MAX_BYTES) add(1, "size", `Over ${MAX_BYTES} bytes. Move detail into references/*.md.`);
	const lines = text.split("\n");
	if (lines.length > MAX_LINES) add(MAX_LINES, "size", `Over ${MAX_LINES} lines. Move detail into references/*.md.`);

	if (!options.reference) {
		const meta = parseFrontmatter(text);
		if (!meta) add(1, "frontmatter", "Must start with --- frontmatter holding name and description.");
		else {
			for (const key of meta.keys) if (!FRONTMATTER_KEYS.has(key)) add(2, "frontmatter", `Unknown frontmatter key "${key}". Allowed: ${[...FRONTMATTER_KEYS].join(", ")}.`);
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

	let fence: string | undefined;
	lines.forEach((line, i) => {
		const n = i + 1;
		const fenceMatch = /^\s*(```+|~~~+)\s*([\w-]*)/.exec(line);
		if (fenceMatch) {
			fence = fence === undefined ? fenceMatch[2] || "code" : undefined;
			return;
		}
		const untrusted = fence === "untrusted";

		if (INVISIBLE.test(line)) add(n, "hidden-text", "Contains an invisible or text-reordering character.");
		if (MIXED_SCRIPT.test(line)) add(n, "hidden-text", "A word mixes Latin with Cyrillic or Greek lookalike letters.");
		// Inside a code fence, markup shows as text; outside one, it renders and can hide or load things.
		if (fence === undefined) {
			if (/<!--/.test(line) && line.trim() !== INSTALL_MARKER) add(n, "hidden-text", "HTML comments don't render, so reviewers miss them. Write it as visible text.");
			if (/<\s*(script|iframe|img|object|embed|style|link|meta)\b/i.test(line)) add(n, "hidden-text", "Raw HTML tags can load content or hide text.");
		}
		if (BLOB.test(line)) add(n, "encoded-blob", "A long encoded string can carry hidden instructions. Link to a reviewed file instead.");
		if (/!\[[^\]]*\]\(\s*https?:/i.test(line)) add(n, "remote-image", "A remote image loads on render and can leak data in its URL.");

		for (const url of line.matchAll(URL)) {
			const problem = findingsForUrl(url[0]);
			if (problem) add(n, "suspicious-link", `Link uses ${problem}: ${url[0]}`);
		}

		for (const r of PATTERN_RULES) {
			if (untrusted && !r.inUntrusted) continue;
			if (!r.pattern.test(line)) continue;
			if (r.negatable && negatedBeforeMatch(sentenceContext(lines, i), r.pattern)) continue;
			add(n, r.rule, r.message);
		}
	});
	if (fence !== undefined) add(lines.length, "structure", "A code fence is never closed.");
	return findings;
}

/** Files a skill folder may hold. Scripts need a code review path of their own, so they're refused here. */
const ALLOWED_FILES = /^(SKILL\.md|references\/[\w.-]+\.md|LICENSE(\.md|\.txt)?)$/;

/** Lint a skill folder, a SKILL.md, or a folder of skill folders. */
export function lintPath(path: string): Finding[] {
	if (!existsSync(path)) return [{ file: path, line: 0, rule: "missing", severity: "error", message: "No such file or folder." }];
	if (statSync(path).isFile()) {
		const reference = basename(path) !== "SKILL.md";
		return lintText(path, readFileSync(path, "utf8"), { reference, dirName: reference ? undefined : basename(dirname(path)) });
	}
	if (existsSync(join(path, "SKILL.md"))) return lintSkillDir(path);
	const findings: Finding[] = [];
	for (const entry of readdirSync(path).sort()) {
		const sub = join(path, entry);
		if (statSync(sub).isDirectory()) findings.push(...(existsSync(join(sub, "SKILL.md")) ? lintSkillDir(sub) : [{ file: sub, line: 0, rule: "structure", severity: "error" as const, message: "Folder has no SKILL.md." }]));
	}
	return findings;
}

function walk(dir: string, root = dir): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const p = join(dir, entry);
		return statSync(p).isDirectory() ? walk(p, root) : [relative(root, p)];
	});
}

function lintSkillDir(dir: string): Finding[] {
	const findings: Finding[] = [];
	for (const rel of walk(dir).sort()) {
		const file = join(dir, rel);
		if (!ALLOWED_FILES.test(rel)) {
			findings.push({ file, line: 0, rule: "file-type", severity: "error", message: "Skill folders hold SKILL.md, references/*.md and a LICENSE only." });
			continue;
		}
		if (extname(rel) !== ".md") continue;
		const text = readFileSync(file, "utf8");
		findings.push(...lintText(file, text, { reference: rel !== "SKILL.md", dirName: basename(dir) }));
	}
	return findings;
}

export function formatFindings(findings: Finding[]): string {
	return findings.map((f) => `${f.file}:${f.line}  ${f.severity}  ${f.rule}  ${f.message}`).join("\n");
}
