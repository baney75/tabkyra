// The side panel's message queue: messages sent while the agent runs, and "Send now".
import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageQueue } from "../node_modules/@mariozechner/pi-web-ui/dist/utils/message-queue.js";

const settle = () => new Promise((r) => setTimeout(r, 10));
const end = (stopReason = "stop") => [{ role: "assistant", stopReason }];
const text = (m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join(""));

/** A fake agent with a run lifecycle; `result` decides what each send reports. */
function setup({ result = () => "started", context } = {}) {
	let idle = Promise.resolve();
	let finish = () => {};
	const agent = {
		state: { isStreaming: false },
		steered: [],
		steer(m) { this.steered.push(m); },
		clearSteeringQueue() { this.steered = []; },
		waitForIdle: () => idle,
	};
	const sent = [];
	const queue = new MessageQueue(
		agent,
		async (item) => { const r = result(item); if (r === "started") { sent.push(item.input); start(); } return r; },
		() => {},
		context,
	);
	function start() { agent.state.isStreaming = true; idle = new Promise((r) => (finish = r)); queue.onAgentStart(); }
	function stop(stopReason) { agent.state.isStreaming = false; queue.onAgentEnd(end(stopReason)); finish(); }
	return { agent, sent, queue, start, stop };
}

test("messages sent while the agent runs go out in order, one per finished run", async () => {
	const { sent, queue, start, stop } = setup();
	start();
	queue.add("first");
	queue.add("second");
	assert.deepEqual(sent, []);
	stop();
	await settle();
	assert.deepEqual(sent, ["first"]);
	stop();
	await settle();
	assert.deepEqual(sent, ["first", "second"]);
	assert.equal(queue.items.length, 0);
});

test("the next item waits for the agent's idle signal", async () => {
	const { agent, sent, queue, start } = setup();
	start();
	queue.add("next");
	let release;
	agent.waitForIdle = () => new Promise((r) => (release = r));
	agent.state.isStreaming = false;
	queue.onAgentEnd(end());
	await settle();
	assert.deepEqual(sent, [], "not before idle");
	release();
	await settle();
	assert.deepEqual(sent, ["next"]);
});

test("Send now steers the running agent; the item leaves the list once injected and can't be removed before", async () => {
	const { agent, sent, queue, start } = setup();
	start();
	queue.add("a");
	queue.add("b");
	await queue.sendNow(queue.items[1].id);
	assert.equal(agent.steered.length, 1);
	assert.equal(text(agent.steered[0]), "b");
	assert.deepEqual(sent, []);
	queue.remove(queue.items[1].id);
	assert.equal(queue.items.length, 2);
	queue.onMessageStart(agent.steered[0]);
	assert.deepEqual(queue.items.map((q) => q.input), ["a"]);
});

test("Send now delivers the page context first", async () => {
	const note = { role: "navigation", url: "https://example.com/" };
	const { agent, queue, start } = setup({ context: async () => [note] });
	start();
	queue.add("what does this page say?");
	await queue.sendNow(queue.items[0].id);
	assert.equal(agent.steered[0], note);
	assert.equal(text(agent.steered[1]), "what does this page say?");
});

test("a Send now the agent never picked up goes out before older items", async () => {
	const { agent, sent, queue, start, stop } = setup();
	start();
	queue.add("a");
	queue.add("b");
	await queue.sendNow(queue.items[1].id);
	stop();
	assert.deepEqual(agent.steered, [], "the agent's steering queue is cleared");
	await settle();
	assert.deepEqual(sent, ["b"]);
	stop();
	await settle();
	assert.deepEqual(sent, ["b", "a"]);
});

test("Send now right after a run ends is sent once, not steered into the finished run", async () => {
	const { agent, sent, queue, start, stop } = setup();
	start();
	queue.add("a");
	queue.add("b");
	stop(); // agent_end has fired; the drain hasn't sent yet
	await queue.sendNow(queue.items[1].id);
	await settle();
	assert.deepEqual(agent.steered, [], "nothing steered into the finished run");
	assert.deepEqual(sent, ["b"], "b first, once");
	assert.deepEqual(queue.items.map((q) => q.input), ["a"]);
});

test("Stop pauses; removing doesn't resume; Send now resumes, also when it steers a new run", async () => {
	const { sent, queue, start, stop } = setup();
	start();
	queue.add("one");
	queue.add("two");
	queue.add("three");
	stop("aborted");
	await settle();
	assert.equal(queue.paused, true);
	queue.remove(queue.items[0].id);
	await settle();
	assert.deepEqual(sent, []);
	// The user sends a fresh message; the queue stays paused through that run...
	start();
	// ...until Send now, which steers into it and resumes.
	await queue.sendNow(queue.items[1].id);
	assert.equal(queue.paused, false);
	stop(); // ended before the steer was picked up
	await settle();
	assert.deepEqual(sent, ["three"]);
	stop();
	await settle();
	assert.deepEqual(sent, ["three", "two"]);
});

test("a refused send goes back on top and pauses; a busy one goes back without pausing", async () => {
	let answer = "refused";
	const { sent, queue, start, stop } = setup({ result: () => answer });
	start();
	queue.add("x");
	queue.add("y");
	stop();
	await settle();
	assert.deepEqual(queue.items.map((q) => q.input), ["x", "y"]);
	assert.equal(queue.paused, true);
	answer = "busy";
	await queue.sendNow(queue.items[0].id);
	await settle();
	assert.deepEqual(queue.items.map((q) => q.input), ["x", "y"]);
	assert.equal(queue.paused, false);
	answer = "started";
	stop();
	await settle();
	assert.deepEqual(sent, ["x"]);
});

test("an error pauses the queue, and an empty queue is never paused", () => {
	const { queue, start, stop } = setup();
	start();
	queue.add("x");
	stop("error");
	assert.equal(queue.paused, true);
	queue.remove(queue.items[0].id);
	assert.equal(queue.paused, false);
});

test("dispose clears the agent's steering and the list", async () => {
	const { agent, queue, start } = setup();
	start();
	queue.add("a");
	await queue.sendNow(queue.items[0].id);
	queue.dispose();
	assert.deepEqual(agent.steered, []);
	assert.equal(queue.items.length, 0);
});
