// On-device dictation: the model each device gets, what is sent to it, the setting, and the
// build that lets the speech runtime load without a CDN. The model itself runs in
// cli/eval/dictation.mjs (a real browser); these tests need none.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { trimSilence } from "../src/dictation/recorder.ts";
import { readSetting, resolveModel } from "../src/dictation/settings.ts";
import { chooseModel, MODELS } from "../src/dictation/tiers.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const device = (over) => ({ webgpu: false, f16: false, memoryGB: 8, language: "en-US", ...over });

test("each device gets the strongest model it can run", () => {
	assert.equal(chooseModel(device({ webgpu: true, f16: true, memoryGB: 16, maxBufferBytes: 4 * 1024 ** 3 })).key, "turbo");
	assert.equal(chooseModel(device({ webgpu: true, f16: true, memoryGB: undefined })).key, "turbo", "browsers that hide memory still get the GPU model");
	assert.equal(chooseModel(device({ webgpu: true, f16: true, maxBufferBytes: 256 * 1024 ** 2 })).key, "small", "small GPU buffers");
	assert.equal(chooseModel(device({ webgpu: true, f16: false })).key, "small", "no half precision");
	assert.equal(chooseModel(device({ webgpu: true, f16: true, memoryGB: 4 })).key, "small");
	assert.equal(chooseModel(device({ webgpu: true, memoryGB: 2 })).key, "moonshineTiny");
	assert.equal(chooseModel(device({ memoryGB: 2, language: "de-DE" })).key, "tiny");
	assert.equal(chooseModel(device({})).key, "moonshine", "English on the processor");
	assert.equal(chooseModel(device({ language: "es" })).key, "base", "other languages on the processor");
	for (const spec of Object.values(MODELS)) {
		assert.match(spec.revision, /^[0-9a-f]{40}$/, `${spec.id} is pinned to a commit`);
		assert.match(spec.id, /^onnx-community\//);
	}
	// 4-bit encoders drop speech; decoders tolerate it.
	for (const spec of Object.values(MODELS)) assert.doesNotMatch(spec.dtype.encoder_model, /q4|int4/, spec.id);
});

test("silence is cut before the model, and talk from press to stop is kept whole", () => {
	const rate = 16000;
	const tone = (seconds, amp) => Float32Array.from({ length: seconds * rate }, (_, i) => amp * Math.sin(i / 3));
	const join = (...parts) => {
		const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const p of parts) {
			out.set(p, at);
			at += p.length;
		}
		return out;
	};
	assert.equal(trimSilence(new Float32Array(rate * 3)).length, 0, "silence sends nothing");
	assert.equal(trimSilence(tone(3, 0.002)).length, 0, "a quiet hum sends nothing");
	const speech = join(tone(2, 0.0005), tone(1, 0.3), tone(2, 0.0005));
	const trimmed = trimSilence(speech);
	assert.ok(trimmed.length >= rate && trimmed.length <= rate * 1.6, `kept ${trimmed.length / rate} s of 5 s`);
	const talking = tone(4, 0.3);
	assert.equal(trimSilence(talking).length, talking.length, "no quiet part: nothing is cut");
});

test("the setting falls back to automatic, and a GPU model on a device without one isn't used", async () => {
	const stored = {};
	globalThis.chrome = { storage: { local: { get: async (key) => ({ [key]: stored.value }) } } };
	stored.value = { model: "nonsense", language: "<script>" };
	assert.deepEqual(await readSetting(), { model: "auto", language: "auto" });
	stored.value = { model: "base", language: "de" };
	assert.deepEqual(await readSetting(), { model: "base", language: "de" });
	// Node has no navigator.gpu: the device has no WebGPU, so a chosen GPU model gives way.
	stored.value = { model: "turbo", language: "auto" };
	const resolved = await resolveModel();
	assert.equal(resolved.spec.device, "wasm");
	stored.value = { model: "moonshine", language: "de" };
	assert.equal((await resolveModel()).language, undefined, "an English-only model gets no language");
	delete globalThis.chrome;
});

test("the speech runtime ships with the extension: no CDN, wasm allowed by the CSP, models from Hugging Face only", () => {
	const manifest = JSON.parse(read("static/manifest.chrome.json"));
	assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
	const build = read("scripts/build.mjs");
	assert.match(build, /ort-wasm-simd-threaded\.asyncify\.wasm/);
	assert.match(build, /cdn\.jsdelivr\.net/, "the build rewrites the runtime's CDN default");
	assert.match(build, /throw new Error/, "and fails if that default moves");
	const worker = read("src/dictation/worker.ts");
	assert.match(worker, /allowLocalModels = false/);
	assert.match(worker, /ort\/ort-wasm-simd-threaded\.asyncify\.mjs/);
	assert.doesNotMatch(worker, /await import\(/);
});
