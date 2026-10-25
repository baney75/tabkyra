// `tabkyra library` against a local stand-in for doi.org, OpenAlex and Crossref: sources are
// verified before they're saved, retractions are flagged, unregistered DOIs are refused, and
// hostile metadata can't hide text, inject Markdown or YAML, or write outside the vault.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const root = mkdtempSync(join(tmpdir(), "tabkyra-library-"));

const RECORDS = {
	"10.1000/good": {
		type: "journal-article",
		title: "Spacing & memory: 100% {better}",
		author: [{ family: "Cepeda", given: "N." }, { family: "Rohrer", given: "D." }],
		issued: { "date-parts": [[2006, 5]] },
		"container-title": "Psychological Bulletin",
		volume: "132",
		issue: "3",
		page: "354-380",
		DOI: "10.1000/good",
	},
	"10.1000/retracted": {
		type: "journal-article",
		title: "RETRACTED: A bad study",
		author: [{ family: "Wakefield", given: "A." }],
		issued: { "date-parts": [[1998]] },
		"container-title": "The Lancet",
		DOI: "10.1000/retracted",
	},
	"10.1000/hostile": {
		type: "journal-article",
		title: "Normal​ title [[Secret note]] <script>alert(1)</script>\n---\ninjected: true",
		author: [{ family: "Evil‮", given: "E." }],
		issued: { "date-parts": [[2020]] },
		DOI: "10.1000/hostile",
	},
	"10.48550/arXiv.1706.03762": {
		type: "article",
		title: "Attention Is All You Need",
		author: [{ family: "Vaswani", given: "Ashish" }],
		issued: { "date-parts": [[2017]] },
		DOI: "10.48550/arXiv.1706.03762",
	},
};

let server;
let env;
const requests = [];
/** Switches the tests flip: checks that fail, and DOIs retracted after they were added. */
const mock = { failChecks: false, retractedNow: new Set() };
Object.assign(RECORDS, {
	"10.1000/later": { type: "journal-article", title: "Fine at first", author: [{ family: "Later", given: "L." }], issued: { "date-parts": [[2019]] }, DOI: "10.1000/later" },
	"10.1000/a#b": { type: "journal-article", title: "Hash in the suffix", author: [{ family: "Hash", given: "H." }], issued: { "date-parts": [[2018]] }, DOI: "10.1000/a#b" },
	"10.1000/escapes": {
		type: "journal-article",
		title: "Outcomes for n<10 versus n>50 cohorts with a back\\slash and \\[Full text\\](https://evil.example.net/p.pdf)",
		author: [{ family: "Esc", given: "E." }],
		issued: { "date-parts": [[2021]] },
		DOI: "10.1000/escapes",
	},
	"10.1000/alias": { type: "journal-article", title: "Alias target", author: [{ family: "Alias", given: "A." }], issued: { "date-parts": [[2017]] }, DOI: "10.9999/someone-else" },
});

before(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		requests.push(url.pathname + url.search);
		const json = (status, body) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		if (url.pathname === "/doi/10.1000/landing-only") {
			res.writeHead(200, { "content-type": "text/html" });
			return res.end("<html>publisher landing page</html>");
		}
		if (url.pathname.startsWith("/doi/")) {
			const doi = decodeURIComponent(url.pathname.slice(5));
			const record = RECORDS[doi];
			if (!record) return json(404, { error: "not found" });
			if ((req.headers.accept ?? "").startsWith("text/x-bibliography")) {
				res.writeHead(200, { "content-type": "text/plain" });
				return res.end(`${record.author[0].family} (${record.issued["date-parts"][0][0]}). ${record.title}.`);
			}
			return json(200, record);
		}
		if (url.pathname.startsWith("/openalex/works/doi:")) {
			if (mock.failChecks) return json(503, {});
			const doi = decodeURIComponent(url.pathname.slice("/openalex/works/doi:".length));
			if (!RECORDS[doi]) return json(404, {});
			return json(200, { is_retracted: false, cited_by_count: 42, open_access: { oa_url: "https://example.org/files/My%20Paper.pdf" } });
		}
		if (url.pathname === "/crossref/works") {
			if (mock.failChecks) return json(429, {});
			const doi = (url.searchParams.get("filter") ?? "").replace(/^updates:/, "");
			const retracted = doi === "10.1000/retracted" || mock.retractedNow.has(doi);
			const items = retracted ? [{ DOI: "10.1000/notice", "update-to": [{ type: "retraction", DOI: doi }] }] : [];
			return json(200, { message: { items } });
		}
		json(404, {});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	env = {
		HOME: join(root, "home"),
		PATH: dirname(process.execPath),
		NO_COLOR: "1",
		TABKYRA_LIBRARY_DIR: join(root, "lib"),
		TABKYRA_DOI_BASE: `${base}/doi`,
		TABKYRA_OPENALEX_BASE: `${base}/openalex`,
		TABKYRA_CROSSREF_BASE: `${base}/crossref`,
	};
	mkdirSync(env.HOME, { recursive: true });
});

after(() => {
	server?.close();
	rmSync(root, { recursive: true, force: true });
});

// Async: the stand-in server runs in this process, so a blocking spawn would starve it.
function lib(...args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cli, "library", ...args], { env });
		let out = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			out += d;
		});
		child.on("close", (code) => resolve({ code, out }));
	});
}

function items() {
	return JSON.parse(readFileSync(join(env.TABKYRA_LIBRARY_DIR, "library.json"), "utf8")).items;
}

test("add verifies a DOI against the registry, OpenAlex and Crossref, then saves it", async () => {
	const r = await lib("add", "https://doi.org/10.1000/good", "--quote", "spacing helps", "--location", "p. 360", "--tag", "memory");
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /verified by doi\.org, openalex, crossref-updates; cited by 42/);
	const [item] = items();
	assert.equal(item.id, "cepeda2006spacing");
	assert.equal(item.type, "article-journal", "Crossref's journal-article maps to CSL article-journal");
	assert.equal(item.tabkyra.verified.retracted, false);
	assert.deepEqual(item.tabkyra.quote, { text: "spacing helps", location: "p. 360" });
	assert.equal((await lib("add", "10.1000/good")).out.startsWith("Updated"), true, "adding twice updates, never duplicates");
	assert.equal(items().length, 1);
});

test("a retracted source is saved, flagged, exits 3 and cites as [RETRACTED]", async () => {
	const r = await lib("add", "doi:10.1000/retracted");
	assert.equal(r.code, 3, r.out);
	assert.match(r.out, /notice: retraction 10\.1000\/notice/);
	assert.match(r.out, /RETRACTED: don't cite this as support/);
	const item = items().find((i) => i.DOI === "10.1000/retracted");
	assert.equal(item.id, "wakefield1998bad", "the RETRACTED: prefix doesn't become the citekey");
	assert.match((await lib("cite", item.id)).out, /^\[RETRACTED\]/);
	assert.match((await lib("export", "--format", "bibtex")).out, /note = \{RETRACTED\}/);
});

test("an unregistered DOI and a non-identifier are refused", async () => {
	const missing = await lib("add", "10.1000/made-up");
	assert.equal(missing.code, 1, missing.out);
	assert.match(missing.out, /not registered/);
	const bad = await lib("add", "https://example.com/some-article");
	assert.equal(bad.code, 1, bad.out);
	assert.match(bad.out, /not a DOI/);
	assert.equal((await lib("bogus")).code, 2);
});

test("an arXiv id resolves through its DataCite DOI", async () => {
	assert.equal((await lib("add", "arXiv:1706.03762v5")).code, 0);
	assert.ok(requests.some((p) => p.startsWith("/doi/10.48550/arXiv.1706.03762")));
});

test("exports escape for each format", async () => {
	const bib = (await lib("export", "--format", "bibtex")).out;
	assert.match(bib, /@article\{cepeda2006spacing,/);
	assert.match(bib, /title = \{Spacing \\& memory: 100\\% \\\{better\\\}\}/);
	assert.match(bib, /pages = \{354--380\}/);
	const ris = (await lib("export", "--format", "ris")).out;
	assert.match(ris, /^TY {2}- JOUR$/m);
	assert.match(ris, /^SP {2}- 354$/m);
	assert.match(ris, /^EP {2}- 380$/m);
	const csl = JSON.parse((await lib("export", "--format", "csl")).out);
	assert.ok(csl.every((i) => !("tabkyra" in i)), "CSL-JSON carries no Tabkyra fields");
	assert.equal((await lib("export", "--format", "docx")).code, 1);
});

test("hostile metadata loses hidden text and can't inject Markdown, HTML or YAML into notes", async () => {
	assert.equal((await lib("add", "10.1000/hostile")).code, 0);
	const item = items().find((i) => i.DOI === "10.1000/hostile");
	assert.doesNotMatch(item.title, /[​‮\n]|<script/);
	const vault = join(root, "vault");
	mkdirSync(vault);
	const r = await lib("obsidian", vault);
	assert.equal(r.code, 0, r.out);
	const note = readFileSync(join(vault, "Sources", `${item.id}.md`), "utf8");
	const front = note.split("\n---\n")[0];
	assert.doesNotMatch(front, /^injected:/m, "a title can't add a frontmatter key");
	assert.doesNotMatch(note, /(?<!\\)\[\[/, "no live wikilink from fetched text");
	assert.match(note, /\\\[\\\[Secret note\\\]\\\]/);
	const retracted = readFileSync(join(vault, "Sources", "wakefield1998bad.md"), "utf8");
	assert.match(retracted, /\[!warning\] Retracted/);
	assert.match(retracted, /^retracted: true$/m);
});

test("obsidian refuses a folder outside the vault, including through a symlink", async () => {
	const vault = join(root, "vault2");
	mkdirSync(vault);
	assert.equal((await lib("obsidian", vault, "--folder", "../escape")).code, 1);
	const outside = join(root, "outside");
	mkdirSync(outside);
	symlinkSync(outside, join(vault, "Linked"));
	const r = await lib("obsidian", vault, "--folder", "Linked");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /outside the vault/);
	assert.deepEqual(readdirSync(outside), []);
	assert.equal(existsSync(join(root, "escape")), false);
});

test("search, remove and the MCP tools agree with the CLI", async () => {
	assert.match((await lib("search", "spacing")).out, /cepeda2006spacing/);
	assert.equal((await lib("search", "nothing-matches-this")).code, 1);
	const mcp = new Client({ name: "tabkyra-library-test", version: "0.0.0" });
	await mcp.connect(
		new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: { ...env, TABKYRA_SOCKET_DIR: join(root, "sock") }, stderr: "ignore" }),
	);
	try {
		const found = await mcp.callTool({ name: "library_search", arguments: { query: "attention" } });
		assert.match(found.content[0].text, /vaswani2017attention/);
		const cited = await mcp.callTool({ name: "library_cite", arguments: { citekey: "cepeda2006spacing" } });
		assert.match(cited.content[0].text, /Cepeda \(2006\)/);
		const refused = await mcp.callTool({ name: "library_add", arguments: { id: "10.1000/made-up" } });
		assert.equal(refused.isError, true);
		assert.match(refused.content[0].text, /not registered/);
	} finally {
		await mcp.close();
	}
	assert.equal((await lib("remove", "vaswani2017attention")).code, 0);
	assert.equal((await lib("remove", "vaswani2017attention")).code, 1);
});

test("failed retraction checks are reported as incomplete, and never clear a recorded retraction", async () => {
	mock.failChecks = true;
	try {
		const r = await lib("add", "10.1000/later");
		assert.equal(r.code, 4, r.out);
		assert.match(r.out, /Retraction check incomplete/);
		assert.equal(items().find((i) => i.DOI === "10.1000/later").tabkyra.verified.complete, false);
		const wakefield = items().find((i) => i.DOI === "10.1000/retracted").id;
		const v = await lib("verify", wakefield);
		assert.equal(v.code, 3, v.out);
		assert.equal(items().find((i) => i.id === wakefield).tabkyra.verified.retracted, true, "an incomplete re-check keeps the retraction");
	} finally {
		mock.failChecks = false;
	}
});

test("adding a source again re-checks it, so a later retraction is caught", async () => {
	assert.equal((await lib("add", "10.1000/later")).code, 0);
	mock.retractedNow.add("10.1000/later");
	try {
		const r = await lib("add", "10.1000/later");
		assert.equal(r.code, 3, r.out);
	} finally {
		mock.retractedNow.delete("10.1000/later");
	}
});

test("parallel adds both land", async () => {
	await Promise.all([lib("add", "10.1000/a#b"), lib("add", "10.1000/escapes")]);
	const dois = items().map((i) => i.DOI);
	assert.ok(dois.includes("10.1000/a#b") && dois.includes("10.1000/escapes"), dois.join(", "));
	assert.ok(requests.some((p) => p.startsWith("/doi/10.1000/a%23b")), "a # in the suffix is encoded, not cut off");
});

test("metadata keeps comparison signs, and every format escapes it correctly", async () => {
	const item = items().find((i) => i.DOI === "10.1000/escapes");
	assert.match(item.title, /n<10 versus n>50/);
	const bib = (await lib("export", "--format", "bibtex")).out;
	assert.match(bib, /back\\textbackslash\{\}slash/);
	assert.doesNotMatch(bib, /textbackslash\\\{/);
	const csl = JSON.parse((await lib("export", "--format", "csl")).out);
	assert.equal(csl.find((i) => i.DOI === "10.1000/retracted").note, "RETRACTED");
	const vault = join(root, "vault-esc");
	mkdirSync(vault);
	assert.equal((await lib("obsidian", vault)).code, 0);
	const note = readFileSync(join(vault, "Sources", `${item.id}.md`), "utf8");
	assert.doesNotMatch(note, /(?<!\\)\[Full text(?<!\\)\]\(/, "no live link from fetched text");
	assert.match(readFileSync(join(vault, "Sources", "cepeda2006spacing.md"), "utf8"), /My%20Paper\.pdf/, "an encoded URL isn't encoded twice");
});

test("the requested DOI is the identity, and an agency without metadata isn't called made up", async () => {
	assert.equal((await lib("add", "10.1000/alias")).code, 0);
	assert.ok(items().some((i) => i.DOI === "10.1000/alias") && !items().some((i) => i.DOI === "10.9999/someone-else"));
	const r = await lib("add", "10.1000/landing-only");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /registered, but its agency returned no citation metadata/);
	assert.doesNotMatch(r.out, /made up/);
});

test("verify reports keys that match nothing", async () => {
	const r = await lib("verify", "nosuchkey2000");
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /No source with key nosuchkey2000/);
});

test("obsidian never writes through a link, never makes folders outside, and keeps edited notes", async () => {
	const vault = join(root, "vault-links");
	mkdirSync(join(vault, "Sources"), { recursive: true });
	const target = join(root, "planted-target.txt");
	symlinkSync(target, join(vault, "Sources", "cepeda2006spacing.md"));
	const outside = join(root, "outside-dir");
	mkdirSync(outside);
	symlinkSync(outside, join(vault, "Linked"));
	assert.equal((await lib("obsidian", vault, "--folder", "Linked/NewFolder")).code, 1);
	assert.deepEqual(readdirSync(outside), [], "nothing created through the link");
	const r = await lib("obsidian", vault);
	assert.equal(r.code, 0, r.out);
	assert.equal(existsSync(target), false, "a dangling link's target is never created");
	const mine = join(vault, "Sources", "wakefield1998bad.md");
	writeFileSync(mine, `${readFileSync(mine, "utf8")}\nMy own notes.\n`);
	const again = await lib("obsidian", vault);
	assert.match(again.out, /kept .*wakefield1998bad\.md/);
	assert.match(readFileSync(mine, "utf8"), /My own notes\./);
});
