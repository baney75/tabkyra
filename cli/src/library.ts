/**
 * `tabkyra library`: a local source library in the spirit of Zotero. Every entry is a
 * CSL-JSON record fetched from its DOI's registry (Crossref or DataCite through doi.org),
 * then checked against OpenAlex and Crossref's update notices for retractions. Entries
 * export to BibTeX, RIS and CSL-JSON (Zotero, Word, LaTeX) and to one Obsidian note each.
 *
 * Fetched metadata is untrusted: titles and names are stripped of control characters,
 * escaped for each output format, and never used in a path. Citekeys, which name files,
 * are generated here from [a-z0-9] only.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { VERSION } from "./version.ts";

export interface CslName {
	family?: string;
	given?: string;
	literal?: string;
}

export interface Verification {
	at: string;
	/** Where the record and the checks came from: "doi.org", "openalex", "crossref-updates". */
	sources: string[];
	retracted: boolean;
	/** Corrections, expressions of concern and retractions that point at this DOI. */
	notices: Array<{ type: string; doi: string }>;
	oaUrl?: string;
	citedBy?: number;
}

export interface LibraryItem {
	id: string;
	type: string;
	title: string;
	author?: CslName[];
	issued?: { "date-parts"?: number[][] };
	"container-title"?: string;
	publisher?: string;
	volume?: string;
	issue?: string;
	page?: string;
	DOI?: string;
	URL?: string;
	tabkyra: {
		addedAt: string;
		verified: Verification;
		tags: string[];
		note?: string;
		quote?: { text: string; location?: string };
	};
}

interface Library {
	version: 1;
	items: LibraryItem[];
}

export function libraryFile(): string {
	const dir = process.env.TABKYRA_LIBRARY_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tabkyra", "library");
	return join(dir, "library.json");
}

export function loadLibrary(): Library {
	const file = libraryFile();
	if (!existsSync(file)) return { version: 1, items: [] };
	const data = JSON.parse(readFileSync(file, "utf8")) as Library;
	if (data.version !== 1 || !Array.isArray(data.items)) throw new Error(`${file} is not a Tabkyra library.`);
	return data;
}

function saveLibrary(library: Library): void {
	const file = libraryFile();
	mkdirSync(join(file, ".."), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(library, null, "\t")}\n`);
	renameSync(tmp, file);
}

// --- Identifiers -------------------------------------------------------------------------

/** A DOI from a bare DOI, a doi: prefix, a doi.org URL, or an arXiv id (DataCite DOI). */
export function toDoi(input: string): string | undefined {
	const s = input.trim();
	const arxiv = /^(?:arxiv:|https?:\/\/arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})(v\d+)?(?:\.pdf)?$/i.exec(s);
	if (arxiv) return `10.48550/arXiv.${arxiv[1]}`;
	const doi = /(?:^doi:|^https?:\/\/(?:dx\.)?doi\.org\/|^)(10\.\d{4,9}\/\S+)$/i.exec(s);
	return doi ? decodeURIComponent(doi[1]) : undefined;
}

// --- Fetching ----------------------------------------------------------------------------

const base = {
	doi: () => process.env.TABKYRA_DOI_BASE || "https://doi.org",
	openalex: () => process.env.TABKYRA_OPENALEX_BASE || "https://api.openalex.org",
	crossref: () => process.env.TABKYRA_CROSSREF_BASE || "https://api.crossref.org",
};
const USER_AGENT = `tabkyra/${VERSION} (https://github.com/baney75/tabkyra)`;

async function get(url: string, accept: string): Promise<Response> {
	return fetch(url, { headers: { Accept: accept, "User-Agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
}

/** Drop control and format characters (hidden text) and collapse whitespace. */
export function clean(value: unknown, max = 1000): string {
	if (typeof value !== "string") return "";
	return value
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/<[^>]{0,200}>/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

function first(value: unknown): string {
	return clean(Array.isArray(value) ? value[0] : value);
}

function cleanNames(value: unknown): CslName[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const names = value
		.slice(0, 100)
		.map((n: Record<string, unknown>) => ({ family: clean(n.family, 200) || undefined, given: clean(n.given, 200) || undefined, literal: clean(n.literal ?? n.name, 300) || undefined }))
		.filter((n) => n.family || n.literal);
	return names.length ? names : undefined;
}

function cleanIssued(value: unknown): LibraryItem["issued"] {
	const parts = (value as { "date-parts"?: unknown })?.["date-parts"];
	if (!Array.isArray(parts) || !Array.isArray(parts[0])) return undefined;
	const nums = (parts[0] as unknown[]).slice(0, 3).map(Number).filter((n) => Number.isInteger(n) && n > 0);
	return nums.length ? { "date-parts": [nums] } : undefined;
}

async function fetchCsl(doi: string): Promise<Record<string, unknown>> {
	const res = await get(`${base.doi()}/${encodeURI(doi)}`, "application/vnd.citationstyles.csl+json");
	if (res.status === 404) throw new Error(`DOI ${doi} is not registered (doi.org returned 404). It may be mistyped or made up.`);
	if (!res.ok) throw new Error(`doi.org returned ${res.status} for ${doi}.`);
	return (await res.json()) as Record<string, unknown>;
}

async function verify(doi: string): Promise<Verification> {
	const v: Verification = { at: new Date().toISOString(), sources: ["doi.org"], retracted: false, notices: [] };
	try {
		const res = await get(`${base.openalex()}/works/doi:${encodeURI(doi)}?select=is_retracted,open_access,cited_by_count`, "application/json");
		if (res.ok) {
			const w = (await res.json()) as { is_retracted?: boolean; open_access?: { oa_url?: string }; cited_by_count?: number };
			v.sources.push("openalex");
			if (w.is_retracted) v.retracted = true;
			const oa = clean(w.open_access?.oa_url, 2000);
			if (/^https:\/\//.test(oa)) v.oaUrl = oa;
			if (Number.isInteger(w.cited_by_count)) v.citedBy = w.cited_by_count;
		}
	} catch {
		/* OpenAlex is a second opinion; the record itself came from the registry. */
	}
	try {
		const res = await get(`${base.crossref()}/works?filter=updates:${encodeURIComponent(doi)}&select=DOI,update-to&rows=20`, "application/json");
		if (res.ok) {
			const body = (await res.json()) as { message?: { items?: Array<{ DOI?: string; "update-to"?: Array<{ type?: string; DOI?: string }> }> } };
			v.sources.push("crossref-updates");
			for (const item of body.message?.items ?? []) {
				for (const u of item["update-to"] ?? []) {
					if (u.DOI?.toLowerCase() !== doi.toLowerCase()) continue;
					const type = clean(u.type, 50).toLowerCase();
					v.notices.push({ type, doi: clean(item.DOI, 200) });
					if (type === "retraction" || type === "withdrawal" || type === "removal") v.retracted = true;
				}
			}
		}
	} catch {
		/* Same as above. */
	}
	return v;
}

/** Crossref sometimes answers with its own type names; map them to CSL's. */
const CROSSREF_TYPES: Record<string, string> = {
	"journal-article": "article-journal",
	"book-chapter": "chapter",
	"book-section": "chapter",
	"proceedings-article": "paper-conference",
	"posted-content": "article",
	dissertation: "thesis",
	monograph: "book",
	"edited-book": "book",
	"reference-book": "book",
	"report-component": "report",
};

function cslType(type: string): string {
	return CROSSREF_TYPES[type] ?? (type || "article");
}

// --- Citekeys ----------------------------------------------------------------------------

const STOP = new Set(["a", "an", "the", "on", "of", "in", "for", "and", "to", "with", "from", "by", "at", "is", "are", "retracted", "withdrawn"]);

function ascii(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
}

export function citekey(item: Pick<LibraryItem, "author" | "issued" | "title">, taken: Set<string>): string {
	const who = ascii(item.author?.[0]?.family ?? item.author?.[0]?.literal ?? "anon").slice(0, 20) || "anon";
	const year = item.issued?.["date-parts"]?.[0]?.[0] ?? "nd";
	const word = ascii(item.title.split(/[\s\-\u2010-\u2015/]+/).find((w) => ascii(w).length > 2 && !STOP.has(ascii(w))) ?? "").slice(0, 20);
	const stem = `${who}${year}${word}`;
	if (!taken.has(stem)) return stem;
	for (const suffix of "abcdefghijklmnopqrstuvwxyz") if (!taken.has(`${stem}${suffix}`)) return `${stem}${suffix}`;
	return `${stem}${taken.size}`;
}

// --- Commands ----------------------------------------------------------------------------

export interface AddOptions {
	quote?: string;
	location?: string;
	note?: string;
	tags?: string[];
}

export async function addSource(input: string, options: AddOptions = {}): Promise<{ item: LibraryItem; existed: boolean }> {
	const doi = toDoi(input);
	if (!doi) throw new Error(`"${input}" is not a DOI, doi.org link or arXiv id. Find the source's DOI first.`);
	const library = loadLibrary();
	const existing = library.items.find((i) => i.DOI?.toLowerCase() === doi.toLowerCase());
	if (existing) {
		mergeAnnotations(existing, options);
		saveLibrary(library);
		return { item: existing, existed: true };
	}
	const csl = await fetchCsl(doi);
	const title = first(csl.title);
	if (!title) throw new Error(`The record for ${doi} has no title.`);
	const draft = {
		type: cslType(clean(csl.type, 50)),
		title,
		author: cleanNames(csl.author) ?? cleanNames(csl.editor),
		issued: cleanIssued(csl.issued) ?? cleanIssued(csl.published) ?? cleanIssued(csl.created),
		"container-title": first(csl["container-title"]) || undefined,
		publisher: clean(csl.publisher, 300) || undefined,
		volume: clean(csl.volume, 50) || undefined,
		issue: clean(csl.issue, 50) || undefined,
		page: clean(csl.page, 50) || undefined,
		DOI: clean(csl.DOI, 300) || doi,
		URL: `https://doi.org/${doi}`,
	};
	const item: LibraryItem = {
		id: citekey(draft, new Set(library.items.map((i) => i.id))),
		...draft,
		tabkyra: { addedAt: new Date().toISOString(), verified: await verify(doi), tags: [] },
	};
	mergeAnnotations(item, options);
	library.items.push(item);
	saveLibrary(library);
	return { item, existed: false };
}

function mergeAnnotations(item: LibraryItem, options: AddOptions): void {
	if (options.quote) item.tabkyra.quote = { text: clean(options.quote, 2000), location: clean(options.location, 100) || undefined };
	if (options.note) item.tabkyra.note = clean(options.note, 4000);
	for (const tag of options.tags ?? []) {
		const t = clean(tag, 50);
		if (t && !item.tabkyra.tags.includes(t)) item.tabkyra.tags.push(t);
	}
}

export async function reverify(keys: string[]): Promise<LibraryItem[]> {
	const library = loadLibrary();
	const targets = keys.length ? library.items.filter((i) => keys.includes(i.id)) : library.items;
	for (const item of targets) if (item.DOI) item.tabkyra.verified = await verify(item.DOI);
	saveLibrary(library);
	return targets;
}

export function search(query: string): LibraryItem[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return loadLibrary().items.filter((i) => {
		const hay = [i.id, i.title, i["container-title"], i.DOI, ...(i.author ?? []).map((a) => `${a.given ?? ""} ${a.family ?? a.literal ?? ""}`), ...i.tabkyra.tags, i.tabkyra.note]
			.join(" ")
			.toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

export function removeSource(key: string): boolean {
	const library = loadLibrary();
	const before = library.items.length;
	library.items = library.items.filter((i) => i.id !== key);
	if (library.items.length === before) return false;
	saveLibrary(library);
	return true;
}

const STYLES = new Set(["apa", "modern-language-association", "chicago-author-date", "ieee", "harvard-cite-them-right", "vancouver"]);
const STYLE_ALIASES: Record<string, string> = { mla: "modern-language-association", chicago: "chicago-author-date", harvard: "harvard-cite-them-right" };

/** A formatted reference from doi.org's citation formatter (CSL styles). */
export async function cite(key: string, style = "apa"): Promise<string> {
	const item = loadLibrary().items.find((i) => i.id === key);
	if (!item) throw new Error(`No source with key ${key}. Run tabkyra library search.`);
	const csl = STYLE_ALIASES[style] ?? style;
	if (!STYLES.has(csl)) throw new Error(`Unknown style ${style}. Use apa, mla, chicago, ieee, harvard or vancouver.`);
	if (!item.DOI) throw new Error(`${key} has no DOI to format.`);
	const res = await get(`${base.doi()}/${encodeURI(item.DOI)}`, `text/x-bibliography; style=${csl}; locale=en-US`);
	if (!res.ok) throw new Error(`doi.org returned ${res.status} formatting ${key}.`);
	// The formatter leaves an empty "edited by ," when a record has no editors.
	const text = clean(await res.text(), 3000).replace(/,? edited by ,/g, ",");
	return item.tabkyra.verified.retracted ? `[RETRACTED] ${text}` : text;
}

// --- Export ------------------------------------------------------------------------------

const BIBTEX_TYPE: Record<string, string> = {
	"article-journal": "article",
	article: "misc",
	book: "book",
	chapter: "incollection",
	"paper-conference": "inproceedings",
	report: "techreport",
	thesis: "phdthesis",
	"posted-content": "misc",
	dataset: "misc",
};

function bibEscape(s: string): string {
	return s.replace(/\\/g, "\\textbackslash{}").replace(/([{}&%$#_])/g, "\\$1").replace(/~/g, "\\textasciitilde{}").replace(/\^/g, "\\textasciicircum{}");
}

function names(item: LibraryItem, sepBy: string): string {
	return (item.author ?? []).map((a) => (a.family ? (a.given ? `${a.family}, ${a.given}` : a.family) : (a.literal ?? ""))).join(sepBy);
}

function year(item: LibraryItem): string {
	return String(item.issued?.["date-parts"]?.[0]?.[0] ?? "");
}

export function toBibtex(items: LibraryItem[]): string {
	return items
		.map((i) => {
			const fields: Array<[string, string | undefined]> = [
				["title", i.title],
				["author", names(i, " and ")],
				["year", year(i)],
				[i.type === "article-journal" ? "journal" : "booktitle", i["container-title"]],
				["publisher", i.publisher],
				["volume", i.volume],
				["number", i.issue],
				["pages", i.page?.replace(/-/g, "--")],
				["doi", i.DOI],
				["url", i.URL],
				["note", i.tabkyra.verified.retracted ? "RETRACTED" : undefined],
			];
			const body = fields
				.filter(([, v]) => v)
				.map(([k, v]) => `  ${k} = {${k === "doi" || k === "url" ? (v as string).replace(/[{}\\]/g, "") : bibEscape(v as string)}}`)
				.join(",\n");
			return `@${BIBTEX_TYPE[i.type] ?? "misc"}{${i.id},\n${body}\n}`;
		})
		.join("\n\n")
		.concat(items.length ? "\n" : "");
}

const RIS_TYPE: Record<string, string> = {
	"article-journal": "JOUR",
	book: "BOOK",
	chapter: "CHAP",
	"paper-conference": "CONF",
	report: "RPRT",
	thesis: "THES",
	dataset: "DATA",
};

export function toRis(items: LibraryItem[]): string {
	return items
		.map((i) => {
			const [sp, ep] = (i.page ?? "").split("-");
			const lines = [
				`TY  - ${RIS_TYPE[i.type] ?? "GEN"}`,
				`ID  - ${i.id}`,
				...(i.author ?? []).map((a) => `AU  - ${a.family ? (a.given ? `${a.family}, ${a.given}` : a.family) : (a.literal ?? "")}`),
				`TI  - ${i.title}`,
				i["container-title"] ? `T2  - ${i["container-title"]}` : "",
				year(i) ? `PY  - ${year(i)}` : "",
				i.volume ? `VL  - ${i.volume}` : "",
				i.issue ? `IS  - ${i.issue}` : "",
				sp ? `SP  - ${sp}` : "",
				ep ? `EP  - ${ep}` : "",
				i.publisher ? `PB  - ${i.publisher}` : "",
				i.DOI ? `DO  - ${i.DOI}` : "",
				i.URL ? `UR  - ${i.URL}` : "",
				i.tabkyra.verified.retracted ? "N1  - RETRACTED" : "",
				"ER  - ",
			];
			return lines.filter(Boolean).join("\n");
		})
		.join("\n\n")
		.concat(items.length ? "\n" : "");
}

export function toCslJson(items: LibraryItem[]): string {
	return `${JSON.stringify(
		items.map(({ tabkyra: _t, ...csl }) => csl),
		null,
		2,
	)}\n`;
}

/** A YAML string Obsidian won't turn into a link: properties treat "[[...]]" as one. */
function yamlText(value: unknown): string {
	const unlink = (v: unknown): unknown => (typeof v === "string" ? v.replace(/\[\[/g, "[ [").replace(/\]\]/g, "] ]") : Array.isArray(v) ? v.map(unlink) : v);
	return JSON.stringify(unlink(value));
}

/** Text safe inside a Markdown line: no wikilink, embed or HTML syntax from fetched metadata. */
function md(s: string): string {
	return s.replace(/[[\]<>`|]/g, (c) => `\\${c}`);
}

/** One Obsidian note per source, named by citekey, inside `<vault>/<folder>`. */
export function writeObsidian(vault: string, folder = "Sources"): string[] {
	if (!existsSync(vault) || !statSync(vault).isDirectory()) throw new Error(`${vault} is not a folder.`);
	const root = realpathSync(vault);
	const inside = (p: string) => {
		const rel = relative(root, p);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	};
	const dir = resolve(root, folder);
	if (!inside(dir)) throw new Error(`${folder} is outside the vault.`);
	mkdirSync(dir, { recursive: true });
	// A symlinked folder could still lead out of the vault.
	if (!inside(realpathSync(dir))) throw new Error(`${folder} leads outside the vault.`);
	const written: string[] = [];
	for (const i of loadLibrary().items) {
		if (!/^[a-z0-9]+$/.test(i.id)) continue;
		const file = join(dir, `${i.id}.md`);
		if (existsSync(file) && lstatSync(file).isSymbolicLink()) continue;
		const v = i.tabkyra.verified;
		const front = [
			"---",
			`title: ${yamlText(i.title)}`,
			`authors: ${yamlText((i.author ?? []).map((a) => [a.given, a.family ?? a.literal].filter(Boolean).join(" ")))}`,
			`year: ${JSON.stringify(year(i))}`,
			`citekey: ${i.id}`,
			i.DOI ? `doi: ${yamlText(i.DOI)}` : "",
			`verified: ${JSON.stringify(v.at.slice(0, 10))}`,
			`retracted: ${v.retracted}`,
			`tags: ${yamlText(["source", ...i.tabkyra.tags.map((t) => t.replace(/[^\w/-]/g, "-"))])}`,
			"---",
		].filter(Boolean);
		const body = [
			`# ${md(i.title)}`,
			"",
			`${md(names(i, "; "))} (${year(i)}). ${i["container-title"] ? `*${md(i["container-title"])}*` : ""}`,
			i.DOI ? `DOI: <https://doi.org/${encodeURI(i.DOI)}>` : "",
			v.retracted ? "\n> [!warning] Retracted\n> A retraction notice points at this DOI. Don't cite it as support." : "",
			v.oaUrl ? `Open access copy: <${encodeURI(v.oaUrl)}>` : "",
			i.tabkyra.quote ? `\n## Supporting quote\n\n> ${md(i.tabkyra.quote.text)}${i.tabkyra.quote.location ? `\n> (${md(i.tabkyra.quote.location)})` : ""}` : "",
			i.tabkyra.note ? `\n## Notes\n\n${md(i.tabkyra.note)}` : "",
		].filter((l) => l !== "");
		writeFileSync(file, `${front.join("\n")}\n\n${body.join("\n\n")}\n`);
		written.push(file);
	}
	return written;
}

// --- CLI ---------------------------------------------------------------------------------

function line(i: LibraryItem): string {
	const who = i.author?.[0]?.family ?? i.author?.[0]?.literal ?? "?";
	const flag = i.tabkyra.verified.retracted ? " [RETRACTED]" : "";
	return `${i.id.padEnd(28)} ${who} ${year(i)}. ${i.title.slice(0, 90)}${flag}`;
}

export const LIBRARY_USAGE =
	"Usage: tabkyra library add <doi|arxiv id> [--quote TEXT] [--location TEXT] [--note TEXT] [--tag TAG] | list [--json] | search <words> | " +
	"verify [key...] | cite <key> [--style apa|mla|chicago|ieee|harvard|vancouver] | export --format bibtex|ris|csl [--out FILE] | " +
	"obsidian <vault> [--folder Sources] | remove <key>";

/** Splits `--name value` options from positionals. Repeated `--tag` collects. */
function parse(args: string[]): { positional: string[]; opts: Record<string, string>; tags: string[] } {
	const positional: string[] = [];
	const opts: Record<string, string> = {};
	const tags: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--json") opts.json = "1";
		else if (a.startsWith("--")) {
			const value = args[++i];
			if (value === undefined) throw new Error(`${a} needs a value. ${LIBRARY_USAGE}`);
			if (a === "--tag") tags.push(value);
			else opts[a.slice(2)] = value;
		} else positional.push(a);
	}
	return { positional, opts, tags };
}

export async function runLibrary(args: string[]): Promise<number> {
	const [sub, ...rest] = args;
	const { positional, opts, tags } = parse(rest);
	switch (sub) {
		case "add": {
			if (positional.length !== 1) throw new Error(LIBRARY_USAGE);
			const { item, existed } = await addSource(positional[0], { quote: opts.quote, location: opts.location, note: opts.note, tags });
			const v = item.tabkyra.verified;
			console.log(`${existed ? "Updated" : "Added"} ${line(item)}`);
			console.log(`  verified by ${v.sources.join(", ")}${v.citedBy !== undefined ? `; cited by ${v.citedBy}` : ""}`);
			for (const n of v.notices) console.log(`  notice: ${n.type} ${n.doi}`);
			if (v.retracted) {
				console.log("  RETRACTED: don't cite this as support.");
				return 3;
			}
			return 0;
		}
		case "list": {
			const items = loadLibrary().items;
			if (opts.json) console.log(JSON.stringify(items, null, 2));
			else for (const i of items) console.log(line(i));
			return 0;
		}
		case "search": {
			const hits = search(positional.join(" "));
			for (const i of hits) console.log(line(i));
			return hits.length ? 0 : 1;
		}
		case "verify": {
			const items = await reverify(positional);
			for (const i of items) console.log(`${line(i)}  (${i.tabkyra.verified.sources.join(", ")})`);
			return items.some((i) => i.tabkyra.verified.retracted) ? 3 : 0;
		}
		case "cite": {
			if (positional.length !== 1) throw new Error(LIBRARY_USAGE);
			console.log(await cite(positional[0], opts.style));
			return 0;
		}
		case "export": {
			const items = loadLibrary().items;
			const format = opts.format ?? "bibtex";
			const out = format === "bibtex" ? toBibtex(items) : format === "ris" ? toRis(items) : format === "csl" ? toCslJson(items) : undefined;
			if (out === undefined) throw new Error(`Unknown format ${format}. Use bibtex, ris or csl.`);
			if (opts.out) {
				writeFileSync(opts.out, out);
				console.log(`Wrote ${items.length} sources to ${opts.out}`);
			} else process.stdout.write(out);
			return 0;
		}
		case "obsidian": {
			if (positional.length !== 1) throw new Error(LIBRARY_USAGE);
			const files = writeObsidian(positional[0], opts.folder);
			console.log(`Wrote ${files.length} notes to ${join(positional[0], opts.folder ?? "Sources")}`);
			return 0;
		}
		case "remove": {
			if (positional.length !== 1) throw new Error(LIBRARY_USAGE);
			if (!removeSource(positional[0])) {
				console.log(`No source with key ${positional[0]}.`);
				return 1;
			}
			console.log(`Removed ${positional[0]}.`);
			return 0;
		}
		default:
			throw new Error(LIBRARY_USAGE);
	}
}
