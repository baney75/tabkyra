/** The dictation setting: which model (automatic by device, or a chosen one) and which language. */

import type { ModelSpec } from "./protocol.js";
import { chooseModel, MODELS, type ModelKey, profileDevice } from "./tiers.js";

export const DICTATION_KEY = "tabkyra.dictation";
/** Where transformers.js keeps downloaded model files (its default Cache Storage name). */
export const MODEL_CACHE = "transformers-cache";

export interface DictationSetting {
	model: "auto" | ModelKey;
	/** "auto" lets a multilingual model detect it; otherwise an ISO code such as "de". */
	language: string;
}

export const DEFAULT_SETTING: DictationSetting = { model: "auto", language: "auto" };

export async function readSetting(): Promise<DictationSetting> {
	const stored = (await chrome.storage.local.get(DICTATION_KEY))[DICTATION_KEY] as
		| Partial<DictationSetting>
		| undefined;
	const model = stored?.model && (stored.model === "auto" || stored.model in MODELS) ? stored.model : "auto";
	const language =
		typeof stored?.language === "string" && /^(auto|[a-z]{2,3})$/.test(stored.language) ? stored.language : "auto";
	return { model, language };
}

export async function writeSetting(setting: DictationSetting): Promise<void> {
	await chrome.storage.local.set({ [DICTATION_KEY]: setting });
}

/** The model to run now, and the language to ask it for (none: let it detect). */
export async function resolveModel(): Promise<{ spec: ModelSpec; language?: string; why: string }> {
	const setting = await readSetting();
	const device = await profileDevice();
	const auto = chooseModel(device, setting.language);
	let key: ModelKey = setting.model === "auto" ? auto.key : setting.model;
	// A chosen GPU model on a device without a GPU can't run: fall back to the automatic one.
	if (MODELS[key].device === "webgpu" && !device.webgpu) key = auto.key;
	const spec = MODELS[key];
	return {
		spec,
		language: spec.multilingual && setting.language !== "auto" ? setting.language : undefined,
		why: setting.model === "auto" || key === auto.key ? auto.why : "chosen in Settings",
	};
}

/** Bytes of downloaded model files, and a way to remove them. */
export async function cachedModelBytes(): Promise<number> {
	try {
		const cache = await caches.open(MODEL_CACHE);
		let total = 0;
		for (const request of await cache.keys()) {
			const response = await cache.match(request);
			// The size header only: reading a cached model to measure it would load hundreds of MB.
			total += Number(response?.headers.get("content-length") ?? 0);
		}
		return total;
	} catch {
		return 0;
	}
}

/** transformers.js's file name suffix for each dtype (DEFAULT_DTYPE_SUFFIX_MAPPING). */
const DTYPE_SUFFIX: Record<string, string> = { fp32: "", fp16: "_fp16", q8: "_quantized", q4: "_q4", q4f16: "_q4f16" };

/** The model's weight files, as transformers.js names them in the repo. */
export function modelFiles(spec: ModelSpec): string[] {
	return Object.entries(spec.dtype).map(([name, dtype]) => `onnx/${name}${DTYPE_SUFFIX[dtype] ?? `_${dtype}`}.onnx`);
}

/**
 * Whether this model's weights are downloaded (transformers.js keys its cache by file URL). Its
 * small files alone don't count: a download cut off after them still has the weights to fetch.
 */
export async function modelCached(spec: ModelSpec): Promise<boolean> {
	try {
		const cache = await caches.open(MODEL_CACHE);
		const base = `/${spec.id}/resolve/${spec.revision}/`;
		const urls = (await cache.keys()).map((request) => request.url);
		return modelFiles(spec).every((file) => urls.some((url) => url.includes(base + file)));
	} catch {
		return false;
	}
}

export async function removeCachedModels(): Promise<void> {
	await caches.delete(MODEL_CACHE);
}
