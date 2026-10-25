/**
 * `tabkyra tunnel`: reach `tabkyra serve` from another device or a cloud agent through a
 * tunnel the user owns, which terminates TLS. Nothing is exposed until the user runs one.
 *
 * - tailscale: `tailscale serve` publishes https://<this machine>.<tailnet>.ts.net/tabkyra
 *   to the user's own tailnet only. `--public` uses `tailscale funnel` instead, which is
 *   reachable from the internet; the token is then the only lock, so it warns.
 * - cloudflare: a `cloudflared` quick tunnel (free, no account) gives a random
 *   https://*.trycloudflare.com URL. For a stable name the user creates a free Cloudflare
 *   account and a named tunnel themselves; Tabkyra prints the steps and never makes accounts.
 *
 * Tabkyra doesn't install either tool.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { which } from "./harness.ts";

export const DEFAULT_PORT = 8787;
const SERVE_PATH = "/tabkyra";

function configDir(): string {
	return process.env.TABKYRA_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tabkyra");
}

function run(cmd: string, args: string[]): { code: number; out: string } {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
	return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export interface TunnelResult {
	url?: string;
	message: string;
	ok: boolean;
}

export function tailscaleTunnel(options: { port: number; public: boolean; off: boolean }): TunnelResult {
	const bin = which("tailscale");
	if (!bin) return { ok: false, message: "Tailscale isn't installed. Install it from tailscale.com and sign in, then run this again." };
	const mode = options.public ? "funnel" : "serve";
	if (options.off) {
		const r = run(bin, [mode, "--https=443", `--set-path=${SERVE_PATH}`, "off"]);
		return { ok: r.code === 0, message: r.code === 0 ? `Stopped the Tailscale ${mode} for ${SERVE_PATH}.` : r.out };
	}
	const status = run(bin, ["status", "--json"]);
	let dns = "";
	try {
		dns = String((JSON.parse(status.out) as { Self?: { DNSName?: string } }).Self?.DNSName ?? "").replace(/\.$/, "");
	} catch {
		/* reported below */
	}
	if (!dns) return { ok: false, message: "Tailscale isn't connected. Run tailscale up, then try again." };
	const r = run(bin, [mode, "--bg", "--yes", "--https=443", `--set-path=${SERVE_PATH}`, `http://127.0.0.1:${options.port}`]);
	if (r.code !== 0) return { ok: false, message: r.out };
	const url = `https://${dns}${SERVE_PATH}/mcp`;
	const reach = options.public ? "anyone on the internet who has a token" : "your own tailnet devices that have a token";
	return { ok: true, url, message: `MCP is reachable at ${url} by ${reach}. Run tabkyra serve on port ${options.port}.` };
}

function cloudflaredPidFile(): string {
	return join(configDir(), "cloudflared.pid");
}

export async function cloudflareTunnel(options: { port: number; off: boolean; timeoutMs?: number }): Promise<TunnelResult> {
	if (options.off) {
		if (!existsSync(cloudflaredPidFile())) return { ok: true, message: "No Cloudflare tunnel is running." };
		const pid = Number(readFileSync(cloudflaredPidFile(), "utf8"));
		try {
			if (Number.isInteger(pid) && pid > 1) process.kill(pid);
		} catch {
			/* already gone */
		}
		rmSync(cloudflaredPidFile(), { force: true });
		return { ok: true, message: "Stopped the Cloudflare tunnel." };
	}
	const bin = which("cloudflared");
	if (!bin) {
		return {
			ok: false,
			message:
				"cloudflared isn't installed. Install it from Cloudflare (developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads), then run this again. A quick tunnel needs no account.",
		};
	}
	mkdirSync(configDir(), { recursive: true });
	const log = join(configDir(), "cloudflared.log");
	writeFileSync(log, "");
	const fd = openSync(log, "a");
	const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${options.port}`], { detached: true, stdio: ["ignore", fd, fd] });
	child.unref();
	if (child.pid) writeFileSync(cloudflaredPidFile(), String(child.pid));
	const deadline = Date.now() + (options.timeoutMs ?? 30_000);
	while (Date.now() < deadline) {
		const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(readFileSync(log, "utf8"));
		if (m) return { ok: true, url: `${m[0]}/mcp`, message: `MCP is reachable at ${m[0]}/mcp by anyone who has a token. The URL changes each time; for a fixed name, set up a named tunnel in your own Cloudflare account.` };
		await new Promise((r) => setTimeout(r, 250));
	}
	return { ok: false, message: `cloudflared started but printed no URL in time. See ${log}.` };
}
