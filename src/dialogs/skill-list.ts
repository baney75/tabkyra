/**
 * Settings > Skills lists every skill Tabkyra has, never a sample: the bundled library, the
 * community skills the user receives, and the site skills in this browser. Pure, for the tab and
 * its tests.
 */

import { firstSentence } from "../composer/menus.js";

export interface LibraryRow {
	name: string;
	/** First sentence of the skill's description. */
	summary: string;
	source: "bundled" | "community";
}

interface Described {
	name: string;
	description: string;
}

const matches = (q: string, ...fields: string[]) => !q || fields.some((f) => f.toLowerCase().includes(q));

/** Bundled skills, then community skills whose names the library doesn't use, filtered by the query. */
export function libraryRows(
	bundled: readonly Described[],
	community: readonly Described[],
	query: string,
): LibraryRow[] {
	const q = query.trim().toLowerCase().replace(/^\//, "");
	const taken = new Set(bundled.map((s) => s.name));
	return [
		...bundled.map((s) => ({ ...s, source: "bundled" as const })),
		...community.filter((s) => !taken.has(s.name)).map((s) => ({ ...s, source: "community" as const })),
	]
		.filter((s) => matches(q, s.name, s.description))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((s) => ({ name: s.name, summary: firstSentence(s.description), source: s.source }));
}
