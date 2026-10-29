/**
 * Request and response bodies an agent reads through read_network: the user's credentials are
 * masked, the data is left exactly as sent. Masking goes by structure (the field's name in JSON,
 * a form, a multipart part, or name: value text inside a string), not by how a value looks, so
 * ids, paths and SKUs survive. JSON is edited in place, span by span, never parsed and
 * re-serialized: 64-bit ids keep every digit, duplicate keys and key order stay, and a body cut
 * off in the middle of a credential is masked to its end. Every pass is linear in the text.
 */

export const SECRET = "[secret]";

/** Names that contain a credential word but hold data (token counts, limits, tokenizers). */
const DATA_NAMES =
	/^(?:(?:max|min|total|input|output|prompt|completion|cached|reasoning|remaining|used)tokens?|tokens?(?:count|limit|usage|used|total|budget|remaining|type)|tokenizer|tokenized|secretary\w*|passenger\w*|passport\w*|bypass\w*|compass\w*|passage\w*)$/;
/** Credential words anywhere in a name: password_confirmation, secretKey, x-csrf-token, pass1. */
const SECRET_WORDS =
	/password|passwd|passphrase|passcode|secret|token|apikey|accesskey|privatekey|signingkey|authkey|credential|csrf|xsrf|cookie|sessionid|sessid|sessionkey|authorization|codeverifier|authcode|jwt|otp|mfacode|totp|recoverycode|backupcode/;

/** A field name that holds a credential: compared with punctuation, case and trailing digits removed. */
export function isSecretName(name: string): boolean {
	const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (!n || DATA_NAMES.test(n)) return false;
	if (/^(?:sid|pin|pwd|pass\d*|auth|signature|sig)$/.test(n)) return true;
	return SECRET_WORDS.test(n.replace(/\d+$/, ""));
}

/** The name inside brackets for form keys like user[password]. */
const innerName = (key: string) => key.replace(/^.*\[|\]$/g, "");
const secretKey = (key: string) => isSecretName(key) || isSecretName(innerName(key));

/** Token shapes masked wherever they appear: never data an agent needs. */
function maskTokenShapes(text: string): string {
	return (
		text
			.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private-key]")
			.replace(
				/\b((?:Proxy-)?Authorization\s*:\s*)(?:(Bearer|Basic|Digest|Token)\s+)?[^\s"',;]+/gi,
				(_m, head: string, scheme?: string) => `${head}${scheme ? `${scheme} ` : ""}${SECRET}`,
			)
			// A bare "Bearer <token>" only when the token looks like one (long, letters and digits), so
			// "Basic Subscription" stays.
			.replace(
				/\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*\d)(?=[A-Za-z0-9._~+/=-]*[A-Za-z])[A-Za-z0-9._~+/=-]{20,}/g,
				`$1 ${SECRET}`,
			)
			.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, SECRET)
			.replace(
				/\b(?:sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{20,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,})/g,
				SECRET,
			)
	);
}

/**
 * Credentials written as name/value text inside a value: a GraphQL query's inline arguments
 * (password:"hunter2"), a query string or form in a string (password=hunter2), JSON in a string.
 */
function maskText(text: string, depth: number): string {
	const t = text.trim();
	if (depth < 8 && /^[[{]/.test(t)) return maskJson(text, depth + 1);
	return maskTokenShapes(
		text.replace(
			/(?<![\w[\]-])("?)([\w[\]-]{1,80})\1(\s*[:=]\s*)("(?:[^"\\\n]|\\.){0,4000}"|'(?:[^'\\\n]|\\.){0,4000}'|[^&\s,;)}\]"']{1,4000})/g,
			(whole, q: string, key: string, sep: string, value: string) => {
				if (!secretKey(key)) return whole;
				const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
				return `${q}${key}${q}${sep}${quote}${SECRET}${quote}`;
			},
		),
	);
}

/**
 * JSON, edited in place: the value after a credential-named key becomes "[secret]" whatever its
 * type; other string values are checked for name/value text and JSON inside them. Truncated
 * input is fine: an unfinished credential value is masked to the end.
 */
function maskJson(text: string, depth = 0): string {
	let out = "";
	let i = 0;
	const n = text.length;
	// One frame per open object or array: whether the next string in an object is a key.
	const stack: Array<{ obj: boolean; key: boolean }> = [];
	let lastKey = "";

	/** End of the string token starting at the quote at `start` (index after the closing quote, or n). */
	const stringEnd = (start: number) => {
		let j = start + 1;
		while (j < n) {
			const c = text[j];
			if (c === "\\") j += 2;
			else if (c === '"') return j + 1;
			else j++;
		}
		return n;
	};
	/** End of the whole JSON value starting at `start`, balanced; n if the text ends first. */
	const valueEnd = (start: number) => {
		const c = text[start];
		if (c === '"') return stringEnd(start);
		if (c !== "{" && c !== "[") {
			let j = start;
			while (j < n && !/[,}\]\s]/.test(text[j])) j++;
			return j;
		}
		let level = 0;
		let j = start;
		while (j < n) {
			const d = text[j];
			if (d === '"') {
				j = stringEnd(j);
				continue;
			}
			if (d === "{" || d === "[") level++;
			else if (d === "}" || d === "]") {
				level--;
				if (level === 0) return j + 1;
			}
			j++;
		}
		return n;
	};

	while (i < n) {
		const c = text[i];
		const top = stack[stack.length - 1];
		if (c === '"') {
			const end = stringEnd(i);
			const token = text.slice(i, end);
			if (top?.obj && top.key) {
				try {
					lastKey = JSON.parse(token);
				} catch {
					lastKey = token.slice(1, -1);
				}
				out += token;
			} else {
				// A string value: look inside it for credentials written as text or as JSON.
				let replaced = token;
				if (end <= n && token.length >= 2 && token.endsWith('"')) {
					try {
						const value = JSON.parse(token) as string;
						const masked = maskText(value, depth);
						if (masked !== value) replaced = JSON.stringify(masked);
					} catch {
						/* not a complete string token */
					}
				}
				out += replaced;
			}
			i = end;
			continue;
		}
		if (c === ":" && top?.obj) {
			out += c;
			i++;
			// Whitespace, then the value: masked whole when its key names a credential.
			while (i < n && /\s/.test(text[i])) out += text[i++];
			if (secretKey(lastKey) && i < n) {
				i = valueEnd(i);
				out += `"${SECRET}"`;
			}
			if (top) top.key = false;
			continue;
		}
		if (c === "{" || c === "[") stack.push({ obj: c === "{", key: c === "{" });
		else if (c === "}" || c === "]") stack.pop();
		else if (c === "," && top?.obj) top.key = true;
		out += c;
		i++;
	}
	return out;
}

function maskForm(text: string): string {
	return text
		.split("&")
		.map((pair) => {
			const eq = pair.indexOf("=");
			if (eq < 0) return pair;
			let key = pair.slice(0, eq);
			let value = pair.slice(eq + 1);
			try {
				key = decodeURIComponent(key.replace(/\+/g, " "));
				value = decodeURIComponent(value.replace(/\+/g, " "));
			} catch {
				/* keep the raw text */
			}
			if (secretKey(key)) return `${pair.slice(0, eq)}=${SECRET}`;
			// A value that carries JSON or name=value text of its own.
			const masked = maskText(value, 0);
			return masked === value ? pair : `${pair.slice(0, eq)}=${encodeURIComponent(masked)}`;
		})
		.join("&");
}

/** multipart/form-data: a part named like a credential keeps its headers and loses its value, even when cut off. */
function maskMultipart(text: string): string {
	return text.replace(
		/(Content-Disposition:[^\r\n]*\bname="([^"\r\n]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([\s\S]*?)(?=\r?\n--|$)/gi,
		(_whole, head: string, name: string, value: string) =>
			secretKey(name) ? `${head}${SECRET}` : `${head}${maskText(value, 0)}`,
	);
}

/** Mask a body: by its content type when known, else by trying JSON, form and multipart shapes. */
export function maskBody(text: string, contentType = ""): string {
	const type = contentType.toLowerCase();
	const t = text.trimStart();
	if (type.includes("json") || /^[[{]/.test(t)) return maskTokenShapes(maskJson(text));
	if (type.includes("multipart/") || /^--\S+\r?\nContent-Disposition:/i.test(t))
		return maskTokenShapes(maskMultipart(text));
	if (type.includes("x-www-form-urlencoded") || /^[^\s=&]+=[^\s]*$/.test(t.trim()))
		return maskTokenShapes(maskForm(t.trim()));
	return maskText(text, 0);
}
