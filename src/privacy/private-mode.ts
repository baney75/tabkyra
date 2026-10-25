/**
 * Private mode: the side panel agent may only send prompts where the data is not kept.
 * That means OpenRouter with zero-data-retention routing enforced on every request
 * (provider.zdr, data_collection "deny", no fallbacks to other endpoints), or a model
 * served from this machine, the local network, or a host the user has named as their own
 * (for example their tailnet machines). Every other provider is refused at the stream gate,
 * whatever model was left selected.
 * OpenRouter docs: https://openrouter.ai/docs/guides/routing/provider-selection
 */

export const PRIVATE_MODE_KEY = "privacy.privateMode";
/** Host names the user trusts as their own, such as tailnet machines (mac.tail1234.ts.net). */
export const TRUSTED_HOSTS_KEY = "privacy.trustedHosts";

/** Sent as OpenRouter's `provider` object; account-level ZDR settings still apply on top. */
export const OPENROUTER_PRIVATE_ROUTING = { zdr: true, data_collection: "deny", allow_fallbacks: false } as const;

/**
 * The only pi-ai adapter that sends `compat.openRouterRouting` as OpenRouter's `provider`
 * object. A model on any other adapter would go out without the routing, so it's refused.
 */
const ROUTING_API = "openai-completions";

export class PrivateModeError extends Error {
	constructor(what: string) {
		super(
			`Private mode is on, so ${what} can't be used: it doesn't guarantee your prompts aren't kept. Pick an OpenRouter model (sent with zero data retention) or a model on your own machine or network, or turn private mode off in Settings > Privacy.`,
		);
		this.name = "PrivateModeError";
	}
}

function ipv4(host: string): number[] | undefined {
	const parts = host.split(".").map(Number);
	return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : undefined;
}

/**
 * A base URL on this machine, the local network, or a host the user listed as their own.
 * `*.ts.net` and 100.64.0.0/10 are not trusted on their own: Funnel publishes `*.ts.net`
 * names to the internet, and 100.64.0.0/10 is also ISPs' carrier-grade NAT space.
 */
export function isLocalBaseUrl(baseUrl: string, trustedHosts: string[] = []): boolean {
	let host: string;
	try {
		host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
	} catch {
		return false;
	}
	if (trustedHosts.some((t) => t.trim().toLowerCase() === host)) return true;
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1") return true;
	const ip = ipv4(host);
	if (!ip) return false;
	const [a, b] = ip;
	return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export interface RoutableModel {
	provider: string;
	baseUrl: string;
	api?: string;
	compat?: object;
}

/** The model to send in private mode, with ZDR routing added; throws for a provider that isn't allowed. */
export function privateModel<M extends RoutableModel>(model: M, trustedHosts: string[] = []): M {
	if (isLocalBaseUrl(model.baseUrl, trustedHosts)) return model;
	let host = "";
	try {
		host = new URL(model.baseUrl).hostname;
	} catch {
		/* not a URL: refused below */
	}
	if (
		model.provider === "openrouter" &&
		model.api === ROUTING_API &&
		(host === "openrouter.ai" || host.endsWith(".openrouter.ai"))
	) {
		const compat = (model.compat ?? {}) as { openRouterRouting?: object };
		return {
			...model,
			compat: {
				...compat,
				openRouterRouting: { ...(compat.openRouterRouting ?? {}), ...OPENROUTER_PRIVATE_ROUTING },
			},
		};
	}
	throw new PrivateModeError(model.provider);
}

/** A CORS proxy would see every prompt, so private mode allows only one on the user's own machines. */
export function assertPrivateProxy(
	enabled: boolean | null | undefined,
	proxyUrl: string | null | undefined,
	trustedHosts: string[] = [],
): void {
	if (enabled && proxyUrl && !isLocalBaseUrl(proxyUrl, trustedHosts))
		throw new PrivateModeError("the CORS proxy in Settings > Proxy");
}
