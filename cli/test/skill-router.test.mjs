// The skill router's regression suite (docs/skill-platform.md). `tabkyra skill eval` runs
// skills-eval/router-cases.jsonl through the router and checks every gate: top-1 accuracy,
// false invokes on "none" cases, cases per skill, p95 latency, the committed baseline, and
// the floors on skills-eval/router-heldout.jsonl, which the scorer was never tuned on.
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
const heldoutFile = join(repo, "skills-eval", "router-heldout.jsonl");
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
	t.diagnostic(`held-out: top-1 ${pct(report.heldout.top1)} over ${report.heldout.positives} cases; false invokes ${pct(report.heldout.falseInvoke)} of ${report.heldout.negatives}`);
	t.diagnostic(`index build ${report.speed.buildMs} ms; p50 ${report.speed.p50Ms} ms, p95 ${report.speed.p95Ms} ms, max ${report.speed.maxMs} ms over ${report.speed.matches} matches`);
	for (const m of report.misses) t.diagnostic(`miss: expected ${m.expected}, got ${m.got}: ${m.task}`);
	assert.ok(report.top1 >= 0.9, `top-1 ${report.top1}`);
	assert.ok(report.falseInvoke <= 0.05, `false invokes ${report.falseInvoke}`);
	for (const name of bundled) assert.ok(report.perSkill[name].cases >= report.thresholds.MIN_CASES, `${name} has ${report.perSkill[name].cases} cases; it needs ${report.thresholds.MIN_CASES}`);
	assert.ok(report.heldout.top1 >= report.thresholds.HELDOUT_TOP1_MIN, `held-out top-1 ${report.heldout.top1}`);
	assert.ok(report.heldout.falseInvoke <= report.thresholds.HELDOUT_FALSE_INVOKE_MAX, `held-out false invokes ${report.heldout.falseInvoke}`);
	assert.ok(report.speed.p95Ms < 10, `p95 ${report.speed.p95Ms} ms`);
	const baseline = report.gates.find((g) => g.gate === "baseline");
	assert.ok(baseline.ok, baseline.detail);
	assert.equal(code, 0, out);
	assert.equal(report.ok, true);
});

test("the case files are valid JSONL, cover every skill and have none cases", () => {
	const { thresholds } = evalJson().report;
	const counts = (file) => {
		const out = new Map();
		for (const line of readFileSync(file, "utf8").split("\n").filter((l) => l.trim())) {
			const c = JSON.parse(line);
			assert.equal(typeof c.task, "string");
			assert.match(c.skill, /^(none|[a-z0-9]+(-[a-z0-9]+)*)$/);
			out.set(c.skill, (out.get(c.skill) ?? 0) + 1);
		}
		return out;
	};
	const main = counts(casesFile);
	assert.ok([...main.values()].reduce((a, b) => a + b, 0) >= 200, "200 or more cases");
	for (const name of bundled) assert.ok((main.get(name) ?? 0) >= thresholds.MIN_CASES, `${name} has ${main.get(name) ?? 0} cases`);
	assert.ok((main.get("none") ?? 0) >= 20, "at least 20 none cases");
	const held = counts(heldoutFile);
	assert.ok([...held.values()].reduce((a, b) => a + b, 0) >= 40, "40 or more held-out cases");
	for (const name of [...bundled, "none"]) assert.ok((held.get(name) ?? 0) >= 1, `no held-out case for ${name}`);
});

function casesDir(extra = "", baseline, { heldout = true } = {}) {
	const dir = mkdtempSync(join(root, "cases-"));
	writeFileSync(join(dir, "router-cases.jsonl"), readFileSync(casesFile, "utf8") + extra);
	if (heldout) copyFileSync(heldoutFile, join(dir, "router-heldout.jsonl"));
	if (baseline === undefined) copyFileSync(join(repo, "skills-eval", "baseline.json"), join(dir, "baseline.json"));
	else if (baseline !== null) writeFileSync(join(dir, "baseline.json"), baseline);
	return dir;
}

test("extra cases, and cases for a skill that isn't bundled yet, don't break the run", () => {
	const dir = casesDir('\n{"task": "Plan my sprint board", "skill": "future-skill"}\n\n{"task": "/autoresearch the history of tea", "skill": "autoresearch"}\n');
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
	assert.equal(JSON.parse(readFileSync(join(dir, "baseline.json"), "utf8")).accuracy[weak], Math.round(current.perSkill[weak].accuracy * 10000) / 10000);
});

test("a missing baseline, or one without a valid value for every skill, fails the run", () => {
	const dir = casesDir("", null);
	const { code, report } = evalJson(["--cases", join(dir, "router-cases.jsonl")]);
	assert.equal(code, 1);
	assert.match(report.gates.find((g) => g.gate === "baseline").detail, /no baseline/);
	const full = JSON.parse(readFileSync(join(repo, "skills-eval", "baseline.json"), "utf8")).accuracy;
	for (const accuracy of [{}, { ...full, dorks: undefined }, { ...full, dorks: 1.5 }, { ...full, dorks: -0.1 }, { ...full, dorks: "1" }, { ...full, none: null }]) {
		const bad = casesDir("", JSON.stringify({ accuracy }));
		const r = evalJson(["--cases", join(bad, "router-cases.jsonl")]);
		assert.equal(r.code, 1, JSON.stringify(accuracy));
		assert.match(r.report.gates.find((g) => g.gate === "baseline").detail, /no valid baseline/);
	}
});

test("held-out cases are reported apart from the tuned set, and a missing held-out file fails", () => {
	const { report } = evalJson();
	assert.ok(report.heldout.cases >= 40);
	assert.ok(report.gates.find((g) => g.gate === "held-out top-1").ok);
	const dir = casesDir("", undefined, { heldout: false });
	const r = evalJson(["--cases", join(dir, "router-cases.jsonl")]);
	assert.equal(r.code, 1);
	assert.match(r.report.gates.find((g) => g.gate === "held-out top-1").detail, /no router-heldout/);
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

test("phrases made only of common words can't make a match on their own", () => {
	const name = (task) => JSON.parse(run(["skill", "match", "--json", task]).stdout)[0].name;
	assert.equal(name("What's new in Python 3.13?"), "none");
	assert.equal(name("What's going on with my Docker build?"), "none");
	assert.equal(name("Fix the artifact upload in my GitHub Actions workflow"), "none");
});

test("a quoted phrase in an excluded sentence never counts", () => {
	const home = mkdtempSync(join(root, "excluded-"));
	const dir = join(home, "drafts", "receipt-filer");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: receipt-filer\ndescription: File receipts into monthly folders. Not for "invoice triage". Use when the user asks to file or sort receipts.\n---\n# Receipt filer\n\n## When to use\n\n- The user has receipts to file.\n\nNot for "supplier statements".\n\n## Steps\n\n1. **List them.** Read each receipt.\n2. **File them.** One folder per month.\n\n## Done when\n\n- Every receipt is filed.\n`,
	);
	assert.equal(run(["skill", "apply", dir, "--yes"], { home }).code, 0);
	const names = (task) => JSON.parse(run(["skill", "match", "--json", "--top", "5", task], { home }).stdout).map((m) => m.name);
	assert.ok(names("file my receipts into monthly folders").includes("receipt-filer"), "the fixture routes at all");
	assert.ok(!names("invoice triage").includes("receipt-filer"));
	assert.ok(!names("supplier statements").includes("receipt-filer"));
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

/** A fake pull-request checkout: skills-eval files and cli/src/skill-eval.ts, each changeable. */
const EVAL_FILES = ["router-cases.jsonl", "router-heldout.jsonl", "baseline.json", "accepted-drops.json"];
const repoBaseline = () => JSON.parse(readFileSync(join(repo, "skills-eval", "baseline.json"), "utf8")).accuracy;
const dropsFile = (...drops) => JSON.stringify({ drops });

function headCheckout({ evalSource = readFileSync(join(here, "..", "src", "skill-eval.ts"), "utf8"), baseline, drops } = {}) {
	const dir = mkdtempSync(join(root, "head-"));
	mkdirSync(join(dir, "skills-eval"));
	mkdirSync(join(dir, "cli", "src"), { recursive: true });
	for (const f of EVAL_FILES) copyFileSync(join(repo, "skills-eval", f), join(dir, "skills-eval", f));
	if (baseline) writeFileSync(join(dir, "skills-eval", "baseline.json"), baseline);
	if (drops) writeFileSync(join(dir, "skills-eval", "accepted-drops.json"), drops);
	if (evalSource !== null) writeFileSync(join(dir, "cli", "src", "skill-eval.ts"), evalSource);
	return dir;
}

/** A fake base-branch checkout with this branch's skills-eval files, optionally changed. */
function baseCheckout(change = {}) {
	const dir = mkdtempSync(join(root, "base-"));
	mkdirSync(join(dir, "skills-eval"));
	for (const f of EVAL_FILES) writeFileSync(join(dir, "skills-eval", f), change[f] ?? readFileSync(join(repo, "skills-eval", f), "utf8"));
	return dir;
}

function baseRun(head, base) {
	const r = run(["skill", "eval", "--json", "--base", base, "--cases", join(head, "skills-eval", "router-cases.jsonl")]);
	const out = JSON.parse(r.stdout);
	return { code: r.code, skills: out.skills, gates: Object.fromEntries(out.gates.map((g) => [g.gate, g])) };
}

test("--base passes a pull request that keeps the base branch's cases, baseline and thresholds", () => {
	const r = baseRun(headCheckout(), baseCheckout());
	assert.equal(r.code, 0, JSON.stringify(r.gates));
	for (const gate of ["base cases kept", "base baseline", "base thresholds", "base-code eval"]) assert.ok(r.gates[gate]?.ok, gate);
	assert.equal(r.skills, bundled.length, "every bundled skill is indexed");
});

test("--base fails a pull request that drops a base case", () => {
	const r = baseRun(headCheckout(), baseCheckout({ "router-heldout.jsonl": `${readFileSync(heldoutFile, "utf8")}{"task": "A case the pull request deleted", "skill": "none"}\n` }));
	assert.equal(r.code, 1);
	assert.equal(r.gates["base cases kept"].ok, false);
	assert.match(r.gates["base cases kept"].detail, /A case the pull request deleted/);
});

test("--base: the baseline only ratchets up; any lower value needs an accepted drop the pull request adds", () => {
	const accuracy = repoBaseline();
	const lowered = (value, drops, base = {}) => baseRun(headCheckout({ baseline: JSON.stringify({ accuracy: { ...accuracy, dorks: value } }), drops }), baseCheckout(base));
	// Any drop fails, even a small one, so small steps can't add up across pull requests.
	for (const value of [0.5, 0.95]) {
		const r = lowered(value);
		assert.equal(r.code, 1, String(value));
		assert.match(r.gates["base baseline"].detail, new RegExp(`dorks ${(value * 100).toFixed(1)}% \\(base 100\\.0%\\)`));
	}
	assert.match(lowered(undefined).gates["base baseline"].detail, /dorks missing/);
	// An entry for the exact new value, with a reason, accepts it.
	const ok = lowered(0.95, dropsFile({ skill: "dorks", value: 0.95, reason: "new skills share its search words" }));
	assert.equal(ok.gates["base baseline"].ok, true, ok.gates["base baseline"].detail);
	assert.match(ok.gates["base baseline"].detail, /accepted drops: dorks 95\.0%/);
	// Not for another value, and not from an entry the base branch already had.
	assert.equal(lowered(0.9, dropsFile({ skill: "dorks", value: 0.95, reason: "x" })).gates["base baseline"].ok, false);
	const stale = dropsFile({ skill: "dorks", value: 0.95, reason: "accepted long ago" });
	assert.equal(lowered(0.95, stale, { "accepted-drops.json": stale }).gates["base baseline"].ok, false);
	// Malformed entries are refused.
	for (const bad of [dropsFile({ skill: "dorks", value: 0.95 }), dropsFile({ skill: "dorks", value: 2, reason: "x" }), "{}"]) {
		const r = run(["skill", "eval", "--json", "--base", baseCheckout(), "--cases", join(headCheckout({ drops: bad }), "skills-eval", "router-cases.jsonl")]);
		assert.equal(r.code, 1);
		assert.match(r.out, /accepted-drops\.json/);
	}
	// Raising a value is always fine.
	assert.ok(baseRun(headCheckout(), baseCheckout({ "baseline.json": JSON.stringify({ accuracy: { ...accuracy, dorks: 0.9 } }) })).gates["base baseline"].ok);
});

test("--base fails a pull request that loosens a threshold or hides them", () => {
	const source = readFileSync(join(here, "..", "src", "skill-eval.ts"), "utf8");
	for (const [from, to] of [
		["export const TOP1_MIN = 0.9;", "export const TOP1_MIN = 0.8;"],
		["export const FALSE_INVOKE_MAX = 0.05;", "export const FALSE_INVOKE_MAX = 0.2;"],
		["export const MIN_CASES = 8;", "export const MIN_CASES = 2;"],
		["export const REGRESSION_POINTS = 10;", "export const REGRESSION_POINTS = 50;"],
		["export const HELDOUT_TOP1_MIN = 0.8;", "export const HELDOUT_TOP1_MIN = 0.5;"],
	]) {
		assert.ok(source.includes(from), from);
		const r = baseRun(headCheckout({ evalSource: source.replace(from, to) }), baseCheckout());
		assert.equal(r.code, 1, to);
		assert.match(r.gates["base thresholds"].detail, new RegExp(to.split(" ")[2]));
	}
	const stricter = baseRun(headCheckout({ evalSource: source.replace("export const TOP1_MIN = 0.9;", "export const TOP1_MIN = 0.91;") }), baseCheckout());
	assert.ok(stricter.gates["base thresholds"].ok, "a stricter threshold is fine");
	const hidden = baseRun(headCheckout({ evalSource: null }), baseCheckout());
	assert.equal(hidden.gates["base thresholds"].ok, false);
});

test("--base runs the base code's gates on the pull request's skills, with no tolerance below the base baseline", () => {
	const accuracy = repoBaseline();
	const weak = Object.entries(accuracy).find(([name, v]) => name !== "none" && v <= 0.85)[0];
	const raised = { "baseline.json": JSON.stringify({ accuracy: { ...accuracy, [weak]: Math.min(1, accuracy[weak] + 0.02) } }) };
	const r = baseRun(headCheckout(), baseCheckout(raised));
	assert.equal(r.code, 1);
	assert.equal(r.gates["base-code eval"].ok, false);
	assert.match(r.gates["base-code eval"].detail, new RegExp(`below the baseline: .*${weak}`));
	// The same drop, accepted by the pull request, passes both gates.
	const accepted = baseRun(headCheckout({ drops: dropsFile({ skill: weak, value: accuracy[weak], reason: "measured the same way" }) }), baseCheckout(raised));
	assert.ok(accepted.gates["base-code eval"].ok, accepted.gates["base-code eval"].detail);
	assert.ok(accepted.gates["base baseline"].ok, accepted.gates["base baseline"].detail);
});

test("--base doesn't ask base coverage of a skill the pull request adds", () => {
	// A base branch that never had the weakest skill: no cases, no baseline. The pull request
	// "adds" it. (The weakest, so leaving its cases out doesn't lower top-1 for the rest.)
	const accuracy = repoBaseline();
	const added = Object.entries(accuracy)
		.filter(([name]) => name !== "none")
		.sort((a, b) => a[1] - b[1])[0][0];
	const without = (file) =>
		readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => !l.includes(`"skill": "${added}"`))
			.join("\n");
	const cases = without(casesFile);
	const heldout = without(heldoutFile);
	const { [added]: _dropped, ...rest } = accuracy;
	const r = baseRun(headCheckout(), baseCheckout({ "router-cases.jsonl": cases, "router-heldout.jsonl": heldout, "baseline.json": JSON.stringify({ accuracy: rest }) }));
	assert.ok(r.gates["base-code eval"].ok, r.gates["base-code eval"].detail);
	assert.ok(r.gates["base baseline"].ok, r.gates["base baseline"].detail);
	assert.equal(r.skills, bundled.length, "the new skill is still indexed");
});

test("the catalog script writes exactly the committed catalog from skills/", () => {
	const scratch = mkdtempSync(join(root, "catalog-"));
	mkdirSync(join(scratch, "cli", "src"), { recursive: true });
	mkdirSync(join(scratch, "cli", "scripts"), { recursive: true });
	copyFileSync(join(here, "..", "scripts", "skills-catalog.mjs"), join(scratch, "cli", "scripts", "skills-catalog.mjs"));
	for (const name of bundled) {
		mkdirSync(join(scratch, "skills", name), { recursive: true });
		copyFileSync(join(repo, "skills", name, "SKILL.md"), join(scratch, "skills", name, "SKILL.md"));
	}
	const r = spawnSync(process.execPath, [join(scratch, "cli", "scripts", "skills-catalog.mjs")], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(readFileSync(join(scratch, "cli", "src", "skills-catalog.ts"), "utf8"), catalog);
	// A removed skill drops out of the catalog instead of leaving a broken import.
	rmSync(join(scratch, "skills", "dorks"), { recursive: true });
	mkdirSync(join(scratch, "skills", "new-skill"));
	writeFileSync(join(scratch, "skills", "new-skill", "SKILL.md"), "x");
	spawnSync(process.execPath, [join(scratch, "cli", "scripts", "skills-catalog.mjs")]);
	const regenerated = readFileSync(join(scratch, "cli", "src", "skills-catalog.ts"), "utf8");
	assert.doesNotMatch(regenerated, /dorks/);
	assert.match(regenerated, /import NEW_SKILL from "\.\.\/\.\.\/skills\/new-skill\/SKILL\.md";/);
	assert.match(regenerated, /\["new-skill", NEW_SKILL\]/);
});

test("naming a skill to use routes to it; naming it to change it doesn't", () => {
	const name = (task) => JSON.parse(run(["skill", "match", "--json", task]).stdout)[0].name;
	assert.equal(name("Use the osint skill on the landlord at 12 Elm St"), "osint");
	assert.equal(name("run the dorks skill to find PDFs"), "dorks");
	assert.equal(name("use the tabkyra skill to fill the form"), "tabkyra");
	assert.equal(name("the proton-pass skill, please, for the deploy token"), "proton-pass");
	assert.notEqual(name("Repair the osint skill, it keeps failing on small models"), "osint");
	assert.notEqual(name("Update the dorks skill with a new operator"), "dorks");
});

test("a slash command counts only as the first token, never as part of a path", () => {
	const name = (task) => JSON.parse(run(["skill", "match", "--json", task]).stdout)[0].name;
	assert.equal(name("/rsi"), "rsi");
	assert.equal(name("/autoresearch: what caused the 2008 crisis"), "autoresearch");
	for (const task of ["Copy the build output to /artifacts in the container", "cat /bug/report.txt", "ls /fix", "/fix/old.log is too big", "/rsi.json is missing"]) {
		assert.equal(name(task), "none", task);
	}
});

test("common words alone never make a match, however many add up", () => {
	const home = mkdtempSync(join(root, "common-"));
	// Five skills share the same three words, so none of the words is specific (evidence).
	const words = "quartz, lantern, harbor";
	for (const n of ["one", "two", "three", "four", "five"]) {
		const dir = join(home, "drafts", `shared-${n}`);
		mkdirSync(dir, { recursive: true });
		const extra = n === "one" ? `, quartz, lantern, harbor, quartz, lantern, harbor, zephyr` : "";
		writeFileSync(
			join(dir, "SKILL.md"),
			`---\nname: shared-${n}\ndescription: Sorts ${words}${extra}. Use when the user asks about ${words}${extra}.\n---\n# Shared ${n}\n\n## When to use\n\n- The user asks about ${words}.\n\n## Steps\n\n1. **Sort.** Sort them.\n2. **Check.** Check them.\n\n## Done when\n\n- They are sorted.\n`,
		);
		assert.equal(run(["skill", "apply", dir, "--yes"], { home }).code, 0);
	}
	const top = (task) => JSON.parse(run(["skill", "match", "--json", "--top", "5", task], { home }).stdout).map((m) => m.name);
	assert.deepEqual(top("harbor quartz lantern"), ["none"]);
	// One specific word is enough to make them count.
	assert.equal(top("harbor quartz lantern zephyr")[0], "shared-one");
});
