/**
 * Microphone capture for dictation: MediaRecorder while the user speaks, then the clip decoded
 * and resampled to 16 kHz mono, the input speech models take. Nothing is kept after it is
 * transcribed.
 */

export const SAMPLE_RATE = 16000;
/** Longest clip kept; the composer stops recording here. */
export const MAX_SECONDS = 300;

export class MicPermissionError extends Error {
	constructor() {
		super("Tabkyra doesn't have microphone access yet.");
		this.name = "MicPermissionError";
	}
}

export interface Recording {
	/** Resolves with 16 kHz mono samples when stopped (or empty if cancelled). */
	stop(): Promise<Float32Array>;
	cancel(): void;
	/** 0..1 input level, for the button's meter. */
	level(): number;
}

/**
 * Whisper writes words into silence, so quiet stretches never reach it: the clip is cut to the
 * span with speech in it (plus a little padding), and a clip with no speech at all comes back
 * empty. Speech is any 30 ms frame well above the clip's quietest frames.
 */
export function trimSilence(samples: Float32Array, rate = SAMPLE_RATE): Float32Array {
	const frame = Math.round(rate * 0.03);
	const frames = Math.floor(samples.length / frame);
	if (frames === 0) return new Float32Array(0);
	const energy = new Float32Array(frames);
	for (let f = 0; f < frames; f++) {
		let sum = 0;
		for (let i = f * frame; i < (f + 1) * frame; i++) sum += samples[i] * samples[i];
		energy[f] = Math.sqrt(sum / frame);
	}
	const sorted = Array.from(energy).sort((a, b) => a - b);
	const floor = sorted[Math.floor(frames * 0.1)] ?? 0;
	const peak = sorted[frames - 1] ?? 0;
	// No speech: everything is near zero. Whisper writes words into silence, so none is sent.
	if (peak < 0.01) return new Float32Array(0);
	// Loud all the way through (talking from press to stop, or steady noise): nothing to trim.
	if (peak < floor * 3) return samples;
	const threshold = Math.max(0.006, floor * 2.5, peak * 0.05);
	// A click or a cough is a frame or two; speech is at least a quarter second of them. Whisper
	// writes words into a clip with no speech, so a near-silent one is not sent.
	let loud = 0;
	for (const e of energy) if (e >= threshold) loud++;
	if (loud < 8) return new Float32Array(0);
	let first = 0;
	while (first < frames && energy[first] < threshold) first++;
	let last = frames - 1;
	while (last > first && energy[last] < threshold) last--;
	const pad = Math.round(rate * 0.25);
	return samples.slice(Math.max(0, first * frame - pad), Math.min(samples.length, (last + 1) * frame + pad));
}

/** Mix to mono and resample to 16 kHz through an offline context. */
export async function toModelInput(encoded: ArrayBuffer): Promise<Float32Array> {
	const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
	try {
		const audio = await ctx.decodeAudioData(encoded);
		const length = Math.min(audio.length, MAX_SECONDS * SAMPLE_RATE);
		if (audio.numberOfChannels === 1) return audio.getChannelData(0).slice(0, length);
		const out = new Float32Array(length);
		for (let c = 0; c < audio.numberOfChannels; c++) {
			const data = audio.getChannelData(c);
			for (let i = 0; i < length; i++) out[i] += data[i] / audio.numberOfChannels;
		}
		return out;
	} finally {
		void ctx.close();
	}
}

/** Start recording. `onLimit` runs if the recording reaches MAX_SECONDS and stops by itself. */
export async function startRecording(onLimit?: () => void): Promise<Recording> {
	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
		});
	} catch (err) {
		if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError"))
			throw new MicPermissionError();
		throw err;
	}
	const recorder = new MediaRecorder(stream);
	const chunks: Blob[] = [];
	recorder.ondataavailable = (e) => {
		if (e.data.size) chunks.push(e.data);
	};
	// A level meter so the user sees the microphone is live.
	const meter = new AudioContext();
	const analyser = meter.createAnalyser();
	analyser.fftSize = 512;
	meter.createMediaStreamSource(stream).connect(analyser);
	const samples = new Float32Array(analyser.fftSize);
	const release = () => {
		for (const track of stream.getTracks()) track.stop();
		void meter.close();
	};
	const limit = setTimeout(() => {
		if (recorder.state !== "recording") return;
		if (onLimit) onLimit();
		else recorder.stop();
	}, MAX_SECONDS * 1000);
	const done = new Promise<Blob>((resolve) => {
		recorder.onstop = () => {
			clearTimeout(limit);
			release();
			resolve(new Blob(chunks, { type: recorder.mimeType }));
		};
	});
	recorder.start(1000);
	let cancelled = false;
	return {
		async stop() {
			if (recorder.state === "recording") recorder.stop();
			const blob = await done;
			if (cancelled || blob.size === 0) return new Float32Array(0);
			return toModelInput(await blob.arrayBuffer());
		},
		cancel() {
			cancelled = true;
			if (recorder.state === "recording") recorder.stop();
		},
		level() {
			analyser.getFloatTimeDomainData(samples);
			let sum = 0;
			for (const s of samples) sum += s * s;
			return Math.min(1, Math.sqrt(sum / samples.length) * 4);
		},
	};
}
