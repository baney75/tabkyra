/**
 * Small private-file helpers for the config directory: JSON read/write at 0600 with an atomic
 * rename, and an exclusive lock file for read-modify-write across processes.
 */

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The parsed JSON file, or `fallback` when it doesn't exist. A file that exists but isn't JSON throws. */
export function readJsonFile<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Write JSON with mode 0600 through a temp file, so a reader never sees half a file. */
export function writeJsonPrivate(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

/** A lock file stayed held past the caller's patience. Request handlers map it to 503. */
export class LockTimeoutError extends Error {}

const STALE_LOCK_MS = 30_000;

function isStale(file: string): boolean {
	try {
		return Date.now() - statSync(file).mtimeMs > STALE_LOCK_MS;
	} catch {
		return false;
	}
}

/** One read of the lock file as it is now: who wrote it, and an id no later lock file can share. */
function lockSnapshot(lock: string): { id: string; text: string; stale: boolean } | undefined {
	let fd: number;
	try {
		fd = openSync(lock, "r");
	} catch {
		return undefined;
	}
	try {
		const { ino, mtimeMs } = fstatSync(fd);
		const text = readFileSync(fd, "utf8");
		const id = createHash("sha256").update(`${ino}:${mtimeMs}:${text}`).digest("hex").slice(0, 16);
		return { id, text, stale: Date.now() - mtimeMs > STALE_LOCK_MS };
	} finally {
		closeSync(fd);
	}
}

function processGone(file: string): boolean {
	try {
		process.kill(Number(readFileSync(file, "utf8")), 0);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/**
 * The sole right to remove the lock file with this id, or undefined while someone else has it. Claim
 * files are named for that one lock, so a late claim can only ever concern a lock already gone. A
 * claim is taken over only when its owner's process is dead, by claiming the next number; nothing
 * is deleted to take over, and a process that is merely slow keeps its claim. Returns the release.
 */
function claimLock(lock: string, id: string): (() => void) | undefined {
	const base = `${lock}.reap.${id}`;
	const tmp = `${base}.${randomBytes(8).toString("hex")}.tmp`;
	writeFileSync(tmp, String(process.pid), { mode: 0o600 });
	try {
		for (let n = 0; ; n++) {
			try {
				linkSync(tmp, `${base}.${n}`);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "EEXIST" && processGone(`${base}.${n}`)) continue;
				return undefined;
			}
			return () => {
				for (let i = 0; i <= n; i++) rmSync(`${base}.${i}`, { force: true });
			};
		}
	} finally {
		rmSync(tmp, { force: true });
	}
}

/** Remove the lock file, if it is still the one `allowed` accepts, under that lock's claim. */
function removeClaimed(lock: string, allowed: (seen: NonNullable<ReturnType<typeof lockSnapshot>>) => boolean): boolean {
	try {
		const seen = lockSnapshot(lock);
		if (!seen || !allowed(seen)) return false;
		const release = claimLock(lock, seen.id);
		if (!release) return false;
		try {
			if (lockSnapshot(lock)?.id !== seen.id) return false;
			rmSync(lock, { force: true });
			return true;
		} finally {
			release();
		}
	} catch {
		// Unreadable or unwritable: the lock stays until it can be recovered as stale.
		return false;
	}
}

/**
 * Remove `lock` if it is stale, and say whether it did. Two processes can see the same stale lock:
 * the claim lets one remove it, and the other finds the name holds a different lock or none.
 */
function reapStaleLock(lock: string): boolean {
	return removeClaimed(lock, (seen) => seen.stale);
}

/**
 * Run `fn` holding an exclusive lock file next to `path`; gives up after `timeoutMs`. A lock older than 30 seconds is stale.
 * The lock records an owner token and is removed only while it still holds that token, so a holder whose lock
 * was taken as stale never deletes the next holder's lock.
 */
export function withFileLock<T>(path: string, fn: () => T, timeoutMs = 10_000): T {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lock = `${path}.lock`;
	const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			writeFileSync(lock, token, { flag: "wx" });
			break;
		} catch {
			if (isStale(lock) && reapStaleLock(lock)) continue;
			if (Date.now() > deadline) throw new LockTimeoutError(`${path} is locked (${lock}).`);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}
	}
	try {
		return fn();
	} finally {
		removeClaimed(lock, (seen) => seen.text === token);
	}
}

/**
 * Like `withFileLock`, for work that awaits while it holds the lock. The wait polls with a timer, so
 * the event loop keeps running meanwhile. Same lock file, same 30-second stale rule, so hold it only
 * for short work (a check and a write), never across a network call or a service manager. The lock
 * records an owner token (pid and a random nonce) and is removed only while it still holds that
 * token, so a holder whose lock was taken as stale never deletes the next holder's lock.
 */
export async function withFileLockAsync<T>(path: string, fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lock = `${path}.lock`;
	const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			writeFileSync(lock, token, { flag: "wx" });
			break;
		} catch {
			if (isStale(lock) && reapStaleLock(lock)) continue;
			if (Date.now() > deadline) throw new LockTimeoutError(`${path} is locked (${lock}).`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	try {
		return await fn();
	} finally {
		removeClaimed(lock, (seen) => seen.text === token);
	}
}

/** The Tabkyra config directory. TABKYRA_CONFIG_DIR overrides it (tests use a temp one). */
export function configDir(): string {
	return process.env.TABKYRA_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tabkyra");
}
