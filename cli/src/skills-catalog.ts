/**
 * Every skill the CLI ships, bundled as text at build time (cli/scripts/build.mjs). A test
 * (cli/test/skill-lint.test.mjs) fails when a folder under skills/ is missing here, and
 * every entry passes `tabkyra skill lint` before it can merge.
 */

import SKILL_ACADEMIC_RESEARCH from "../../skills/academic-research/SKILL.md";
import SKILL_ADVERSARIAL_REVIEW from "../../skills/adversarial-review/SKILL.md";
import SKILL_ARTIFACTS from "../../skills/artifacts/SKILL.md";
import SKILL_AUTORESEARCH from "../../skills/autoresearch/SKILL.md";
import SKILL_BUG from "../../skills/bug/SKILL.md";
import SKILL_DORKS from "../../skills/dorks/SKILL.md";
import SKILL_FIX from "../../skills/fix/SKILL.md";
import SKILL_KYRASKILLMAKER from "../../skills/kyraskillmaker/SKILL.md";
import SKILL_NEWS_RESEARCH from "../../skills/news-research/SKILL.md";
import SKILL_OSINT from "../../skills/osint/SKILL.md";
import SKILL_PROTON_PASS from "../../skills/proton-pass/SKILL.md";
import SKILL_RSI from "../../skills/rsi/SKILL.md";
import SKILL_TABKYRA from "../../skills/tabkyra/SKILL.md";

/** Name to SKILL.md text. `tabkyra` first: it's the one every other skill builds on. */
export const SKILLS: ReadonlyMap<string, string> = new Map([
	["tabkyra", SKILL_TABKYRA],
	["academic-research", SKILL_ACADEMIC_RESEARCH],
	["adversarial-review", SKILL_ADVERSARIAL_REVIEW],
	["artifacts", SKILL_ARTIFACTS],
	["autoresearch", SKILL_AUTORESEARCH],
	["bug", SKILL_BUG],
	["dorks", SKILL_DORKS],
	["fix", SKILL_FIX],
	["kyraskillmaker", SKILL_KYRASKILLMAKER],
	["news-research", SKILL_NEWS_RESEARCH],
	["osint", SKILL_OSINT],
	["proton-pass", SKILL_PROTON_PASS],
	["rsi", SKILL_RSI],
]);
