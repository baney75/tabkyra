/**
 * `tabkyra skill eval`: the router's regression suite. Cases live in
 * skills-eval/router-cases.jsonl, one `{"task": "...", "skill": "<name>|none"}` per line,
 * and the per-skill accuracy each release must keep is in skills-eval/baseline.json.
 *
 * The gates, all checked by CI (the skill-regression job and cli/test/skill-router.test.mjs):
 * top-1 accuracy over positive cases, the false-invoke rate on "none" cases, at least
 * MIN_CASES cases for every bundled skill, p95 match latency, and no skill more than
 * REGRESSION_POINTS below its baseline. Cases that name a skill the catalog doesn't have
 * are skipped and listed, so cases for a skill can land before or after the skill itself.
 */

import { performance } from "node:perf_hooks";
import { buildRouterIndex, matchSkills, type RouterSkill } from "./skill-router.ts";

export const TOP1_MIN = 0.9;
export const FALSE_INVOKE_MAX = 0.05;
export const MIN_CASES = 8;
export const P95_MAX_MS = 10;
/** Percentage points a skill's accuracy may fall below its baseline. */
export const REGRESSION_POINTS = 10;
/** Every case is matched this many times for the latency figures. */
const ROUNDS = 5;

export interface EvalCase {
	task: string;
	skill: string;
	line: number;
}

export interface Baseline {
	/** Accuracy per skill, 0 to 1. "none" is the share of none cases routed to no skill. */
	accuracy: Record<string, number>;
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
	speed: { buildMs: number; p50Ms: number; p95Ms: number; maxMs: number; matches: number };
	gates: Array<{ gate: string; ok: boolean; detail: string }>;
}

export class EvalError extends Error {}

/** Parse the JSONL cases; a malformed line is an error with its line number, blank lines are skipped. */
export function parseCases(text: string): EvalCase[] {
	const out: EvalCase[] = [];
	text.split("\n").forEach((raw, i) => {
		if (raw.trim() === "") return;
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			throw new EvalError(`router-cases.jsonl line ${i + 1} is not JSON.`);
		}
		const c = value as { task?: unknown; skill?: unknown };
		if (typeof c.task !== "string" || !c.task.trim() || typeof c.skill !== "string" || !/^(none|[a-z0-9]+(-[a-z0-9]+)*)$/.test(c.skill)) {
			throw new EvalError(`router-cases.jsonl line ${i + 1} needs {"task": "...", "skill": "<name>|none"}.`);
		}
		out.push({ task: c.task, skill: c.skill, line: i + 1 });
	});
	return out;
}

export function parseBaseline(text: string): Baseline {
	const data = JSON.parse(text) as { accuracy?: Record<string, unknown> };
	const accuracy: Record<string, number> = {};
	for (const [name, value] of Object.entries(data.accuracy ?? {})) if (typeof value === "number") accuracy[name] = value;
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

/** Run every case through a fresh index of `skills` and check each gate. */
export function runEval(skills: RouterSkill[], cases: EvalCase[], baseline?: Baseline): EvalReport {
	const started = performance.now();
	const index = buildRouterIndex(skills);
	const buildMs = performance.now() - started;
	const names = new Set(skills.map((s) => s.name));
	const usable = cases.filter((c) => c.skill === "none" || names.has(c.skill));
	const skipped = cases.filter((c) => c.skill !== "none" && !names.has(c.skill)).map((c) => ({ line: c.line, skill: c.skill }));

	const perSkill: EvalReport["perSkill"] = {};
	for (const name of [...names, "none"]) perSkill[name] = { cases: 0, correct: 0, accuracy: 0 };
	const misses: EvalReport["misses"] = [];
	const times: number[] = [];
	for (let round = 0; round < ROUNDS; round++) {
		for (const c of usable) {
			const t0 = performance.now();
			const got = matchSkills(index, c.task, 1)[0]?.name ?? "none";
			times.push(performance.now() - t0);
			if (round > 0) continue;
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

	const tooFew = [...names].filter((n) => perSkill[n].cases < MIN_CASES);
	const regressions = Object.entries(perSkill).filter(([, s]) => s.baseline !== undefined && s.cases > 0 && (s.baseline - s.accuracy) * 100 > REGRESSION_POINTS + 1e-9);
	const unbased = baseline ? [...names].filter((n) => baseline.accuracy[n] === undefined) : [];
	const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
	const gates: EvalReport["gates"] = [
		{ gate: "top-1 accuracy", ok: positives > 0 && top1 >= TOP1_MIN, detail: `${pct(top1)} over ${positives} cases (needs ${pct(TOP1_MIN)})` },
		{ gate: "false invokes", ok: none.cases > 0 && falseInvoke <= FALSE_INVOKE_MAX, detail: `${pct(falseInvoke)} of ${none.cases} none cases (allows ${pct(FALSE_INVOKE_MAX)})` },
		{ gate: "cases per skill", ok: tooFew.length === 0, detail: tooFew.length ? `under ${MIN_CASES}: ${tooFew.map((n) => `${n} (${perSkill[n].cases})`).join(", ")}` : `every skill has ${MIN_CASES} or more` },
		{ gate: "p95 latency", ok: speed.p95Ms < P95_MAX_MS, detail: `${speed.p95Ms} ms per match (under ${P95_MAX_MS} ms); index build ${speed.buildMs} ms` },
		{
			gate: "baseline",
			ok: baseline !== undefined && regressions.length === 0,
			detail: !baseline
				? "no baseline.json; run tabkyra skill eval --update-baseline and commit it"
				: regressions.length
					? `dropped more than ${REGRESSION_POINTS} points: ${regressions.map(([n, s]) => `${n} ${pct(s.accuracy)} (baseline ${pct(s.baseline ?? 0)})`).join(", ")}`
					: `no skill more than ${REGRESSION_POINTS} points below its baseline${unbased.length ? `; not in the baseline yet: ${unbased.join(", ")}` : ""}`,
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
		speed,
		gates,
	};
}
