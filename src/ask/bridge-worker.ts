/**
 * ask_user over the bridge, in the service worker. An external agent's question waits in
 * chrome.storage.session, where every open side panel shows it (src/ask/bridge-panel.ts), and the
 * toolbar icon carries a badge until it is answered. The panel answers by writing
 * `bridge_answer_<requestId>`; only the waiting request with that id takes it, and its reply goes
 * to the client that asked and to no one else. No bridge method answers a question: a harness
 * can't answer its own question or another's. The same pattern as site permission prompts
 * (src/bridge/permissions.ts).
 *
 * chrome.storage.session is open to extension pages only, not to content scripts, so a web page
 * can't write an answer.
 */

import { ERR, type RpcError } from "../bridge/protocol.js";
import {
	ASK_BRIDGE_TIMEOUT_MS,
	type AskOutcome,
	type AskQuestion,
	agentDisplayName,
	buildAnswer,
	type NoAnswerReason,
	noAnswer,
	outcomeText,
	validateAskParams,
} from "./core.js";

export const PENDING_QUESTIONS_KEY = "bridge_pending_questions";
export const ANSWER_KEY_PREFIX = "bridge_answer_";

export interface PendingQuestion {
	requestId: string;
	clientId: string;
	/** Display name of the asking agent ("Claude Code"); plain text. */
	agentName: string;
	questions: AskQuestion[];
	createdAt: number;
	expiresAt: number;
}

/** What the panel writes under `bridge_answer_<requestId>`. */
export type PanelReply = { selections: unknown } | { skip: true };

interface Waiting {
	clientId: string;
	/** The caller's own id for this call (ask_user.cancel names it); may be absent. */
	askId?: string;
	questions: AskQuestion[];
	settle: (outcome: AskOutcome) => void;
}

const waiting = new Map<string, Waiting>();

/** Read-modify-write of the pending list, one at a time, so two questions never drop each other. */
let listOps: Promise<unknown> = Promise.resolve();
function editPending(edit: (list: PendingQuestion[]) => PendingQuestion[]): Promise<void> {
	const run = listOps.then(async () => {
		const data = await chrome.storage.session.get(PENDING_QUESTIONS_KEY);
		const list = (data[PENDING_QUESTIONS_KEY] as PendingQuestion[] | undefined) ?? [];
		const next = edit(list);
		await chrome.storage.session.set({ [PENDING_QUESTIONS_KEY]: next });
		await showBadge(next);
	});
	listOps = run.catch(() => undefined);
	return run;
}

async function showBadge(list: PendingQuestion[]): Promise<void> {
	const action = chrome.action;
	try {
		await action.setBadgeBackgroundColor?.({ color: "#e3a93b" });
		await action.setBadgeText?.({ text: list.length ? String(list.length) : "" });
		await action.setTitle?.({
			title: list.length ? `Tabkyra: ${list[0].agentName} is asking you a question` : "Tabkyra",
		});
	} catch {
		// A badge is a hint; the panel shows the question either way.
	}
}

/**
 * Handle an `ask_user` request from bridge client `client`: show it, wait for the panel's answer,
 * a skip, the timeout or the client going away, and return the response to send back.
 */
export async function handleBridgeAsk(
	client: { clientId: string; name: string },
	params: Record<string, unknown>,
	timeoutMs = ASK_BRIDGE_TIMEOUT_MS,
): Promise<{ result?: unknown; error?: RpcError }> {
	let questions: AskQuestion[];
	try {
		questions = validateAskParams(params).questions;
	} catch (err) {
		return { error: { code: ERR.BAD_PARAMS, message: err instanceof Error ? err.message : String(err) } };
	}
	const askId = typeof params.askId === "string" && params.askId.length <= 64 ? params.askId : undefined;
	const requestId = `${client.clientId}:${crypto.randomUUID()}`;
	const createdAt = Date.now();
	const outcome = await new Promise<AskOutcome>((resolve) => {
		const timer = setTimeout(() => settle(noAnswer(questions, "timeout")), timeoutMs);
		const settle = (o: AskOutcome) => {
			if (waiting.get(requestId)?.settle !== settle) return;
			waiting.delete(requestId);
			clearTimeout(timer);
			resolve(o);
		};
		waiting.set(requestId, { clientId: client.clientId, askId, questions, settle });
		editPending((list) => [
			...list,
			{
				requestId,
				clientId: client.clientId,
				agentName: agentDisplayName(client.name),
				questions,
				createdAt,
				expiresAt: createdAt + timeoutMs,
			},
		]).catch(() => settle(noAnswer(questions, "closed")));
	});
	await editPending((list) => list.filter((p) => p.requestId !== requestId)).catch(() => undefined);
	chrome.storage.session.remove(`${ANSWER_KEY_PREFIX}${requestId}`).catch(() => undefined);
	return { result: { ...outcome, text: outcomeText(outcome) } };
}

/**
 * The panel's reply for `requestId`. Only the waiting request with exactly that id takes it; a
 * reply that doesn't fit its questions is ignored and the question keeps waiting. True when it
 * settled a question.
 */
export function receivePanelReply(requestId: string, reply: unknown): boolean {
	const w = waiting.get(requestId);
	if (!w || typeof reply !== "object" || reply === null) return false;
	if ((reply as { skip?: unknown }).skip === true) {
		w.settle(noAnswer(w.questions, "skipped"));
		return true;
	}
	try {
		w.settle(buildAnswer(w.questions, (reply as { selections?: unknown }).selections));
		return true;
	} catch (err) {
		console.warn("[Bridge] ignored an answer that doesn't fit its question:", err);
		return false;
	}
}

/**
 * End a client's open questions with no answer: it hung up, the host went away (undefined: every
 * client), or it cancelled its own call. Returns how many ended.
 */
export function cancelQuestionsFor(clientId: string | undefined, reason: NoAnswerReason = "disconnected"): number {
	let n = 0;
	for (const w of [...waiting.values()]) {
		if (clientId === undefined || w.clientId === clientId) {
			w.settle(noAnswer(w.questions, reason));
			n++;
		}
	}
	return n;
}

/**
 * ask_user.cancel: the client gave up on one call. Only a question of that client (its id comes
 * from the host, never the params) with that askId ends. Returns how many ended (0 or 1).
 */
export function cancelQuestion(clientId: string, askId: unknown): number {
	if (typeof askId !== "string" || !askId) return 0;
	for (const w of [...waiting.values()]) {
		if (w.clientId === clientId && w.askId === askId) {
			w.settle(noAnswer(w.questions, "aborted"));
			return 1;
		}
	}
	return 0;
}

/** Wire answers in. Questions a previous worker left behind have nobody waiting; drop them. */
export function startAskBridge(): void {
	editPending(() => []).catch(() => undefined);
	chrome.storage.onChanged.addListener((changes, area) => {
		// Turning the bridge off in Settings ends every open question.
		if (area === "local" && changes.bridge_enabled?.newValue === false) cancelQuestionsFor(undefined);
		if (area !== "session") return;
		for (const key of Object.keys(changes)) {
			if (!key.startsWith(ANSWER_KEY_PREFIX)) continue;
			const reply = changes[key].newValue;
			if (reply === undefined) continue;
			receivePanelReply(key.slice(ANSWER_KEY_PREFIX.length), reply);
			chrome.storage.session.remove(key).catch(() => undefined);
		}
	});
}
