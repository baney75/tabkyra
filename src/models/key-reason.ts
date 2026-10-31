/**
 * What a key check's failure means for the key:
 * - "rejected": the provider turned the key down (401, 403). Don't save it.
 * - "limited": the provider knew the key but the account is out of credit or over a limit (402,
 *   429). Save it: a free OpenRouter key has no credit and is still the key Free mode needs.
 * - "unchecked": anything else, such as no network, a timeout or a server error. The key may be
 *   fine; the user can save it anyway.
 */
export type KeyFailure = { kind: "rejected" | "limited" | "unchecked"; reason: string };

/**
 * A provider's error in a sentence: "401 {"error":{"message":"invalid x-api-key"}}" becomes
 * "the provider turned it down (invalid x-api-key)".
 */
export function keyFailure(raw: string | undefined): KeyFailure {
	const text = (raw ?? "").trim();
	const match = /^(\d{3})\b\s*(.*)$/s.exec(text);
	const status = match ? Number(match[1]) : undefined;
	let detail = match ? match[2] : text;
	try {
		const body = JSON.parse(detail);
		const found = body?.error?.message ?? body?.message ?? (typeof body?.error === "string" ? body.error : undefined);
		if (typeof found === "string") detail = found;
	} catch {}
	detail = detail.trim().replace(/\.$/, "");
	if (detail.length > 160) detail = `${detail.slice(0, 160)}…`;
	const why = detail ? ` (${detail})` : "";
	if (status === 401 || status === 403) return { kind: "rejected", reason: `the provider turned it down${why}.` };
	if (status === 402 || status === 429)
		return { kind: "limited", reason: `the provider says the account is out of credit or over its limit${why}.` };
	return { kind: "unchecked", reason: detail ? `${detail}.` : "the provider didn't say why." };
}
