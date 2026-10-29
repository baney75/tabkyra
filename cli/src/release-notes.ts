/**
 * Release notes for the side panel's "What's new" card (the GitHub release body, from
 * CHANGELOG.md). The card shows each entry's first sentence, so a body over the limit loses the
 * detail at the end of each bullet first, then the last bullets of the longest sections, and
 * every section keeps at least its first entry.
 */

export const MAX_NOTES_CHARS = 8000;

const isBullet = (line: string) => /^[-*]\s/.test(line);

/** Cut one line to `max` characters at a word boundary, never inside a code span. */
function shorten(line: string, max: number): string {
	if (line.length <= max) return line;
	const cut = line.slice(0, max);
	let short = cut.slice(0, Math.max(cut.lastIndexOf(" "), 1));
	if ((short.match(/`/g) ?? []).length % 2) short = short.slice(0, short.lastIndexOf("`")).trimEnd();
	return `${short}…`;
}

/** The notes within `max` characters, every section kept; a plain cut only if even that fails. */
export function fitNotes(body: string, max = MAX_NOTES_CHARS): string {
	if (body.length <= max) return body;
	let lines = body.split("\n");
	for (const bullet of [400, 200, 120]) {
		lines = lines.map((line) => (isBullet(line) ? shorten(line, bullet) : line));
		if (lines.join("\n").length <= max) return lines.join("\n");
	}
	// Still too long: drop the last bullet of the section with the most, keeping one per section.
	for (;;) {
		const text = lines.join("\n");
		if (text.length <= max) return text;
		let start = 0;
		let best = { count: 1, last: -1 };
		lines.forEach((line, i) => {
			if (/^#{2,4}\s/.test(line)) start = i;
			const count = lines.slice(start, i + 1).filter(isBullet).length;
			if (isBullet(line) && count > best.count) best = { count, last: i };
		});
		if (best.last < 0) return `${text.slice(0, max)}...`;
		lines.splice(best.last, 1);
	}
}
