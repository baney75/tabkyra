/**
 * Request and response bodies an agent reads through read_network: the user's credentials are
 * masked, the data is left alone. Masking goes by structure (the field's name in JSON, a form or
 * a multipart part), not by how a value looks, so ids, paths and SKUs survive. Only a few strict
 * token shapes (bearer headers, JWTs, keys with a known prefix) are masked wherever they appear.
 * Every pass is linear in the text, which is capped before it is read.
 */

export const SECRET = "[secret]";

/** A field name that holds a credential: compared with punctuation and case removed. */
export function isSecretName(name: string): boolean {
	const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (!n) return false;
	if (/^(sid|pin|otp|auth|pwd|pass|jwt|code2fa|mfa)$/.test(n)) return true;
	return /(token|tokens|password|passwd|passcode|passphrase|secret|apikey|accesskey|privatekey|authorization|sessionid|sessid|sessionkey|csrf|xsrf|cookie|credential|credentials|jwt|otp|signature)$/.test(
		n,
	);
}

/** Token shapes masked wherever they appear: they are never data an agent needs. */
function maskTokenShapes(text: string): string {
	return text
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private-key]")
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${SECRET}`)
		.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, SECRET)
		.replace(
			/\b(?:sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{20,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,})/g,
			SECRET,
		);
}

/** JSON values under secret names become "[secret]", at any depth, including JSON inside strings. */
function maskJsonValue(value: unknown, depth: number): unknown {
	if (depth > 40) return value;
	if (Array.isArray(value)) return value.map((v) => maskJsonValue(v, depth + 1));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = isSecretName(k) ? SECRET : maskJsonValue(v, depth + 1);
		return out;
	}
	if (typeof value === "string") {
		const t = value.trim();
		if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
			try {
				return JSON.stringify(maskJsonValue(JSON.parse(t), depth + 1));
			} catch {
				/* not JSON after all */
			}
		}
		return maskTokenShapes(value);
	}
	return value;
}

function maskForm(text: string): string {
	return text
		.split("&")
		.map((pair) => {
			const eq = pair.indexOf("=");
			if (eq < 0) return pair;
			let key = pair.slice(0, eq);
			try {
				key = decodeURIComponent(key.replace(/\+/g, " "));
			} catch {
				/* keep the raw key */
			}
			return isSecretName(key) || isSecretName(key.replace(/^.*\[|\]$/g, ""))
				? `${pair.slice(0, eq)}=${SECRET}`
				: pair;
		})
		.join("&");
}

/** multipart/form-data: a part named like a credential keeps its headers and loses its value. */
function maskMultipart(text: string): string {
	return text.replace(
		/(Content-Disposition:[^\r\n]*\bname="([^"\r\n]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([\s\S]*?)(?=\r?\n--)/gi,
		(whole, head: string, name: string) =>
			isSecretName(name) || isSecretName(name.replace(/^.*\[|\]$/g, "")) ? `${head}${SECRET}` : whole,
	);
}

/** Mask a body: by its content type when known, else by trying JSON, form and multipart shapes. */
export function maskBody(text: string, contentType = ""): string {
	const type = contentType.toLowerCase();
	const t = text.trim();
	if (type.includes("json") || /^[[{]/.test(t)) {
		try {
			return JSON.stringify(maskJsonValue(JSON.parse(t), 0));
		} catch {
			/* not JSON: fall through */
		}
	}
	if (type.includes("multipart/") || /^--\S+\r?\nContent-Disposition:/i.test(t))
		return maskTokenShapes(maskMultipart(text));
	if (type.includes("x-www-form-urlencoded") || (/^[^\s=&]+=[^\s]*$/.test(t) && t.includes("=")))
		return maskTokenShapes(maskForm(t));
	// Other text (HTML, scripts): quoted name/value pairs and key=value pairs by name, linearly.
	return maskTokenShapes(
		text
			.replace(/"([^"\\\n]{1,80})"(\s*:\s*)"((?:[^"\\\n]|\\.){0,4000})"/g, (whole, k: string, sep: string) =>
				isSecretName(k) ? `"${k}"${sep}"${SECRET}"` : whole,
			)
			.replace(/([\w[\]-]{1,80})=([^&\s"'<>]{1,4000})/g, (whole, k: string) =>
				isSecretName(k) || isSecretName(k.replace(/^.*\[|\]$/g, "")) ? `${k}=${SECRET}` : whole,
			),
	);
}
