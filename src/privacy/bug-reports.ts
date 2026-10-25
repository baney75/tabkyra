/**
 * Bug reports are off unless the user turns them on. While on, errors from the side panel
 * are kept locally, redacted, in a short ring buffer. Nothing leaves the browser on its own:
 * "Review and send" shows the redacted report and opens a prefilled GitHub issue the user
 * submits themselves.
 */

export const BUG_REPORTS_KEY = "privacy.bugReports";
export const BUG_LOG_KEY = "privacy.bugLog";
const MAX_ENTRIES = 20;
const ISSUE_URL = "https://github.com/baney75/tabkyra/issues/new";

export interface BugEntry {
	at: string;
	message: string;
	stack?: string;
}

/** Strip what could identify the user or leak a secret: query strings, emails, key-like strings, home paths. */
export function redact(text: string): string {
	return text
		.replace(/\b([a-z][\w+.-]*:\/\/[^\s?#"')]+)[?#][^\s"')]*/gi, "$1?[redacted]")
		.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
		.replace(/\b(sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abprs]|AKIA|AIza|ya29|eyJ)[\w-]{10,}/g, "[secret]")
		.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[long-token]")
		.replace(/\/(Users|home)\/[^/\s]+/g, "/$1/[user]")
		.replace(/[A-Z]:\\Users\\[^\\\s]+/g, "C:\\Users\\[user]")
		.slice(0, 2000);
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

export function issueUrl(version: string, log: BugEntry[], userAgent: string): string {
	const body = [
		`Tabkyra ${version}`,
		`Browser: ${redact(userAgent)}`,
		"",
		"What were you doing?",
		"",
		"Recent errors (redacted; edit before submitting):",
		"```",
		...log.slice(-5).map((e) => `${e.at} ${e.message}${e.stack ? `\n${e.stack}` : ""}`),
		"```",
	].join("\n");
	const url = new URL(ISSUE_URL);
	url.searchParams.set("title", `Bug report: ${log.at(-1)?.message.slice(0, 80) ?? "describe the problem"}`);
	url.searchParams.set("body", body.slice(0, 6000));
	url.searchParams.set("labels", "bug-report");
	return url.toString();
}
