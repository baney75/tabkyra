/**
 * Errors a bridge call returns. An expected failure (a stale ref, a missing tab, a script that
 * threw) gets its own code and a message with no stack trace; `internal` is for real bugs. The
 * stack goes to the debug log (`tabkyra debug`), not to the agent.
 */

import { isDetachError } from "../browser/cdp.js";
import { NoTabError } from "../browser/session.js";
import { ERR, type RpcError } from "./protocol.js";

export class BridgeError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
	toRpc(): RpcError {
		return { code: this.code, message: this.message };
	}
}

/**
 * The debugger detached from the tab while a call was running. Like a dropped connection, the
 * call may have run: the agent checks the page before repeating it. Never the raw CDP message.
 */
export function detachedError(method: string, what: string): BridgeError {
	return new BridgeError(
		ERR.INTERRUPTED,
		`The browser's debugger detached from the tab while ${method} was running, so it may have run (${what}). Check the page with read_page before you repeat it; Tabkyra attaches again on your next call.`,
	);
}

/** A message with the stack trace a page-side Error carries cut off; the trace is returned apart. */
export function splitStack(text: string): { message: string; stack?: string } {
	const at = text.search(/\n\s+at\s/);
	if (at < 0) return { message: text.trim() };
	return { message: text.slice(0, at).trim(), stack: text.slice(at + 1) };
}

/** [pattern, code] for failures whose text Tabkyra itself wrote (src/browser/page.ts, session.ts, cdp.ts). */
const KNOWN: Array<[RegExp, string]> = [
	[/Ref \S+ (?:not found|now shows something else|isn't shown now)|no longer in the page/, ERR.STALE_REF],
	[/Selector not found|No option matches|No captured request/, ERR.NOT_FOUND],
	[/Tab \d+ is not owned by this session|No tab with id/, ERR.NOT_FOUND],
	[
		/is covered by|outside the visible page|kept off screen|is not a form control|can't be filled|can't reach it/,
		ERR.NOT_ACTIONABLE,
	],
	[
		/browser-internal pages are protected|are protected\. Navigate|closed by the user on this tab/,
		ERR.PERMISSION_DENIED,
	],
	[/Invalid regular expression/, ERR.BAD_PARAMS],
	[/^Navigation to .* failed:/, ERR.NAV_FAILED],
	[/timed out after|did not finish within/, ERR.TIMEOUT],
	[/No dialog is open/, ERR.NOT_FOUND],
];

/**
 * The BridgeError for whatever a handler threw. `fallback` is the code for an error Tabkyra did
 * not write: `script_error` for run_js (the page's own exception), `internal` for the rest.
 * The returned message never has a stack; `stack` is for the debug log.
 */
export function classify(err: unknown, method: string): { error: BridgeError; stack?: string } {
	if (err instanceof BridgeError) return { error: err };
	if (err instanceof NoTabError) return { error: new BridgeError(ERR.NO_TAB, err.message) };
	if (isDetachError(err)) return { error: detachedError(method, "the debugger lost the tab"), stack: errText(err) };
	const { message, stack } = splitStack(errText(err));
	const known = KNOWN.find(([re]) => re.test(message));
	const code = known ? known[1] : method === "evaluate" ? ERR.SCRIPT_ERROR : ERR.INTERNAL;
	// A page-side Error stringifies as "Error: text"; for a failure Tabkyra worded itself, the text is the message.
	return {
		error: new BridgeError(code, known ? message.replace(/^Error: /, "") : message),
		stack: stack ?? (code === ERR.INTERNAL && err instanceof Error ? err.stack : undefined),
	};
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
