/**
 * Who may use the Connect relay, and when. Pure, so a test can drive it without a browser.
 *
 * A port is allowed only from the side panel document itself: not a content script, not another
 * extension page, and not sidepanel.html opened as a tab (a tab can be navigated or scripted by a
 * browser-driving client, which must never reach code minting or joining a hub). The methods that
 * hand out a code or give a hub control of this browser also need a gesture token the panel mints on
 * a click: fresh, from this clock, and good once.
 *
 * There is no test allowance here. The panel e2e replaces chrome.runtime.connect with a stand-in
 * before the relay is involved, so the production check stays whole.
 */

import { GESTURE_METHODS, GESTURE_MS, type Gesture } from "./types.js";

export const PANEL_PATH = "sidepanel.html";

/** The sender of a port: the side panel document of this extension, with no tab. */
export function isSidePanelPort(
	sender: Pick<chrome.runtime.MessageSender, "url" | "origin" | "tab"> | undefined,
	origin: string,
): boolean {
	if (!sender || sender.tab !== undefined) return false;
	if (sender.origin !== undefined && `${sender.origin}/` !== origin) return false;
	if (!sender.url) return false;
	try {
		const url = new URL(sender.url);
		// Not url.origin: it is "null" for chrome-extension: in some runtimes.
		return `${url.protocol}//${url.host}/` === origin && url.pathname === `/${PANEL_PATH}`;
	} catch {
		return false;
	}
}

/** Remembers the gesture tokens it has accepted, for as long as they could still be fresh. */
export class GestureGate {
	private readonly used = new Map<string, number>();

	constructor(private readonly now: () => number = Date.now) {}

	/** Whether `method` may go on. A gesture method needs a fresh token it has not seen; the token is spent by asking. */
	allows(method: string, gesture: Gesture | undefined): boolean {
		if (!GESTURE_METHODS.includes(method)) return true;
		const now = this.now();
		for (const [token, at] of this.used) if (now - at > GESTURE_MS * 2) this.used.delete(token);
		if (!gesture || this.used.has(gesture.token)) return false;
		if (now - gesture.at > GESTURE_MS || gesture.at - now > 1_000) return false;
		this.used.set(gesture.token, gesture.at);
		return true;
	}
}
