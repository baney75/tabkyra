/**
 * A provider's error in a sentence: "401 {"error":{"message":"invalid x-api-key"}}" becomes
 * "the provider turned it down (invalid x-api-key)".
 */
export function plainReason(raw: string | undefined): string {
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
	if (status === 401 || status === 403) return `the provider turned it down${detail ? ` (${detail})` : ""}.`;
	if (status === 402 || status === 429)
		return `the provider says the account is out of credit or over its limit${detail ? ` (${detail})` : ""}.`;
	return detail ? `${detail}.` : "the provider didn't say why.";
}
