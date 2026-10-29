/**
 * What an agent sees of a request's bodies through read_network, kept to promises that hold:
 *
 * - A request body is shown as its shape only: keys and value types, never a value. It carries
 *   what the user typed, passwords included, and no name list catches every password field.
 * - A response body is shown only when it is complete JSON. Values under credential-named keys
 *   become "[secret]", edited in place so every other byte (64-bit ids, key order, duplicate
 *   keys) comes back as sent. A string value that holds a credential as text ("token=...",
 *   'password:"..."', a bearer token, a JWT) is masked whole, never partly parsed.
 * - Anything else (HTML, plain text, a body cut off) isn't shown; get_page_html and run_js cover it.
 *
 * Every pass is linear in the text.
 */

export const SECRET = "[secret]";

/** Names that contain a credential word but hold counts and settings. */
const DATA_NAMES =
	/^(?:(?:max|min|total|input|output|prompt|completion|cached|reasoning|remaining|used)tokens?|tokens?(?:count|limit|usage|used|total|budget|remaining|type)|tokenizer|tokenized)$/;
/** Exact names that are credentials. */
const EXACT = /^(?:sid|pin|pw|pwd|pass|key|session|otp|auth|sig|signature|code2fa|cvv|cvc|csc)$/;
/** Credential words anywhere in a name: password_confirmation, secretKey, x-csrf-token. */
const ANYWHERE =
	/password|passwd|passphrase|passcode|secret|token|apikey|accesskey|privatekey|signingkey|authkey|credential|csrf|xsrf|cookie|sessionid|sessid|sessionkey|authorization|codeverifier|authcode|jwt|recoverycode|backupcode|verificationcode|smscode|twofactor|2fa|mfacode|totp|cardnumber|cardno|iban|ssn/;
/** Credential words at the end of a name: user_pw, loginPwd, confirm_pass, cardPin, mfa_otp. */
const ENDING = /(?:pw|pwd|pass|pin|otp|cvv|cvc)$/;

/** A field name that holds a credential: compared with punctuation, case and trailing digits removed. */
export function isSecretName(name: string): boolean {
	const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (!n || DATA_NAMES.test(n)) return false;
	const stem = n.replace(/\d+$/, "");
	return EXACT.test(stem) || ANYWHERE.test(stem) || ENDING.test(stem);
}

/** A string that carries a credential: a token shape, or a credential name followed by : or =. */
export function holdsCredential(text: string): boolean {
	if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return true;
	// A scheme and a token: long, with a digit, so "Basic Subscription" stays.
	if (/\b(?:Bearer|Basic|Digest)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/.test(text)) return true;
	if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(text)) return true;
	if (
		/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{16,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|ya29\.[\w-]{20,}|npm_\w{30,}|hf_\w{30,})/.test(
			text,
		)
	)
		return true;
	// name: value or name=value, the name not starting mid-word; quotes and escapes allowed around it.
	for (const m of text.matchAll(/(?<![A-Za-z0-9_[\]-])\\?["']?([A-Za-z0-9_[\]-]{1,80})\\?["']?\s*[:=]/g))
		if (isSecretName(m[1].replace(/^.*\[|\]$/g, ""))) return true;
	return false;
}

/** The shape of a request body: keys and value types, no values. */
export function bodyShape(text: string, contentType = ""): string {
	const type = contentType.toLowerCase();
	const t = text.trim();
	const describe = (v: unknown, depth: number): unknown => {
		if (Array.isArray(v)) return v.length ? [describe(v[0], depth + 1), `(${v.length} items)`] : [];
		if (v && typeof v === "object") {
			if (depth > 20) return "{…}";
			return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, describe(x, depth + 1)]));
		}
		if (typeof v === "string") return `<string, ${v.length} chars>`;
		return `<${v === null ? "null" : typeof v}>`;
	};
	if (type.includes("json") || /^[[{]/.test(t)) {
		try {
			return JSON.stringify(describe(JSON.parse(t), 0));
		} catch {
			/* not JSON */
		}
	}
	if (type.includes("x-www-form-urlencoded") || /^[^\s=&]+=[^\s]*$/.test(t)) {
		const keys = t.split("&").map((pair) => {
			const key = pair.split("=")[0] ?? "";
			try {
				return decodeURIComponent(key.replace(/\+/g, " "));
			} catch {
				return key;
			}
		});
		return `form fields: ${keys.join(", ")}`;
	}
	if (type.includes("multipart/")) {
		const names = [...t.matchAll(/Content-Disposition:[^\r\n]*\bname="([^"\r\n]*)"/gi)].map((m) => m[1]);
		return `multipart fields: ${names.join(", ")}`;
	}
	return `${t.length} characters of ${type || "text"}; values not shown`;
}

/**
 * A complete JSON response with credentials masked in place, or undefined when the text isn't
 * complete JSON (then it isn't shown at all).
 */
export function maskJsonResponse(text: string): string | undefined {
	try {
		JSON.parse(text);
	} catch {
		return undefined;
	}
	let out = "";
	let i = 0;
	const n = text.length;
	const stack: Array<{ obj: boolean; key: boolean }> = [];
	let lastKey = "";
	const stringEnd = (start: number) => {
		let j = start + 1;
		while (j < n) {
			if (text[j] === "\\") j += 2;
			else if (text[j] === '"') return j + 1;
			else j++;
		}
		return n;
	};
	const valueEnd = (start: number) => {
		const c = text[start];
		if (c === '"') return stringEnd(start);
		if (c !== "{" && c !== "[") {
			let j = start;
			while (j < n && !/[,}\]\s]/.test(text[j])) j++;
			return j;
		}
		let level = 0;
		for (let j = start; j < n; j++) {
			const d = text[j];
			if (d === '"') {
				j = stringEnd(j) - 1;
				continue;
			}
			if (d === "{" || d === "[") level++;
			else if (d === "}" || d === "]") {
				level--;
				if (level === 0) return j + 1;
			}
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
				lastKey = JSON.parse(token) as string;
				out += token;
			} else out += holdsCredential(JSON.parse(token) as string) ? `"${SECRET}"` : token;
			i = end;
			continue;
		}
		if (c === ":" && top?.obj) {
			out += c;
			i++;
			while (i < n && /\s/.test(text[i])) out += text[i++];
			if (isSecretName(lastKey) && i < n) {
				i = valueEnd(i);
				out += `"${SECRET}"`;
			}
			top.key = false;
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

/** A URL with credential-named query parameters, token-shaped values and userinfo masked. */
export function maskUrl(url: string): string {
	try {
		const u = new URL(url);
		let changed = false;
		for (const [key, value] of [...u.searchParams]) {
			if (isSecretName(key) || holdsCredential(value)) {
				u.searchParams.set(key, SECRET);
				changed = true;
			}
		}
		if (u.username || u.password) {
			u.username = "";
			u.password = "";
			changed = true;
		}
		return changed ? u.toString() : url;
	} catch {
		return url;
	}
}
