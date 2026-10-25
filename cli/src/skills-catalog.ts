/**
 * Every skill the CLI ships, bundled as text at build time (cli/scripts/build.mjs). A test
 * (cli/test/skill-lint.test.mjs) fails when a folder under skills/ is missing here, and
 * every entry passes `tabkyra skill lint` before it can merge.
 */

import ACADEMIC_RESEARCH from "../../skills/academic-research/SKILL.md";
import ADVERSARIAL_REVIEW from "../../skills/adversarial-review/SKILL.md";
import ARTIFACTS from "../../skills/artifacts/SKILL.md";
import AUTORESEARCH from "../../skills/autoresearch/SKILL.md";
import BUG from "../../skills/bug/SKILL.md";
import DORKS from "../../skills/dorks/SKILL.md";
import FIX from "../../skills/fix/SKILL.md";
import KYRASKILLMAKER from "../../skills/kyraskillmaker/SKILL.md";
import NEWS_RESEARCH from "../../skills/news-research/SKILL.md";
import OSINT from "../../skills/osint/SKILL.md";
import PROTON_PASS from "../../skills/proton-pass/SKILL.md";
import RSI from "../../skills/rsi/SKILL.md";
import TABKYRA from "../../skills/tabkyra/SKILL.md";

/** Name to SKILL.md text. `tabkyra` first: it's the one every other skill builds on. */
export const SKILLS: ReadonlyMap<string, string> = new Map([
	["tabkyra", TABKYRA],
	["academic-research", ACADEMIC_RESEARCH],
	["adversarial-review", ADVERSARIAL_REVIEW],
	["artifacts", ARTIFACTS],
	["autoresearch", AUTORESEARCH],
	["bug", BUG],
	["dorks", DORKS],
	["fix", FIX],
	["kyraskillmaker", KYRASKILLMAKER],
	["news-research", NEWS_RESEARCH],
	["osint", OSINT],
	["proton-pass", PROTON_PASS],
	["rsi", RSI],
]);
