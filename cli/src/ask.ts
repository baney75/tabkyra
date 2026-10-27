/**
 * The ask_user MCP tool: an external agent asks the user 1 to 4 multiple-choice questions in the
 * Tabkyra side panel and waits for the answer (src/ask/bridge-worker.ts shows it there). The
 * answer comes back only to the session that asked. Remote sessions need the `user.ask` scope.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ASK_BRIDGE_TIMEOUT_MS, ASK_LIMITS, ASK_USER_DESCRIPTION, type AskOutcome, noAnswer, outcomeText, validateAskParams } from "../../src/ask/core.ts";
import { type BridgeClient, BridgeRpcError, isConnectionError, NOT_CONNECTED } from "./client.ts";

/** The one line the server instructions add about it (dropped when a session lacks the tool). */
export const ASK_USER_INSTRUCTION =
	"When you need a decision only the user can make and the answer changes what you do (which of several options, a preference, an ambiguous request), call ask_user instead of guessing; don't use it for routine confirmations. If it returns No answer, don't assume one.";

export const askUserInputSchema = {
	questions: z
		.array(
			z.object({
				header: z.string().min(1).max(ASK_LIMITS.header).describe('A short label, a few words, e.g. "Format"'),
				question: z.string().min(1).max(ASK_LIMITS.question).describe("The question, as a full sentence"),
				options: z
					.array(
						z.object({
							label: z.string().min(1).max(ASK_LIMITS.label).describe('The choice, 1 to 5 words. Add "(Recommended)" to the one you recommend'),
							description: z.string().max(ASK_LIMITS.description).describe("One line on what this choice means"),
						}),
					)
					.min(ASK_LIMITS.minOptions)
					.max(ASK_LIMITS.maxOptions),
				multiSelect: z.boolean().optional().describe("true lets the user pick more than one option"),
			}),
		)
		.min(ASK_LIMITS.minQuestions)
		.max(ASK_LIMITS.maxQuestions)
		.describe("1 to 4 questions, shown together on one card"),
};

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Turn the bridge's reply (or failure) into what the model reads. Exported for tests. */
export function askResultText(questions: AskOutcome["questions"], reply: unknown, err?: unknown): ToolResult {
	if (err === undefined) {
		const r = reply as Partial<AskOutcome> & { text?: unknown };
		if (typeof r?.text === "string" && (r.status === "answered" || r.status === "no_answer")) return { content: [{ type: "text", text: r.text }] };
		return { content: [{ type: "text", text: "Tabkyra returned an unexpected reply to ask_user." }], isError: true };
	}
	if (err instanceof BridgeRpcError) {
		if (err.rpc.code === "not_found")
			return { content: [{ type: "text", text: "This Tabkyra extension doesn't support ask_user yet. Ask the user to update Tabkyra, and ask your question in the chat instead." }], isError: true };
		return { content: [{ type: "text", text: `${err.rpc.code}: ${err.rpc.message}` }], isError: true };
	}
	const message = err instanceof Error ? err.message : String(err);
	if (/timed out after/.test(message)) return { content: [{ type: "text", text: outcomeText(noAnswer(questions, "timeout")) }] };
	if (message === NOT_CONNECTED && reply === "asked") return { content: [{ type: "text", text: outcomeText(noAnswer(questions, "disconnected")) }] };
	if (message === NOT_CONNECTED || isConnectionError(err)) return { content: [{ type: "text", text: NOT_CONNECTED }], isError: true };
	return { content: [{ type: "text", text: message }], isError: true };
}

export function registerAskUser(server: McpServer, client: BridgeClient): void {
	server.registerTool(
		"ask_user",
		{
			title: "Ask the user",
			description:
				`${ASK_USER_DESCRIPTION} The question shows in the Tabkyra side panel (the toolbar icon gets a badge when the panel is closed) and waits up to ` +
				`${ASK_BRIDGE_TIMEOUT_MS / 60000} minutes. ` +
				'Example: {"questions":[{"header":"Format","question":"Which format should the report use?","options":[{"label":"PDF (Recommended)","description":"One file that prints cleanly"},{"label":"Markdown","description":"Plain text you can edit"}]}]}',
			inputSchema: askUserInputSchema,
		},
		async (args): Promise<ToolResult> => {
			let questions: AskOutcome["questions"];
			try {
				questions = validateAskParams(args).questions;
			} catch (err) {
				return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
			}
			let sent = false;
			try {
				if (!client.connected) await client.connect();
				// A host with no extension behind it has no panel to show the question in.
				if (!client.extensionConnected) return { content: [{ type: "text", text: NOT_CONNECTED }], isError: true };
				sent = true;
				// No retry: a retry after a dropped bridge would ask the user a second time.
				const reply = await client.call("ask_user", { questions }, ASK_BRIDGE_TIMEOUT_MS + 30_000, { retry: false });
				return askResultText(questions, reply);
			} catch (err) {
				return askResultText(questions, sent ? "asked" : undefined, err);
			}
		},
	);
}
