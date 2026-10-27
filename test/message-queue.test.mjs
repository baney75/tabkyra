// The side panel's message queue: messages sent while the agent runs, and "Send now".
import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageQueue } from "../node_modules/@mariozechner/pi-web-ui/dist/utils/message-queue.js";

const settle = () => new Promise((r) => setTimeout(r, 20));

function setup() {
	const agent = { state: { isStreaming: true }, steered: [], steer(m) { this.steered.push(m); }, clearSteeringQueue() { this.steered = []; } };
	const sent = [];
	const queue = new MessageQueue(() => agent, (input) => sent.push(input), () => {}, 1);
	return { agent, sent, queue };
}
const end = (stopReason = "stop") => [{ role: "assistant", stopReason }];

test("messages sent while the agent runs go out in order, one per finished run", async () => {
	const { agent, sent, queue } = setup();
	queue.add("first");
	queue.add("second");
	assert.deepEqual(sent, []);
	agent.state.isStreaming = false;
	queue.onAgentEnd(end());
	await settle();
	assert.deepEqual(sent, ["first"]);
	assert.deepEqual(queue.items.map((q) => q.input), ["second"]);
	queue.onAgentEnd(end());
	await settle();
	assert.deepEqual(sent, ["first", "second"]);
});

test("the next item waits until the agent has actually stopped streaming", async () => {
	const { agent, sent, queue } = setup();
	queue.add("next");
	queue.onAgentEnd(end()); // agent_end fires before isStreaming clears
	await settle();
	assert.deepEqual(sent, []);
	agent.state.isStreaming = false;
	await settle();
	assert.deepEqual(sent, ["next"]);
});

test("Send now steers the running agent and leaves the list once it is injected", () => {
	const { agent, sent, queue } = setup();
	queue.add("a");
	queue.add("b");
	queue.sendNow(queue.items[1].id);
	assert.equal(agent.steered.length, 1);
	assert.deepEqual(agent.steered[0].content, [{ type: "text", text: "b" }]);
	assert.deepEqual(sent, [], "steered, not prompted");
	queue.remove(queue.items[1].id);
	assert.equal(queue.items.length, 2, "a message already handed to the agent can't be removed");
	queue.onMessageStart(agent.steered[0]);
	assert.deepEqual(queue.items.map((q) => q.input), ["a"]);
});

test("a steer the agent never picked up goes out as the next prompt", async () => {
	const { agent, sent, queue } = setup();
	queue.add("late");
	queue.sendNow(queue.items[0].id);
	agent.state.isStreaming = false;
	queue.onAgentEnd(end());
	assert.deepEqual(agent.steered, [], "the agent's steering queue is cleared");
	await settle();
	assert.deepEqual(sent, ["late"]);
});

test("Stop pauses the queue; removing doesn't resume it, Send now does", async () => {
	const { agent, sent, queue } = setup();
	queue.add("one");
	queue.add("two");
	queue.add("three");
	agent.state.isStreaming = false;
	queue.onAgentEnd(end("aborted"));
	await settle();
	assert.equal(queue.paused, true);
	assert.deepEqual(sent, []);
	queue.remove(queue.items[0].id);
	await settle();
	assert.deepEqual(sent, [], "remove does not resume");
	// A fresh message the user sends (not from the queue) ends normally; the queue stays paused.
	queue.onAgentEnd(end());
	await settle();
	assert.deepEqual(sent, []);
	queue.sendNow(queue.items[1].id);
	assert.deepEqual(sent, ["three"], "Send now with nothing running prompts at once");
	assert.equal(queue.paused, false);
	queue.onAgentEnd(end());
	await settle();
	assert.deepEqual(sent, ["three", "two"], "the rest follow");
});

test("an error pauses the queue too, and an empty queue is never paused", () => {
	const { agent, queue } = setup();
	queue.add("x");
	agent.state.isStreaming = false;
	queue.onAgentEnd(end("error"));
	assert.equal(queue.paused, true);
	queue.remove(queue.items[0].id);
	assert.equal(queue.paused, false);
});
