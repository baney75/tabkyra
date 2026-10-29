/**
 * Release notes for the side panel's "What's new" card (the GitHub release body, from
 * CHANGELOG.md). The card shows each entry's first sentence, so a body over the limit loses the
 * detail at the end of each bullet first, never a whole section.
 */

export const MAX_NOTES_CHARS = 8000;

/** Cut one line to `max` characters at a word boundary. */
function shorten(line: string, max: number): string {
	if (line.length <= max) return line;
	const cut = line.slice(0, max);
	return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1))}…`;
}

/** The notes within `max` characters: shorter bullets first, then a plain cut as the last resort. */
export function fitNotes(body: string, max = MAX_NOTES_CHARS): string {
	if (body.length <= max) return body;
	for (const bullet of [400, 200, 120]) {
		const fitted = body
			.split("\n")
			.map((line) => (/^[-*]\s/.test(line) ? shorten(line, bullet) : line))
			.join("\n");
		if (fitted.length <= max) return fitted;
	}
	return `${body.slice(0, max)}...`;
}
