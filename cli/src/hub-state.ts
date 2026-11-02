/**
 * What the hub keeps on disk, all in the config dir at 0600: hub.json (the route), hub-devices.json
 * (enrolled devices, credentials as SHA-256 only), hub-codes.json (one-time connect codes, SHA-256
 * only) and hub-live.json (a snapshot the running hub writes so `hub devices` can show who is online).
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CODE_TTL_MS, type CodeRecord, findCode, hashCode, liveCodes, newCode, sameHash } from "./codes.ts";
import { configDir, readJsonFile, withFileLock, writeJsonPrivate } from "./files.ts";

export interface HubConfig {
	publicUrl: string;
	port: number;
}

export const hubFile = () => join(configDir(), "hub.json");
const devicesFile = () => join(configDir(), "hub-devices.json");
const codesFile = () => join(configDir(), "hub-codes.json");
export const liveFile = () => join(configDir(), "hub-live.json");

/** hub.json, or undefined when it doesn't exist. A file that exists but is wrong throws, so the hub never silently drops it. */
export function loadHubConfig(): HubConfig | undefined {
	if (!existsSync(hubFile())) return undefined;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(hubFile(), "utf8")) as Record<string, unknown>;
	} catch {
		throw new Error(`${hubFile()} isn't valid JSON. Run tabkyra hub off to remove it, then tabkyra hub setup again.`);
	}
	if (!raw || typeof raw !== "object") throw new Error(`${hubFile()} isn't a Tabkyra hub file.`);
	if (typeof raw.publicUrl !== "string" || !raw.publicUrl) throw new Error(`${hubFile()}: publicUrl is missing.`);
	if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 0 || raw.port > 65535) throw new Error(`${hubFile()}: port must be a port number.`);
	return { publicUrl: raw.publicUrl, port: raw.port };
}

export function saveHubConfig(config: HubConfig): void {
	writeJsonPrivate(hubFile(), config);
}

export function removeHubConfig(): void {
	rmSync(hubFile(), { force: true });
}

// ---------- Devices ----------

export interface DeviceRecord {
	id: string;
	name: string;
	/** SHA-256 of the secret half of the credential. The secret itself is shown once at enrollment. */
	sha256: string;
	manage: boolean;
	createdAt: string;
	lastSeen?: string;
	version?: string;
}

interface DevicesFile {
	devices: DeviceRecord[];
	prefer: string[];
}

export function loadDevices(): DevicesFile {
	try {
		const data = readJsonFile<Partial<DevicesFile>>(devicesFile(), {});
		return { devices: Array.isArray(data.devices) ? data.devices : [], prefer: Array.isArray(data.prefer) ? data.prefer.filter((x) => typeof x === "string") : [] };
	} catch {
		// An unreadable file authorizes no device.
		return { devices: [], prefer: [] };
	}
}

const saveDevices = (data: DevicesFile) => writeJsonPrivate(devicesFile(), data);

/** A device name: letters, digits, dot, dash, underscore and spaces, up to 40. */
export function validDeviceName(name: string): boolean {
	return /^[\w.][\w. -]{0,39}$/.test(name);
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const DUMMY_HASH = sha("no such device");

/** The device behind `<id>.<secret>`, compared in constant time; undefined for anything else. Reads the file each time, so a removal applies at once. */
export function authenticateDevice(credential: string | undefined): DeviceRecord | undefined {
	const m = /^([a-z0-9-]{6,40})\.([A-Za-z0-9_-]{40,60})$/.exec(credential ?? "");
	if (!m) return undefined;
	const device = loadDevices().devices.find((d) => d.id === m[1]);
	const matches = sameHash(device?.sha256 ?? DUMMY_HASH, sha(m[2]));
	return device && matches ? device : undefined;
}

/** Add a device. Fails when the name is taken. The credential is returned once. */
function addDevice(name: string, manage: boolean): { record: DeviceRecord; credential: string } {
	const data = loadDevices();
	if (data.devices.some((d) => d.name === name)) throw new HubStateError(409, `A device named ${name} is already enrolled. Remove it first (tabkyra hub remove ${name}) or pick another name.`);
	const id = `dv-${randomBytes(6).toString("hex")}`;
	const secret = randomBytes(32).toString("base64url");
	const record: DeviceRecord = { id, name, sha256: sha(secret), manage, createdAt: new Date().toISOString() };
	saveDevices({ ...data, devices: [...data.devices, record] });
	return { record, credential: `${id}.${secret}` };
}

/** Remove a device by name or id; its credential stops working at once. Returns the removed record. */
export function removeDevice(nameOrId: string): DeviceRecord | undefined {
	return withFileLock(devicesFile(), () => {
		const data = loadDevices();
		const gone = data.devices.find((d) => d.id === nameOrId || d.name === nameOrId);
		if (!gone) return undefined;
		saveDevices({ devices: data.devices.filter((d) => d !== gone), prefer: data.prefer.filter((n) => n !== gone.name) });
		return gone;
	});
}

export function setPrefer(names: string[]): void {
	withFileLock(devicesFile(), () => saveDevices({ ...loadDevices(), prefer: names }));
}

/** Record what the hub learned about a device (last seen, version). A device removed meanwhile stays removed. */
export function touchDevice(id: string, patch: { lastSeen?: string; version?: string }): void {
	withFileLock(devicesFile(), () => {
		const data = loadDevices();
		const device = data.devices.find((d) => d.id === id);
		if (!device) return;
		Object.assign(device, patch);
		saveDevices(data);
	});
}

export class HubStateError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

// ---------- Connect codes ----------

interface ConnectCode extends CodeRecord {
	/** The name the device must take, when the code was minted with one. */
	name?: string;
	manage: boolean;
}

const MAX_LIVE_CONNECT_CODES = 20;

function loadConnectCodes(): ConnectCode[] {
	try {
		const data = readJsonFile<{ codes?: ConnectCode[] }>(codesFile(), {});
		return Array.isArray(data.codes) ? data.codes : [];
	} catch {
		return [];
	}
}

/** A new connect code, shown once. */
export function mintConnectCode(options: { name?: string; manage?: boolean }, time = Date.now()): { code: string; expiresAt: number } {
	if (options.name !== undefined && !validDeviceName(options.name)) throw new HubStateError(400, "Device name: letters, digits, dot, dash, underscore or space, up to 40.");
	return withFileLock(codesFile(), () => {
		const live = liveCodes(loadConnectCodes(), time);
		if (live.length >= MAX_LIVE_CONNECT_CODES) throw new HubStateError(429, `${MAX_LIVE_CONNECT_CODES} connect codes are already waiting. Use or wait out one first.`);
		const code = newCode();
		const expiresAt = time + CODE_TTL_MS;
		writeJsonPrivate(codesFile(), { codes: [...live, { sha256: hashCode(code), expiresAt, createdAt: time, ...(options.name ? { name: options.name } : {}), manage: Boolean(options.manage) }] });
		return { code, expiresAt };
	});
}

/**
 * Redeem a connect code: a live match is removed, whatever happens next, and the device is enrolled
 * under the code's name or the name the device asked for. Returns undefined for a wrong, expired or
 * used code. A taken name fails before the code is spent.
 */
export function redeemConnectCode(typed: string, wantedName: string, time = Date.now()): { record: DeviceRecord; credential: string } | undefined {
	return withFileLock(codesFile(), () => {
		const live = liveCodes(loadConnectCodes(), time);
		const at = findCode(live, typed, time);
		if (at < 0) {
			writeJsonPrivate(codesFile(), { codes: live });
			return undefined;
		}
		const entry = live[at];
		const name = entry.name ?? wantedName;
		if (!validDeviceName(name)) throw new HubStateError(400, "Device name: letters, digits, dot, dash, underscore or space, up to 40.");
		const made = withFileLock(devicesFile(), () => addDevice(name, entry.manage));
		writeJsonPrivate(codesFile(), { codes: live.filter((_, i) => i !== at) });
		return made;
	});
}

// ---------- Live snapshot ----------

export interface LiveDevice {
	id: string;
	name: string;
	online: boolean;
	extensionConnected: boolean;
	sessions: number;
	busy: boolean;
	lastSeen: string | null;
	version: string | null;
	browser: string | null;
}

export interface LiveSnapshot {
	pid: number;
	updatedAt: number;
	devices: LiveDevice[];
}

export function writeLive(snapshot: LiveSnapshot): void {
	writeJsonPrivate(liveFile(), snapshot);
}

/** The running hub's snapshot, or undefined when there is none or it is stale (the hub is not running). */
export function readLive(maxAgeMs = 30_000): LiveSnapshot | undefined {
	try {
		const data = readJsonFile<LiveSnapshot | undefined>(liveFile(), undefined);
		if (!data || typeof data.updatedAt !== "number" || Date.now() - data.updatedAt > maxAgeMs || !Array.isArray(data.devices)) return undefined;
		return data;
	} catch {
		return undefined;
	}
}
