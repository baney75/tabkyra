// The skill router's regression suite (docs/skill-platform.md). `tabkyra skill eval` runs
// skills-eval/router-cases.jsonl through the router and checks every gate: top-1 accuracy,
// false invokes on "none" cases, cases per skill, p95 latency and the committed baseline.
// The cases file is shared: other skills append their own cases, so the runner must take
// extra cases, including cases for a skill that isn't bundled yet.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const repo = join(here, "..", "..");
const casesFile = join(repo, "skills-eval", "router-cases.jsonl");
const catalog = readFileSync(join(here, "..", "src", "skills-catalog.ts"), "utf8");
const bundled = [...catalog.matchAll(/\["([a-z0-9-]+)", [A-Z_]+\]/g)].map((m) => m[1]);
const root = mkdtempSync(join(tmpdir(), "tabkyra-router-"));
after(() => rmSync(root, { recursive: true, force: true }));

function run(args, { home = mkdtempSync(join(root, "home-")), cwd = repo } = {}) {
	const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", env: { HOME: home, PATH: dirname(process.execPath), NO_COLOR: "1" } });
	return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

function evalJson(args = [], options) {
	const r = run(["skill", "eval", "--json", ...args], options);
	return { code: r.code, report: JSON.parse(r.stdout), out: r.out };
}

test("the router meets every gate on the shared cases", (t) => {
	const { code, report, out } = evalJson();
	const pct = (x) => `${(x * 100).toFixed(1)}%`;
	t.diagnostic(`top-1 ${pct(report.top1)} over ${report.positives} cases; false invokes ${pct(report.falseInvoke)} of ${report.negatives}`);
	t.diagnostic(`index build ${report.speed.buildMs} ms; p50 ${report.speed.p50Ms} ms, p95 ${report.speed.p95Ms} ms, max ${report.speed.maxMs} ms over ${report.speed.matches} matches`);
	for (const m of report.misses) t.diagnostic(`miss: expected ${m.expected}, got ${m.got}: ${m.task}`);
	assert.ok(report.top1 >= 0.9, `top-1 ${report.top1}`);
	assert.ok(report.falseInvoke <= 0.05, `false invokes ${report.falseInvoke}`);
	for (const name of bundled) assert.ok(report.perSkill[name].cases >= 8, `${name} has ${report.perSkill[name].cases} cases; it needs 8`);
	assert.ok(report.speed.p95Ms < 10, `p95 ${report.speed.p95Ms} ms`);
	const baseline = report.gates.find((g) => g.gate === "baseline");
	assert.ok(baseline.ok, baseline.detail);
	assert.equal(code, 0, out);
	assert.equal(report.ok, true);
});

test("the cases file is valid JSONL, covers every skill and has none cases", () => {
	const lines = readFileSync(casesFile, "utf8").split("\n").filter((l) => l.trim());
	assert.ok(lines.length >= 200, `${lines.length} cases`);
	const counts = new Map();
	for (const line of lines) {
		const c = JSON.parse(line);
		assert.equal(typeof c.task, "string");
		assert.match(c.skill, /^(none|[a-z0-9]+(-[a-z0-9]+)*)$/);
		counts.set(c.skill, (counts.get(c.skill) ?? 0) + 1);
	}
	for (const name of bundled) assert.ok((counts.get(name) ?? 0) >= 10, `${name} has ${counts.get(name) ?? 0} cases`);
	assert.ok((counts.get("none") ?? 0) >= 20, "at least 20 none cases");
});

function casesDir(extra = "", baseline) {
	const dir = mkdtempSync(join(root, "cases-"));
	writeFileSync(join(dir, "router-cases.jsonl"), readFileSync(casesFile, "utf8") + extra);
	if (baseline === undefined) copyFileSync(join(repo, "skills-eval", "baseline.json"), join(dir, "baseline.json"));
	else if (baseline !== null) writeFileSync(join(dir, "baseline.json"), baseline);
	return dir;
}

test("extra cases, and cases for a skill that isn't bundled yet, don't break the run", () => {
	const dir = casesDir('\n{"task": "Plan my sprint board", "skill": "future-skill"}\n\n{"task": "Find studies on naps", "skill": "academic-research"}\n');
	const { code, report } = evalJson(["--cases", join(dir, "router-cases.jsonl")]);
	assert.deepEqual(
		report.skipped.map((s) => s.skill),
		["future-skill"],
	);
	assert.equal(report.perSkill["future-skill"], undefined);
	assert.equal(code, 0);
});

test("a malformed case is an error with its line number", () => {
	const dir = casesDir('{"task": "no skill field"}\n');
	const r = run(["skill", "eval", "--cases", join(dir, "router-cases.jsonl")]);
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /line \d+ needs/);
});

test("a skill more than 10 points below its baseline fails, and --update-baseline resets it", () => {
	const current = evalJson().report;
	const weak = Object.entries(current.perSkill).find(([name, s]) => name !== "none" && s.accuracy <= 0.85)?.[0];
	assert.ok(weak, "some skill below 85% to test with");
	const raised = JSON.stringify({ accuracy: { ...JSON.parse(readFileSync(join(repo, "skills-eval", "baseline.json"), "utf8")).accuracy, [weak]: 1 } });
	const dir = casesDir("", raised);
	const failed = evalJson(["--cases", join(dir, "router-cases.jsonl")]);
	assert.equal(failed.code, 1);
	const gate = failed.report.gates.find((g) => g.gate === "baseline");
	assert.equal(gate.ok, false);
	assert.match(gate.detail, new RegExp(weak));
	const updated = run(["skill", "eval", "--update-baseline", "--cases", join(dir, "router-cases.jsonl")]);
	assert.equal(updated.code, 0, updated.out);
	assert.equal(JSON.parse(readFileSync(join(dir, "baseline.json"), "utf8")).accuracy[weak], current.perSkill[weak].accuracy);
});

test("a missing baseline fails the run", () => {
	const dir = casesDir("", null);
	const { code, report } = evalJson(["--cases", join(dir, "router-cases.jsonl")]);
	assert.equal(code, 1);
	assert.match(report.gates.find((g) => g.gate === "baseline").detail, /no baseline/);
});

test("eval finds the cases from a subfolder, and says how to point at them from elsewhere", () => {
	assert.equal(run(["skill", "eval"], { cwd: join(repo, "cli") }).code, 0);
	const away = run(["skill", "eval"], { cwd: root });
	assert.equal(away.code, 1, away.out);
	assert.match(away.out, /--cases/);
});

test("skill match ranks skills, says none, and takes --json and --top", () => {
	const best = run(["skill", "match", "find peer-reviewed studies on sleep and memory"]);
	assert.equal(best.code, 0, best.out);
	assert.match(best.stdout, /^academic-research\s/);
	const json = JSON.parse(run(["skill", "match", "--json", "--top", "2", "/rsi", "learn", "from", "this"]).stdout);
	assert.ok(json.length >= 1 && json.length <= 2, JSON.stringify(json));
	assert.equal(json[0].name, "rsi");
	assert.equal(typeof json[0].score, "number");
	assert.match(json[0].description, /\.$/);
	assert.deepEqual(JSON.parse(run(["skill", "match", "--json", "write a haiku about autumn leaves"]).stdout).map((m) => m.name), ["none"]);
	assert.match(run(["skill", "match", "convert 72 degrees Fahrenheit to Celsius"]).out, /none/);
	assert.equal(JSON.parse(run(["skill", "match", "--top=1", "--json", "osint background check on a contractor"]).stdout).length, 1);
	assert.equal(run(["skill", "match", "--top", "0", "x"]).code, 1);
	assert.equal(run(["skill", "match", "--top"]).code, 2);
	assert.equal(run(["skill", "match"]).code, 1);
});

test("a skill named as the object of the task doesn't count for itself", () => {
	const name = (task) => JSON.parse(run(["skill", "match", "--json", task]).stdout)[0].name;
	assert.equal(name("/fix news-research"), "fix");
	assert.equal(name("The osint skill gave my small model a bad result, repair it"), "fix");
});

test("skill match routes to a skill the user applied locally", () => {
	const home = mkdtempSync(join(root, "local-"));
	const dir = join(home, "drafts", "invoice-triage");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: invoice-triage\ndescription: Sort supplier invoices into paid, due and disputed. Use when the user asks to triage, sort or reconcile supplier invoices.\n---\n# Invoice triage\n\n## When to use\n\n- The user has a pile of supplier invoices to sort.\n\n## Steps\n\n1. **List them.** Read each invoice.\n2. **Sort them.** Paid, due or disputed.\n\n## Done when\n\n- Every invoice has a status.\n`,
	);
	const applied = run(["skill", "apply", dir, "--yes"], { home });
	assert.equal(applied.code, 0, applied.out);
	assert.equal(JSON.parse(run(["skill", "match", "--json", "triage my supplier invoices"], { home }).stdout)[0].name, "invoice-triage");
	assert.equal(run(["skill", "revert", "invoice-triage"], { home }).code, 0);
	assert.notEqual(JSON.parse(run(["skill", "match", "--json", "triage my supplier invoices"], { home }).stdout)[0].name, "invoice-triage");
});
