/**
 * `tabkyra skill eval`: the router's regression suite. Cases live in
 * skills-eval/router-cases.jsonl, one `{"task": "...", "skill": "<name>|none"}` per line,
 * and the per-skill accuracy each release must keep is in skills-eval/baseline.json.
 * skills-eval/router-heldout.jsonl holds cases the scorer was never tuned on; it is the
 * honest estimate of accuracy on new phrasings, and it has lower floors of its own.
 *
 * The gates, all checked by CI (the skill-regression job and cli/test/skill-router.test.mjs):
 * top-1 accuracy over positive cases, the false-invoke rate on "none" cases, at least
 * MIN_CASES cases for every bundled skill, p95 match latency, a baseline value for every
 * bundled skill with none more than REGRESSION_POINTS below it, and the held-out floors.
 * Cases that name a skill the catalog doesn't have are skipped and listed, so cases for a
 * skill can land before or after the skill itself.
 *
 * `--base <checkout>` is run by the base branch's build in CI. It checks that a pull request
 * kept every base case, didn't lower the baseline or loosen a threshold, and that its skills
 * still pass the base gates under the base code, so a pull request can't lower its own bar.
 */

import { performance } from "node:perf_hooks";
import { buildRouterIndex, matchSkills, type RouterSkill } from "./skill-router.ts";

export const TOP1_MIN = 0.9;
export const FALSE_INVOKE_MAX = 0.05;
export const MIN_CASES = 8;
export const P95_MAX_MS = 10;
/** Percentage points a skill's accuracy may fall below its baseline. */
export const REGRESSION_POINTS = 10;
export const HELDOUT_TOP1_MIN = 0.8;
export const HELDOUT_FALSE_INVOKE_MAX = 0.1;
/** Every case is matched this many times for the latency figures. */
const ROUNDS = 5;

/** Each threshold, and which way is stricter: a pull request may only move it that way. */
export const THRESHOLDS = {
	TOP1_MIN: { value: TOP1_MIN, stricter: "higher" },
	FALSE_INVOKE_MAX: { value: FALSE_INVOKE_MAX, stricter: "lower" },
	MIN_CASES: { value: MIN_CASES, stricter: "higher" },
	P95_MAX_MS: { value: P95_MAX_MS, stricter: "lower" },
	REGRESSION_POINTS: { value: REGRESSION_POINTS, stricter: "lower" },
	HELDOUT_TOP1_MIN: { value: HELDOUT_TOP1_MIN, stricter: "higher" },
	HELDOUT_FALSE_INVOKE_MAX: { value: HELDOUT_FALSE_INVOKE_MAX, stricter: "lower" },
} as const;

export interface EvalCase {
	task: string;
	skill: string;
	line: number;
}

export interface Baseline {
	/** Accuracy per skill, a finite number from 0 to 1. "none" is the share of none cases routed to no skill. */
	accuracy: Record<string, number>;
}

export interface Gate {
	gate: string;
	ok: boolean;
	detail: string;
}

interface SetScore {
	cases: number;
	positives: number;
	negatives: number;
	top1: number;
	falseInvoke: number;
	misses: Array<{ task: string; expected: string; got: string }>;
}

export interface EvalReport {
	ok: boolean;
	skills: number;
	cases: number;
	positives: number;
	negatives: number;
	top1: number;
	falseInvoke: number;
	perSkill: Record<string, { cases: number; correct: number; accuracy: number; baseline?: number }>;
	misses: Array<{ task: string; expected: string; got: string }>;
	/** Cases naming a skill the catalog doesn't have; skipped. */
	skipped: Array<{ line: number; skill: string }>;
	/** The held-out cases: never used to tune the scorer. */
	heldout?: SetScore;
	speed: { buildMs: number; p50Ms: number; p95Ms: number; maxMs: number; matches: number };
	thresholds: Record<keyof typeof THRESHOLDS, number>;
	gates: Gate[];
}

export class EvalError extends Error {}

/** Parse JSONL cases; a malformed line is an error with its line number, blank lines are skipped. */
export function parseCases(text: string, file = "router-cases.jsonl"): EvalCase[] {
	const out: EvalCase[] = [];
	text.split("\n").forEach((raw, i) => {
		if (raw.trim() === "") return;
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			throw new EvalError(`${file} line ${i + 1} is not JSON.`);
		}
		const c = value as { task?: unknown; skill?: unknown };
		if (typeof c.task !== "string" || !c.task.trim() || typeof c.skill !== "string" || !/^(none|[a-z0-9]+(-[a-z0-9]+)*)$/.test(c.skill)) {
			throw new EvalError(`${file} line ${i + 1} needs {"task": "...", "skill": "<name>|none"}.`);
		}
		out.push({ task: c.task, skill: c.skill, line: i + 1 });
	});
	return out;
}

/** Only finite values from 0 to 1 count; anything else is as if the skill had no baseline. */
export function parseBaseline(text: string): Baseline {
	const data = JSON.parse(text) as { accuracy?: Record<string, unknown> };
	const accuracy: Record<string, number> = {};
	for (const [name, value] of Object.entries(data.accuracy ?? {})) {
		if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) accuracy[name] = value;
	}
	return { accuracy };
}

export function formatBaseline(report: EvalReport): string {
	const accuracy = Object.fromEntries(
		Object.entries(report.perSkill)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, s]) => [name, Math.round(s.accuracy * 10000) / 10000]),
	);
	return `${JSON.stringify({ accuracy }, null, "\t")}\n`;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Top-1 and false invokes of `cases` that name a known skill or none. */
function scoreSet(match: (task: string) => string, cases: EvalCase[], names: Set<string>): SetScore {
	const usable = cases.filter((c) => c.skill === "none" || names.has(c.skill));
	const misses: SetScore["misses"] = [];
	let correct = 0;
	let falseInvokes = 0;
	for (const c of usable) {
		const got = match(c.task);
		if (got === c.skill) {
			if (c.skill !== "none") correct++;
		} else {
			if (c.skill === "none") falseInvokes++;
			misses.push({ task: c.task, expected: c.skill, got });
		}
	}
	const negatives = usable.filter((c) => c.skill === "none").length;
	const positives = usable.length - negatives;
	return { cases: usable.length, positives, negatives, top1: positives ? round(correct / positives, 4) : 0, falseInvoke: negatives ? round(falseInvokes / negatives, 4) : 0, misses };
}

/** Run every case through a fresh index of `skills` and check each gate. */
export function runEval(skills: RouterSkill[], cases: EvalCase[], baseline?: Baseline, heldout?: EvalCase[]): EvalReport {
	const started = performance.now();
	const index = buildRouterIndex(skills);
	const buildMs = performance.now() - started;
	const names = new Set(skills.map((s) => s.name));
	const usable = cases.filter((c) => c.skill === "none" || names.has(c.skill));
	const skipped = cases.filter((c) => c.skill !== "none" && !names.has(c.skill)).map((c) => ({ line: c.line, skill: c.skill }));
	const top = (task: string) => matchSkills(index, task, 1)[0]?.name ?? "none";

	const perSkill: EvalReport["perSkill"] = {};
	for (const name of [...names, "none"]) perSkill[name] = { cases: 0, correct: 0, accuracy: 0 };
	const misses: EvalReport["misses"] = [];
	const times: number[] = [];
	for (let r = 0; r < ROUNDS; r++) {
		for (const c of usable) {
			const t0 = performance.now();
			const got = top(c.task);
			times.push(performance.now() - t0);
			if (r > 0) continue;
			const entry = perSkill[c.skill];
			entry.cases++;
			if (got === c.skill) entry.correct++;
			else misses.push({ task: c.task, expected: c.skill, got });
		}
	}
	for (const [name, entry] of Object.entries(perSkill)) {
		entry.accuracy = entry.cases ? entry.correct / entry.cases : 0;
		const base = baseline?.accuracy[name];
		if (base !== undefined) entry.baseline = base;
	}
	times.sort((a, b) => a - b);

	const positive = Object.entries(perSkill).filter(([name]) => name !== "none");
	const positives = positive.reduce((n, [, s]) => n + s.cases, 0);
	const top1 = positives ? positive.reduce((n, [, s]) => n + s.correct, 0) / positives : 0;
	const none = perSkill.none;
	const falseInvoke = none.cases ? 1 - none.accuracy : 0;
	const speed = { buildMs: round(buildMs), p50Ms: round(percentile(times, 0.5), 4), p95Ms: round(percentile(times, 0.95), 4), maxMs: round(times.at(-1) ?? 0, 4), matches: times.length };
	const held = heldout ? scoreSet(top, heldout, names) : undefined;

	const tooFew = [...names].filter((n) => perSkill[n].cases < MIN_CASES);
	const regressions = Object.entries(perSkill).filter(([, s]) => s.baseline !== undefined && s.cases > 0 && (s.baseline - s.accuracy) * 100 > REGRESSION_POINTS + 1e-9);
	const unbased = baseline ? [...names, "none"].filter((n) => baseline.accuracy[n] === undefined) : [];
	const gates: Gate[] = [
		{ gate: "top-1 accuracy", ok: positives > 0 && top1 >= TOP1_MIN, detail: `${pct(top1)} over ${positives} cases (needs ${pct(TOP1_MIN)})` },
		{ gate: "false invokes", ok: none.cases > 0 && falseInvoke <= FALSE_INVOKE_MAX, detail: `${pct(falseInvoke)} of ${none.cases} none cases (allows ${pct(FALSE_INVOKE_MAX)})` },
		{ gate: "cases per skill", ok: tooFew.length === 0, detail: tooFew.length ? `under ${MIN_CASES}: ${tooFew.map((n) => `${n} (${perSkill[n].cases})`).join(", ")}` : `every skill has ${MIN_CASES} or more` },
		{ gate: "p95 latency", ok: speed.p95Ms < P95_MAX_MS, detail: `${speed.p95Ms} ms per match (under ${P95_MAX_MS} ms); index build ${speed.buildMs} ms` },
		{
			gate: "baseline",
			ok: baseline !== undefined && unbased.length === 0 && regressions.length === 0,
			detail: !baseline
				? "no baseline.json; run tabkyra skill eval --update-baseline and commit it"
				: unbased.length
					? `no valid baseline (a number from 0 to 1) for ${unbased.join(", ")}; run tabkyra skill eval --update-baseline and commit it`
					: regressions.length
						? `dropped more than ${REGRESSION_POINTS} points: ${regressions.map(([n, s]) => `${n} ${pct(s.accuracy)} (baseline ${pct(s.baseline ?? 0)})`).join(", ")}`
						: `no skill more than ${REGRESSION_POINTS} points below its baseline`,
		},
		{
			gate: "held-out top-1",
			ok: held !== undefined && held.positives > 0 && held.top1 >= HELDOUT_TOP1_MIN,
			detail: held ? `${pct(held.top1)} over ${held.positives} held-out cases (needs ${pct(HELDOUT_TOP1_MIN)})` : "no router-heldout.jsonl next to the cases",
		},
		{
			gate: "held-out none",
			ok: held !== undefined && held.negatives > 0 && held.falseInvoke <= HELDOUT_FALSE_INVOKE_MAX,
			detail: held ? `${pct(held.falseInvoke)} false invokes of ${held.negatives} held-out none cases (allows ${pct(HELDOUT_FALSE_INVOKE_MAX)})` : "no router-heldout.jsonl next to the cases",
		},
	];
	return {
		ok: gates.every((g) => g.ok),
		skills: names.size,
		cases: usable.length,
		positives,
		negatives: none.cases,
		top1: round(top1, 4),
		falseInvoke: round(falseInvoke, 4),
		perSkill,
		misses,
		skipped,
		heldout: held,
		speed,
		thresholds: Object.fromEntries(Object.entries(THRESHOLDS).map(([k, t]) => [k, t.value])) as EvalReport["thresholds"],
		gates,
	};
}

/** The threshold constants a skill-eval.ts source declares, by name. */
export function thresholdsIn(source: string): Partial<Record<keyof typeof THRESHOLDS, number>> {
	const out: Partial<Record<keyof typeof THRESHOLDS, number>> = {};
	for (const name of Object.keys(THRESHOLDS) as Array<keyof typeof THRESHOLDS>) {
		const m = new RegExp(`^export const ${name} = ([0-9][0-9_.]*);$`, "m").exec(source);
		if (m) out[name] = Number(m[1].replace(/_/g, ""));
	}
	return out;
}

export interface BaseFiles {
	cases?: string;
	heldout?: string;
	baseline?: string;
}

/**
 * Checks a pull request against its base branch, run by the base branch's build with the
 * pull request's skills bundled in. `head` is the pull request's files and its skill-eval.ts
 * source; `base` is the base branch's files. The running code's thresholds are the base's.
 */
export function runBaseCheck(skills: RouterSkill[], head: BaseFiles & { evalSource?: string }, base: BaseFiles): { ok: boolean; gates: Gate[]; report?: EvalReport } {
	const gates: Gate[] = [];
	const key = (c: EvalCase) => `${c.skill}\u0000${c.task}`;
	const missing: string[] = [];
	for (const [label, baseText, headText] of [
		["router-cases.jsonl", base.cases, head.cases],
		["router-heldout.jsonl", base.heldout, head.heldout],
	] as const) {
		if (baseText === undefined) continue;
		const kept = new Set(parseCases(headText ?? "", label).map(key));
		for (const c of parseCases(baseText, label)) if (!kept.has(key(c))) missing.push(`${label}: ${JSON.stringify(c.task)} (${c.skill})`);
	}
	gates.push({ gate: "base cases kept", ok: missing.length === 0, detail: missing.length ? `removed or relabeled: ${missing.slice(0, 5).join("; ")}${missing.length > 5 ? `; and ${missing.length - 5} more` : ""}` : "every base case is still there" });

	const names = new Set(skills.map((s) => s.name));
	const baseBaseline = base.baseline === undefined ? undefined : parseBaseline(base.baseline);
	const headBaseline = head.baseline === undefined ? { accuracy: {} } : parseBaseline(head.baseline);
	const lowered = Object.entries(baseBaseline?.accuracy ?? {})
		.filter(([name]) => name === "none" || names.has(name))
		.filter(([name, value]) => headBaseline.accuracy[name] === undefined || (value - headBaseline.accuracy[name]) * 100 > REGRESSION_POINTS + 1e-9)
		.map(([name, value]) => `${name} ${headBaseline.accuracy[name] === undefined ? "missing" : pct(headBaseline.accuracy[name])} (base ${pct(value)})`);
	gates.push({ gate: "base baseline", ok: lowered.length === 0, detail: lowered.length ? `more than ${REGRESSION_POINTS} points below the base branch: ${lowered.join(", ")}` : `no skill more than ${REGRESSION_POINTS} points below the base branch's baseline` });

	const declared = thresholdsIn(head.evalSource ?? "");
	const looser = (Object.entries(THRESHOLDS) as Array<[keyof typeof THRESHOLDS, (typeof THRESHOLDS)[keyof typeof THRESHOLDS]]>)
		.filter(([name, t]) => {
			const v = declared[name];
			return v === undefined || (t.stricter === "higher" ? v < t.value : v > t.value);
		})
		.map(([name, t]) => `${name} ${declared[name] ?? "missing"} (base ${t.value})`);
	gates.push({ gate: "base thresholds", ok: looser.length === 0, detail: looser.length ? `looser than the base branch: ${looser.join(", ")}` : "no threshold looser than the base branch's" });

	// The pull request's skills, the base branch's code, cases and baseline.
	let report: EvalReport | undefined;
	if (base.cases !== undefined) {
		report = runEval(skills, parseCases(base.cases), baseBaseline, base.heldout === undefined ? undefined : parseCases(base.heldout, "router-heldout.jsonl"));
		const failed = report.gates.filter((g) => !g.ok && !(g.gate.startsWith("held-out") && base.heldout === undefined));
		gates.push({ gate: "base-code eval", ok: failed.length === 0, detail: failed.length ? failed.map((g) => `${g.gate}: ${g.detail}`).join("; ") : `top-1 ${pct(report.top1)}, false invokes ${pct(report.falseInvoke)} on the base cases` });
	}
	return { ok: gates.every((g) => g.ok), gates, report };
}
