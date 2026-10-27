// Every stamp, highlight and label the hero shows is checked here against the recorded run.
// A recording that doesn't back a claim throws, which fails the render instead of showing it.
// No imports, so test/claims.test.mjs runs these exact checks on doctored copies of the capture.

export type Run = { code: number | null; out: string };
export type Call = { name: string; args: Record<string, unknown>; ms: number; text: string };

/** A line of recorded output picked by its content; a capture without it fails the render. */
export const lineWith = (out: string, test: RegExp, what: string): string => {
	const found = out.split("\n").find((l) => test.test(l));
	if (!found) throw new Error(`capture.json: no ${what} line in the recorded output`);
	return found;
};

/** Fails the render when a recorded exit code isn't what the scene says happened. */
const expectCode = (r: Run, ok: (code: number | null) => boolean, what: string) => {
	if (!ok(r.code)) throw new Error(`capture.json: ${what} exited ${r.code}`);
};

/** The lines the Refused, Flagged and Blocked scenes stamp or highlight, each checked. */
export function checkCli(cli: { libraryMadeUp: Run; libraryRetracted: Run; lintBad: Run; lintShipped: Run; badSkill: string }) {
	const { libraryMadeUp: madeUp, libraryRetracted: retracted, lintBad: lint, lintShipped: shipped } = cli;
	// REFUSED: the made-up DOI was refused as unregistered (not a network failure), and the add failed.
	const refusal = lineWith(madeUp.out, /is not registered \(doi\.org returned 404\)/, "made-up DOI refusal");
	expectCode(madeUp, (c) => c !== null && c !== 0, "the made-up DOI add (a refusal must fail)");
	// FLAGGED: the title line and the warning the stamp lands on; the CLI exits 3 on a retraction.
	const retractedTitle = lineWith(retracted.out, /^Added .*\[RETRACTED/, "retracted title");
	const retractedWarning = lineWith(retracted.out, /RETRACTED: don't cite/, "retraction warning");
	expectCode(retracted, (c) => c === 3, "the retracted add (the CLI exits 3 on a retraction)");
	const cited = retracted.out.match(/cited by (\d+)/);
	if (!cited) throw new Error("capture.json: the retracted add has no citation count");
	// BLOCKED: four lint errors with line numbers, and the lint failed.
	const lintErrors = lint.out.split("\n").filter((l) => /\berror\b/.test(l));
	const lintLines = lintErrors.map((l) => Number(l.match(/SKILL\.md:(\d+)/)?.[1]));
	expectCode(lint, (c) => c !== null && c !== 0, "the bad skill's lint (BLOCKED means it failed)");
	if (lintErrors.length !== 4 || lintLines.some((n) => !(n > 0))) {
		throw new Error(`capture.json: expected 4 lint errors with line numbers, got ${lintErrors.length}`);
	}
	// The errors must name lines of the skill file the scene shows, so each one lights a real line.
	const skillFile = cli.badSkill.trimEnd().split("\n");
	const skillName = cli.badSkill.match(/^name:\s*(\S+)$/m)?.[1];
	if (!skillName || skillFile.length < 2) throw new Error("capture.json: the bad skill file is empty or has no name");
	for (const [i, l] of lintErrors.entries()) {
		if (!l.startsWith(`${skillName}/SKILL.md:`)) throw new Error(`capture.json: lint error ${i + 1} isn't about ${skillName}/SKILL.md`);
		if (lintLines[i] > skillFile.length) {
			throw new Error(`capture.json: lint error ${i + 1} names line ${lintLines[i]}, past the ${skillFile.length}-line skill file`);
		}
	}
	// "Every bundled skill passes": "✓ Clean.", no errors, exit 0.
	const cleanLine = lineWith(shipped.out, /^✓ Clean\.$/, "clean lint");
	if (/\berror\b/.test(shipped.out)) throw new Error("capture.json: the shipped skills' lint lists errors");
	expectCode(shipped, (c) => c === 0, "the shipped skills' lint");
	return { refusal, retractedTitle, retractedWarning, citedBy: Number(cited[1]), lintErrors, lintLines, cleanLine, skillFile, skillPath: `${skillName}/SKILL.md` };
}

function format(hit: Call): string {
	const parts = Object.entries(hit.args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
	return parts.length ? `${hit.name} { ${parts.join(", ")} }` : `${hit.name} {}`;
}

/**
 * The catalog run as the hero shows it: each call found by its content, in recorded order. A ref
 * means something only in the read_page snapshot it came from, so every type, click and fill must
 * act on the latest snapshot before it, and the click labels are that snapshot's button names.
 * Throws if a step is missing, so a re-capture can't put a call under the wrong shot.
 */
export function catalogRunFrom(calls: Call[], refs: Record<string, string>, catalogUrl: string, cachedConfirmation?: string) {
	let cursor = -1;
	const next = (what: string, test: (c: Call) => boolean): number => {
		const i = calls.findIndex((c, k) => k > cursor && test(c));
		if (i < 0) throw new Error(`capture.json: no ${what} after call ${cursor} in the catalog run`);
		cursor = i;
		return i;
	};
	/** The accessible name of `ref` in a snapshot, e.g. "Place hold"; throws if it isn't a `role`. */
	const nameOf = (snapshot: number, ref: string, role: string, what: string): string => {
		const m = calls[snapshot].text.match(new RegExp(`^${ref} ${role} "([^"]+)"`, "m"));
		if (!m) throw new Error(`capture.json: ${ref} isn't a ${role} in the snapshot the ${what} used`);
		return m[1];
	};
	/** Throws unless `snapshot` is the last read_page before call `i`. */
	const actedOn = (i: number, snapshot: number, what: string) => {
		let last = i - 1;
		while (last >= 0 && calls[last].name !== "read_page") last--;
		if (last !== snapshot) throw new Error(`capture.json: the ${what} acted on a different snapshot`);
	};
	const page = (text: string) => (c: Call) => c.name === "read_page" && c.text.includes(text);

	const navigate = next("navigate to the catalog", (c) => c.name === "navigate" && c.args.url === catalogUrl);
	const searchPage = next("read_page of the search form", page("Search the catalog"));
	const type = next("type of the search", (c) => c.name === "type" && c.args.ref === refs.search && c.args.submit === true);
	actedOn(type, searchPage, "search");
	nameOf(searchPage, refs.search, "textbox", "search");
	next("get_page_text of the results", (c) => c.name === "get_page_text" && c.text.includes("Results for"));
	const results = next("read_page of the results", page("Place hold"));
	const clickHold = next("click on the hold button", (c) => c.name === "click" && c.args.ref === refs.holdButton);
	actedOn(clickHold, results, "hold button click");
	const holdLabel = nameOf(results, refs.holdButton, "button", "hold button click");
	next("get_page_text of the hold form", (c) => c.name === "get_page_text" && c.text.includes("Place a hold"));
	const form = next("read_page of the hold form", page("Confirm"));
	const fillCard = next("fill of the card name", (c) => c.name === "fill" && c.args.ref === refs.card);
	actedOn(fillCard, form, "card name fill");
	nameOf(form, refs.card, "textbox", "card name fill");
	const fillBranch = next("fill of the branch", (c) => c.name === "fill" && c.args.ref === refs.branch);
	actedOn(fillBranch, form, "branch fill");
	nameOf(form, refs.branch, "combobox", "branch fill");
	const clickConfirm = next("click on confirm", (c) => c.name === "click" && c.args.ref === refs.confirm);
	actedOn(clickConfirm, form, "confirm click");
	const confirmLabel = nameOf(form, refs.confirm, "button", "confirm click");
	const readBack = next("get_page_text of the confirmation", (c) => c.name === "get_page_text" && c.text.includes("Hold placed"));
	// The sentence the read-back shows is the checked get_page_text call's own result, and it must
	// name what the fills entered; the capture's cached copy, if present, must agree with it.
	let pageText: string;
	try {
		pageText = String((JSON.parse(calls[readBack].text) as { text?: unknown }).text ?? "");
	} catch {
		throw new Error("capture.json: the confirmation get_page_text result isn't JSON");
	}
	const confirmation = lineWith(pageText, /^Hold placed /, "hold confirmation");
	for (const fill of [fillCard, fillBranch]) {
		const value = String(calls[fill].args.value ?? "");
		if (!value || !confirmation.includes(value)) {
			throw new Error(`capture.json: the confirmation doesn't name the filled value "${value}"`);
		}
	}
	if (cachedConfirmation !== undefined && cachedConfirmation.split("\n").at(-1) !== confirmation) {
		throw new Error("capture.json: catalog.confirmation disagrees with the recorded read-back");
	}
	if (holdLabel !== "Place hold" || !/^confirm/i.test(confirmLabel)) {
		throw new Error(`capture.json: the run clicked "${holdLabel}" and "${confirmLabel}", not the hold and confirm buttons`);
	}
	return {
		navigate: format(calls[navigate]),
		type: format(calls[type]),
		clickHold: `${format(calls[clickHold])}  // ${holdLabel}`,
		fills: `${format(calls[fillCard])}\n${format(calls[fillBranch])}`,
		clickConfirm: `${format(calls[clickConfirm])}  // ${confirmLabel}`,
		readBack: format(calls[readBack]),
		confirmation,
	};
}

export type RouterCapture = {
	matches: { task: string; expected: string; shown: string; code: number | null; out: string }[];
	eval: { skills: number; speed: { p95Ms: number; matches: number } };
};

/**
 * The router scene: "in under a millisecond at p95" needs a recorded p95 under 1 ms, and each
 * row's skill, score and description are parsed from the recorded output, which must route to
 * the task's expected skill with exit 0.
 */
export function checkRouter(router: RouterCapture) {
	const { skills, speed } = router.eval;
	if (!(speed.p95Ms > 0 && speed.p95Ms < 1)) throw new Error(`router.json: p95 is ${speed.p95Ms} ms, not under a millisecond`);
	if (!Number.isInteger(skills) || skills < 1) throw new Error(`router.json: ${skills} skills`);
	if (!Number.isInteger(speed.matches) || speed.matches < 1) throw new Error(`router.json: ${speed.matches} timed matches`);
	if (router.matches.length !== 4) throw new Error(`router.json: expected 4 matches, got ${router.matches.length}`);
	const rows = router.matches.map((m) => {
		if (m.code !== 0) throw new Error(`router.json: "${m.task}" exited ${m.code}`);
		const none = m.out.match(/^·\s*none:\s*(.+)$/);
		const hit = m.out.match(/^([a-z0-9][a-z0-9-]*)\s+(\d+(?:\.\d+)?)\s+(\S.*)$/);
		const name = none ? "none" : hit?.[1];
		if (!name || name !== m.expected) throw new Error(`router.json: "${m.task}" routed to ${name ?? "unparsed output"}, expected ${m.expected}`);
		return { task: m.task, shown: m.shown, none: !!none, name, score: hit?.[2] ?? "", description: none ? none[1] : (hit?.[3] ?? "") };
	});
	return { rows, p95Ms: speed.p95Ms, timed: speed.matches, skills };
}

/**
 * The drop scene's checkmark: the choice the recorded run answered, which must be one of the
 * prompt's choices, an allow, and must show up in the allowed sites afterwards.
 */
export function checkPrompt(
	prompt: { enum: string[]; enumNames: string[] },
	answer: string | undefined,
	allowedHosts: string[],
	host: string,
) {
	const picked = answer === undefined ? -1 : prompt.enum.indexOf(answer);
	if (picked < 0 || prompt.enumNames.length !== prompt.enum.length) {
		throw new Error(`capture.json: the recorded answer ${answer} isn't one of the prompt's choices`);
	}
	if (!answer?.startsWith("allow")) throw new Error(`capture.json: the recorded answer is ${answer}, not an allow`);
	if (!allowedHosts.includes(host)) throw new Error(`capture.json: ${host} isn't in the allowed sites after the answer`);
	return { picked, label: prompt.enumNames[picked] };
}
