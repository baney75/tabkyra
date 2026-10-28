/**
 * Whether the header offers "Share this tab". The panel shows on its own task's tabs, so most of
 * the time the tab in front of the user is already the agent's and a share button would do
 * nothing. It is offered only when the active tab is not one of the session's tabs (the user is
 * looking at another tab while a run keeps the panel open, or the panel has no home tab) and is
 * not one of the extension's own pages.
 */
export async function tabToShare(
	windowId: number | undefined,
	sessionTabIds: readonly number[] | undefined,
): Promise<number | undefined> {
	if (windowId === undefined || !sessionTabIds) return undefined;
	const [tab] = await chrome.tabs.query({ active: true, windowId });
	if (!tab?.id || (tab.url ?? "").startsWith("chrome-extension://")) return undefined;
	return sessionTabIds.includes(tab.id) ? undefined : tab.id;
}
