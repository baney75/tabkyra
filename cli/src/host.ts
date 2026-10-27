/**
 * Native messaging host. The browser spawns this process when the extension
 * connects; it owns the unix socket harness clients dial and relays frames both
 * ways, adding `clientId` on the way in and stripping it on the way out.
 * No browser logic lives here.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { ClientToHost, ExtToHost, HostToClient, HostToExt } from "../../src/bridge/protocol.ts";
import { MAX_FRAME_FROM_EXTENSION, MAX_FRAME_TO_EXTENSION } from "../../src/bridge/protocol.ts";
import { encodeFrame, FrameParser } from "./framing.ts";
import { socketDir, socketPath } from "./paths.ts";
import { handleUpdateAction, noteHello, sendStatus, startUpdateTimer } from "./update-host.ts";
import { VERSION } from "./version.ts";

interface Client {
	id: string;
	socket: Socket;
	hello?: ClientToHost & { type: "hello" };
	/** Request ids forwarded to the extension and not answered yet. */
	outstanding: Set<number>;
}

const clients = new Map<string, Client>();
let extensionReady = false;
let seq = 0;
/** Set once the host has decided to exit; no request is forwarded after that. */
let stopping = false;

/** Write a frame to the extension; false when it was refused as oversized. */
function toExtension(message: HostToExt): boolean {
	const frame = encodeFrame(message);
	if (frame.length > MAX_FRAME_TO_EXTENSION) {
		// Never let one oversized frame kill the native port.
		const failing = message as { clientId?: string; id?: number };
		if (failing.clientId && failing.id !== undefined) {
			toClient(failing.clientId, {
				type: "response",
				id: failing.id,
				error: { code: "bad_params", message: `Request exceeds ${MAX_FRAME_TO_EXTENSION} bytes` },
			});
		}
		return false;
	}
	process.stdout.write(frame);
	return true;
}

function toClient(clientId: string, message: HostToClient): void {
	const client = clients.get(clientId);
	if (!client || client.socket.destroyed || !client.socket.writable) return;
	client.socket.write(encodeFrame(message));
}

function onExtensionMessage(message: ExtToHost): void {
	switch (message.type) {
		case "hello":
			extensionReady = true;
			noteHello(message);
			void sendStatus(toExtension);
			for (const id of clients.keys()) toClient(id, { type: "extension_status", connected: true });
			// The extension restarted; re-announce every live client so it recreates sessions.
			for (const client of clients.values()) {
				if (client.hello) toExtension({ type: "client_connected", clientId: client.id, client: client.hello.client });
			}
			return;
		case "response":
			clients.get(message.clientId)?.outstanding.delete(message.id);
			toClient(message.clientId, { type: "response", id: message.id, result: message.result, error: message.error });
			return;
		case "event":
			if (message.clientId) toClient(message.clientId, { type: "event", event: message.event, data: message.data });
			else for (const id of clients.keys()) toClient(id, { type: "event", event: message.event, data: message.data });
			return;
		case "pong":
			return;
		case "update_action":
			// Parsed again strictly inside: only {type, action} with a known action runs anything.
			handleUpdateAction(message, toExtension);
			return;
	}
}

function onClientMessage(client: Client, message: ClientToHost): void {
	if (message.type === "hello") {
		client.hello = message;
		toClient(client.id, { type: "welcome", clientId: client.id, hostVersion: VERSION, extensionConnected: extensionReady });
		toExtension({ type: "client_connected", clientId: client.id, client: message.client });
		return;
	}
	if (message.type === "request") {
		if (!client.hello) {
			toClient(client.id, { type: "response", id: message.id, error: { code: "bad_params", message: "Send hello first" } });
			return;
		}
		if (stopping) {
			// Never forward now: the reply could not come back, and the client would retry it.
			toClient(client.id, { type: "response", id: message.id, error: restartError("the bridge is restarting", false) });
			return;
		}
		if (toExtension({ type: "request", clientId: client.id, id: message.id, method: message.method, params: message.params }))
			client.outstanding.add(message.id);
	}
}

/**
 * The extension sent a frame we could not read, so one reply is lost and we can't tell whose.
 * Answer every unanswered request with an RPC error (clients never retry those, so nothing
 * runs twice), then restart: Chrome closes the port, the extension reconnects and spawns a
 * fresh host, and later calls dial the new socket.
 */
function failOutstanding(reason: string): void {
	for (const client of clients.values()) {
		for (const id of client.outstanding) {
			toClient(client.id, {
				type: "response",
				id,
				error: restartError(`the browser's reply was lost (${reason}); the bridge is restarting`, true),
			});
		}
		client.outstanding.clear();
	}
}

/** An RPC error, which clients never retry, so a request is not sent twice. */
function restartError(what: string, mayHaveRun: boolean): { code: string; message: string } {
	const next = mayHaveRun
		? "The request may have run: check the page before repeating it."
		: "The request was not sent; repeat it in a few seconds.";
	return { code: "internal", message: `${what[0].toUpperCase()}${what.slice(1)}. ${next}` };
}

function sweepStaleSockets(dir: string): void {
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".sock")) continue;
		const pid = Number.parseInt(name, 10);
		if (!Number.isInteger(pid)) continue;
		try {
			process.kill(pid, 0);
		} catch {
			rmSync(join(dir, name), { force: true });
		}
	}
}

export function runNativeHost(): void {
	const dir = socketDir();
	if (process.platform !== "win32") {
		if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
		chmodSync(dir, 0o700);
		const st = statSync(dir);
		if (st.uid !== process.getuid?.()) {
			process.stderr.write(`[tabkyra-host] ${dir} is owned by another user; refusing to start\n`);
			process.exit(1);
		}
		sweepStaleSockets(dir);
	}
	const path = socketPath(process.pid);
	rmSync(path, { force: true });

	const server = createServer((socket) => {
		const id = `c${++seq}-${process.pid}`;
		const client: Client = { id, socket, outstanding: new Set() };
		clients.set(id, client);
		const parser = new FrameParser(MAX_FRAME_TO_EXTENSION);
		socket.on("data", (chunk) => {
			const { messages, error } = parser.push(chunk);
			for (const m of messages) onClientMessage(client, m as ClientToHost);
			if (error) {
				process.stderr.write(`[tabkyra-host] bad frame from ${id}: ${String(error)}\n`);
				socket.destroy();
			}
		});
		const drop = () => {
			if (!clients.delete(id)) return;
			toExtension({ type: "client_disconnected", clientId: id });
		};
		socket.on("close", drop);
		socket.on("error", drop);
	});
	server.listen(path, () => {
		if (process.platform !== "win32") chmodSync(path, 0o600);
	});

	// stdin: frames from the extension
	const parser = new FrameParser(MAX_FRAME_FROM_EXTENSION);
	process.stdin.on("data", (chunk: Buffer) => {
		if (stopping) return;
		const { messages, error } = parser.push(chunk);
		for (const m of messages) onExtensionMessage(m as ExtToHost);
		if (error) {
			process.stderr.write(`[tabkyra-host] bad frame from extension, restarting: ${String(error)}\n`);
			stopping = true;
			failOutstanding(error.message);
			shutdown(1);
		}
	});

	let exiting = false;
	const shutdown = (code = 0) => {
		if (exiting) return;
		exiting = true;
		stopping = true;
		server.close();
		rmSync(path, { force: true });
		// end() flushes what is queued (the answers above) before closing; destroy() would drop it.
		for (const client of clients.values()) client.socket.end();
		const exit = setTimeout(() => process.exit(code), 500);
		const open = [...clients.values()].filter((c) => !c.socket.destroyed);
		if (open.length === 0) {
			clearTimeout(exit);
			process.exit(code);
		}
		let left = open.length;
		for (const c of open)
			c.socket.once("close", () => {
				if (--left === 0) {
					clearTimeout(exit);
					process.exit(code);
				}
			});
	};
	process.stdin.on("end", () => shutdown());
	process.on("SIGINT", () => shutdown());
	process.on("SIGTERM", () => shutdown());

	const ping = setInterval(() => toExtension({ type: "ping" }), 20000);
	ping.unref();
	startUpdateTimer(toExtension);
}
