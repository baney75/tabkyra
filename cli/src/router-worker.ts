/**
 * The skill router in a process of its own, for `tabkyra skill eval --router`. CI builds this
 * shim (from the base branch) around a pull request's skill-router.ts and runs it with Node's
 * permission model, so the router reads nothing from disk. The judge (the base branch's
 * skill-eval.ts) sends one JSON request on stdin, `{skills, tasks, rounds}`, with skill texts
 * and task strings only, never the labels. It gets back `{buildMs, top, timesMs}`: the top
 * skill (or "none") for each task, and how long each match took.
 */

import { buildRouterIndex, matchSkills, type RouterSkill } from "./skill-router.ts";

interface RouterRequest {
	skills: RouterSkill[];
	tasks: string[];
	rounds: number;
}

const chunks: Buffer[] = [];
process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
process.stdin.on("end", () => {
	const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RouterRequest;
	const started = performance.now();
	const index = buildRouterIndex(request.skills);
	const buildMs = performance.now() - started;
	const top: string[] = [];
	const timesMs: number[] = [];
	for (let r = 0; r < Math.max(1, request.rounds); r++) {
		for (const task of request.tasks) {
			const t0 = performance.now();
			const name = matchSkills(index, task, 1)[0]?.name ?? "none";
			timesMs.push(performance.now() - t0);
			if (r === 0) top.push(name);
		}
	}
	process.stdout.write(JSON.stringify({ buildMs, top, timesMs }));
});
