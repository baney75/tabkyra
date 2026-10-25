/**
 * Bug reports are off unless the user turns them on. While on, errors from the side panel
 * are kept locally, redacted, in a short ring buffer. Nothing leaves the browser on its own:
 * the user reviews and edits the report in Tabkyra, copies it, and pastes it into a GitHub
 * issue they open and submit themselves.
 */

export const BUG_REPORTS_KEY = "privacy.bugReports";
export const BUG_LOG_KEY = "privacy.bugLog";
const MAX_ENTRIES = 20;
/** A blank new-issue page: the report travels by the clipboard, never in the URL. */
export const NEW_ISSUE_URL = "https://github.com/baney75/tabkyra/issues/new?labels=bug-report";

export interface BugEntry {
	at: string;
	message: string;
	stack?: string;
}

/**
 * Strip what could identify the user or leak a secret. Web addresses become `[url]`
 * (paths and hosts can name people, records or accounts); Tabkyra's own extension scripts
 * keep only the file name, which is what a maintainer needs from a stack trace.
 */
export function redact(text: string): string {
	return (
		text
			.replace(/\bchrome-extension:\/\/[a-p]{32}\/([\w./-]*)(?:[?#][^\s"'<>)]*)?/gi, "ext:/$1")
			.replace(/\b[a-z][\w+.-]*:\/\/[^\s"'<>)]+/gi, "[url]")
			// Addresses without "//": data, blob, about and javascript URLs carry page content.
			.replace(/\b(?:data|blob|about|javascript):[^\s"'<>)]+/gi, "[url]")
			.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[ip]")
			.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
			.replace(/\b(sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abprs]|AKIA|AIza|ya29|eyJ)[\w-]{10,}/g, "[secret]")
			.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[long-token]")
			.replace(/\/(Users|home)\/[^/\s]+/g, "/$1/[user]")
			.replace(/[A-Z]:\\Users\\[^\\\s]+/g, "C:\\Users\\[user]")
			.slice(0, 2000)
	);
}

export function addEntry(log: BugEntry[], error: unknown, now = new Date()): BugEntry[] {
	const err = error instanceof Error ? error : new Error(String(error));
	const entry: BugEntry = {
		at: now.toISOString(),
		message: redact(err.message),
		stack: err.stack ? redact(err.stack.split("\n").slice(0, 8).join("\n")) : undefined,
	};
	return [...log, entry].slice(-MAX_ENTRIES);
}

/** The report text the user reviews and edits before anything is shared. */
export function reportText(version: string, log: BugEntry[], userAgent: string): string {
	return [
		`Tabkyra ${version}`,
		`Browser: ${redact(userAgent)}`,
		"",
		"What were you doing?",
		"",
		"Recent errors (redacted):",
		"```",
		...log.slice(-5).map((e) => `${e.at} ${e.message}${e.stack ? `\n${e.stack}` : ""}`),
		"```",
	].join("\n");
}
