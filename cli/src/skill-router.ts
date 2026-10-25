/**
 * The skill router: given a task, which skill (if any) should the agent load? Offline and
 * dependency-free, so it runs in the MCP server on every call and in CI with no model.
 *
 * Each skill is indexed from three fields of its SKILL.md: the name, the description
 * (what the skill does, then its "Use when" triggers) and the bullets under
 * "## When to use". Matching is BM25F over light-stemmed words, plus three signals of
 * word order: a slash command (`/rsi`), a quoted trigger phrase from the description
 * ("learn from this"), and pairs of neighbouring words ("literature review"). Sentences
 * that send the reader elsewhere ("Not for ...", "For news, use `news-research`") are left
 * out, so they don't pull those tasks in.
 *
 * A match needs MIN_SCORE and two pieces of evidence, or one word specific enough to reach
 * SINGLE_SCORE alone. Otherwise the answer is "none": a small model does better with no
 * skill than with the wrong one (docs/decisions.md D12). The constants are calibrated on
 * skills-eval/router-cases.jsonl; `tabkyra skill eval` reports how well they hold.
 */

export interface RouterSkill {
	name: string;
	/** The SKILL.md text, frontmatter included. */
	text: string;
}

export interface SkillMatch {
	name: string;
	/** Higher is a better match; MIN_SCORE is the floor for any match. */
	score: number;
	/** The first sentence of the skill's description. */
	description: string;
}

type Field = "name" | "what" | "when";

interface Doc {
	name: string;
	description: string;
	/** Term frequencies and length per field. */
	tf: Record<Field, Map<string, number>>;
	len: Record<Field, number>;
	/** Trigger phrases as word sequences (unstemmed, stopwords kept). */
	phrases: string[][];
	/** Pairs of neighbouring words within a clause ("literature review", "search operators"). */
	pairs: Set<string>;
}

export interface RouterIndex {
	docs: Doc[];
	idf: Map<string, number>;
	avg: Record<Field, number>;
	/** Per skill: "<name> skill" and "/command <name>", where the name is the object, not the job. */
	references: RegExp[];
}

/** Field weights, BM25 constants and bonuses, calibrated on skills-eval/router-cases.jsonl. */
const WEIGHT: Record<Field, number> = { name: 1.5, what: 1, when: 1.5 };
const B: Record<Field, number> = { name: 0, what: 0.6, when: 0.6 };
const K1 = 1.2;
const COMMAND_BONUS = 6;
const PHRASE_BONUS = 2.5;
const PAIR_BONUS = 2;
/** The floor for any match. */
export const MIN_SCORE = 2.5;
/** A match on one piece of evidence alone needs a word this specific ("osint", "dorks"). */
export const SINGLE_SCORE = 4.5;
/** A word in more than about a quarter of the skills is too common to count as evidence. */
const EVIDENCE_IDF = 1.5;

const STOPWORDS = new Set(
	(
		"a an the and or but nor of to in on at by for with from as into onto over under about against between through during " +
		"is are was were be been being am do does did done doing have has had having will would shall should can could may might must " +
		"i me my mine myself you your yours yourself we us our ours they them their theirs he him his she her hers it its itself " +
		"this that these those there here what which whom whose why how where when while if then than so too very just only also even " +
		"all any each every some such no not own same other another more most less few much one ones " +
		"please let get got give gave make made want wants wanted need needs like use used using user users ask asks asked tell " +
		"help show look try see go put take thing things way whether last first next new after before until since " +
		"something anything everything someone really actually return returns returned " +
		"s t d ll re ve m don doesn didn isn aren wasn weren won wouldn can't don't it's i'm i've that's what's"
	).split(" "),
);

/** Words the suffix rules would merge with another word ("news" is not "new"). */
const KEEP = new Set(["news", "series", "analytics", "always"]);

/** Derivational endings, longest first: "investigation", "investigative" and "investigate" meet. */
const DERIVED = ["ational", "ization", "isation", "ations", "ation", "ition", "ement", "ment", "ness", "ions", "ion", "ity", "ive", "ous", "ance", "ence", "able", "ible", "ate", "ize", "ise", "ful", "al", "ic"];

/**
 * Light stemming: plurals, -ing, -ed, -er, -ly, one derivational ending, and a final e or
 * y, so "reviewer", "reviews" and "reviewing" meet. Both sides are stemmed alike, so a
 * stem need not be a word.
 */
export function stem(word: string): string {
	let w = word;
	if (w.length <= 3 || KEEP.has(w)) return w;
	if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
	else if (w.endsWith("sses")) w = w.slice(0, -2);
	else if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
	for (const suffix of ["ing", "ed", "er", "ly"]) {
		if (w.endsWith(suffix) && w.length - suffix.length >= 4) {
			w = w.slice(0, -suffix.length);
			if (/([^aeiouls])\1$/.test(w)) w = w.slice(0, -1);
			break;
		}
	}
	for (const suffix of DERIVED) {
		if (w.endsWith(suffix) && w.length - suffix.length >= 4) {
			w = w.slice(0, -suffix.length);
			break;
		}
	}
	if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
	if (w.length > 3 && w.endsWith("y")) w = `${w.slice(0, -1)}i`;
	return w;
}

/** Lowercase words in order; apostrophes kept inside words, everything else splits. */
function words(text: string): string[] {
	return (
		text
			.toLowerCase()
			.replace(/[‘’]/g, "'")
			.match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []
	);
}

function terms(text: string): string[] {
	return words(text)
		.map((w) => w.replace(/'s$/, ""))
		.filter((w) => !STOPWORDS.has(w))
		.map(stem);
}

function count(list: string[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const t of list) m.set(t, (m.get(t) ?? 0) + 1);
	return m;
}

/** Sentences that point to another tool or skill describe what the skill is not. */
const REDIRECT = /^(not for|for [^.]*\buse `|use a plain|use `|don't write a skill)/i;

function frontmatterDescription(text: string): string {
	return /^description: (.*)$/m.exec(text)?.[1]?.trim() ?? "";
}

/** The "## When to use" bullets, each with its wrapped lines. Paragraphs between them are skipped. */
function whenToUse(text: string): string[] {
	const m = /^## When to use[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text);
	if (!m) return [];
	const items: string[] = [];
	let open = false;
	for (const line of m[1].split("\n")) {
		if (/^\s*[-*] /.test(line)) {
			items.push(line.replace(/^\s*[-*] /, ""));
			open = true;
		} else if (open && /^\s+\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
		else open = false;
	}
	return items;
}

function sentences(text: string): string[] {
	return text.split(/(?<=[.!?])\s+(?=[A-Z`/"])/);
}

/** The first sentence of a description: what `skill list` and skill_match show. */
export function oneLine(description: string): string {
	const first = description.split(/(?<=\.)\s/)[0] ?? description;
	return first.endsWith(".") ? first : `${first}.`;
}

/** Remove backticked mentions of other skills: "use `news-research`" is not about this skill. */
function withoutOtherSkills(text: string, self: string, names: ReadonlySet<string>): string {
	return text.replace(/`([a-z0-9-]+)`/g, (whole, inner: string) => (inner !== self && names.has(inner) ? " " : whole));
}

function phrasesOf(name: string, description: string, bullets: string[]): string[][] {
	const out: string[][] = [];
	for (const source of [description, ...bullets]) {
		for (const m of source.matchAll(/"([^"]{3,60})"/g)) {
			// A trailing placeholder ("what is known about X") matches any topic, so it's dropped.
			const seq = words(m[1]);
			while (seq.length > 1 && seq[seq.length - 1].length === 1) seq.pop();
			if (seq.length >= 1 && seq.join(" ") !== name) out.push(seq);
		}
	}
	return out;
}

/**
 * Neighbouring stemmed words within each clause, as order-free keys. In a list of one-word
 * items that ends on a phrase ("write, draft or port a skill"), each item also pairs with
 * the phrase's last word, the way a reader distributes it: write skill, draft skill.
 */
function pairsOf(text: string): Set<string> {
	const out = new Set<string>();
	const add = (a: string, b: string) => {
		if (a !== b) out.add([a, b].sort().join(" "));
	};
	for (const clause of text.split(/[;:()?!]|\.(?=\s|$)|\s[-\u2013\u2014]\s/)) {
		const items = clause.split(/,|\bor\b|\band\b/).map(terms).filter((t) => t.length);
		items.forEach((t, k) => {
			for (let i = 0; i + 1 < t.length; i++) add(t[i], t[i + 1]);
			if (t.length < 2) return;
			for (let j = k - 1; j >= 0 && items[j].length === 1; j--) add(items[j][0], t[t.length - 1]);
		});
	}
	return out;
}

/**
 * The name's words. A hyphenated name also counts joined ("protonpass"), and a run-together
 * name counts the words of its own description it is made of ("kyraskillmaker": skill, make).
 */
function nameTerms(name: string, vocabulary: Set<string>): string[] {
	const out = terms(name.replace(/-/g, " "));
	if (name.includes("-")) out.push(name.replace(/-/g, ""));
	for (const part of name.split("-")) {
		if (part.length < 8) continue;
		for (const word of vocabulary) if (word.length >= 4 && word !== part && part.includes(word)) out.push(word);
	}
	return out;
}

function parse(skill: RouterSkill, names: ReadonlySet<string>): Doc {
	const description = frontmatterDescription(skill.text);
	const clean = (t: string) => withoutOtherSkills(t, skill.name, names);
	const kept = sentences(description).filter((s) => !REDIRECT.test(s.trim()));
	const useAt = kept.findIndex((s) => /\bUse when\b/.test(s));
	const whatText = useAt < 0 ? kept : kept.slice(0, useAt);
	const triggers = useAt < 0 ? [] : kept.slice(useAt);
	const bullets = whenToUse(skill.text).filter((b) => !REDIRECT.test(b.trim()));
	const what = terms(clean(whatText.join(" ")));
	const when = terms(clean([...triggers, ...bullets].join(" ")));
	const fields: Record<Field, string[]> = { name: nameTerms(skill.name, new Set([...what, ...when])), what, when };
	return {
		name: skill.name,
		description,
		tf: { name: count(fields.name), what: count(fields.what), when: count(fields.when) },
		len: { name: fields.name.length, what: fields.what.length, when: fields.when.length },
		phrases: phrasesOf(skill.name, clean(description), bullets.map(clean)),
		pairs: pairsOf(clean([...kept, ...bullets].join(". "))),
	};
}

/** Build the index once; matching is then a few map lookups per word. */
export function buildRouterIndex(skills: RouterSkill[]): RouterIndex {
	const names = new Set(skills.map((s) => s.name));
	const docs = skills.map((s) => parse(s, names));
	const df = new Map<string, number>();
	for (const d of docs) {
		const seen = new Set([...d.tf.name.keys(), ...d.tf.what.keys(), ...d.tf.when.keys()]);
		for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
	}
	const n = docs.length;
	const idf = new Map([...df].map(([t, k]) => [t, Math.log(1 + (n - k + 0.5) / (k + 0.5))]));
	const mean = (f: Field) => (n ? docs.reduce((s, d) => s + d.len[f], 0) / n : 1) || 1;
	// Names are lowercase-kebab-case (assertName), so they're safe inside a pattern.
	const references = [...names].flatMap((name) => {
		const spelled = name.replace(/-/g, "[- ]?");
		return [new RegExp(`\\b${spelled}(?=\\s+skills?\\b)`, "g"), new RegExp(`((?:^|\\s)/[a-z0-9-]+\\s+)${spelled}\\b`, "g")];
	});
	return { docs, idf, avg: { name: mean("name"), what: mean("what"), when: mean("when") }, references };
}

function containsSequence(haystack: string[], needle: string[]): boolean {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
		return true;
	}
	return false;
}

/**
 * Skills the task names as an object ("the osint skill", "/fix news-research") rather than
 * as the job to do. Their names are taken out of the task: they say which skill to work
 * on, not what kind of work it is.
 */
function withoutReferences(task: string, references: RegExp[]): string {
	let out = task.toLowerCase();
	for (const pattern of references) out = out.replace(pattern, (_whole, before?: string) => `${typeof before === "string" ? before : ""} `);
	return out;
}

export interface RawScore {
	name: string;
	score: number;
	/** Pieces of evidence: one per specific matched word or word pair, two per command or trigger phrase. */
	evidence: number;
}

/** Every skill's unfiltered score for a task, best first. */
export function scoreSkills(index: RouterIndex, task: string): RawScore[] {
	const commands = new Set([...task.toLowerCase().matchAll(/(?:^|\s)\/([a-z0-9-]+)\b/g)].map((m) => m[1]));
	const content = withoutReferences(task, index.references);
	const query = [...new Set(terms(content))];
	const seq = words(content);
	const queryPairs = pairsOf(content);
	const out: RawScore[] = [];
	for (const d of index.docs) {
		let score = 0;
		let evidence = 0;
		for (const t of query) {
			const idf = index.idf.get(t);
			if (idf === undefined) continue;
			let tf = 0;
			for (const f of ["name", "what", "when"] as const) {
				const raw = d.tf[f].get(t) ?? 0;
				if (raw) tf += (WEIGHT[f] * raw) / (1 - B[f] + (B[f] * d.len[f]) / index.avg[f]);
			}
			if (tf > 0) {
				score += (idf * tf * (K1 + 1)) / (K1 + tf);
				if (idf >= EVIDENCE_IDF) evidence++;
			}
		}
		if (commands.has(d.name)) {
			score += COMMAND_BONUS;
			evidence += 2;
		}
		for (const p of queryPairs) {
			if (d.pairs.has(p)) {
				score += PAIR_BONUS;
				evidence++;
			}
		}
		for (const p of d.phrases) {
			if (containsSequence(seq, p)) {
				score += PHRASE_BONUS;
				evidence += 2;
			}
		}
		out.push({ name: d.name, score, evidence });
	}
	return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** Whether a raw score counts as a match. One ordinary shared word ("fix the test", "a bug in my code") is a coincidence. */
export function isMatch(s: RawScore): boolean {
	return s.score >= MIN_SCORE && (s.evidence >= 2 || s.score >= SINGLE_SCORE);
}

/** Ranked matches for a task, best first; an empty list means no skill fits. */
export function matchSkills(index: RouterIndex, task: string, top = 3): SkillMatch[] {
	const byName = new Map(index.docs.map((d) => [d.name, d]));
	return scoreSkills(index, task)
		.filter(isMatch)
		.slice(0, Math.max(1, top))
		.map((s) => ({ name: s.name, score: Math.round(s.score * 100) / 100, description: oneLine(byName.get(s.name)?.description ?? "") }));
}
