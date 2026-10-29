/**
 * The composer's microphone: press to dictate, press again to stop; the words are added to the
 * message. Speech becomes text on this device (src/dictation/worker.ts); the first use downloads
 * the model the device can run best (src/dictation/tiers.ts), once.
 */

import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Loader2, Mic, Square } from "lucide";
import { Toast } from "../components/Toast.js";
import type { DictationRequest, DictationResponse, ModelSpec } from "./protocol.js";
import { MicPermissionError, type Recording, startRecording, trimSilence } from "./recorder.js";
import { modelCached, resolveModel } from "./settings.js";

type Phase = "idle" | "recording" | "transcribing";

let worker: Worker | undefined;
let seq = 0;
const waiting = new Map<number, { resolve: (r: DictationResponse) => void }>();
const progressListeners = new Set<(loaded: number, total: number) => void>();

function dictationWorker(): Worker {
	if (worker) return worker;
	worker = new Worker(chrome.runtime.getURL("dictation-worker.js"), { type: "module" });
	worker.onmessage = (event: MessageEvent<DictationResponse>) => {
		const m = event.data;
		if (m.type === "progress") {
			for (const l of progressListeners) l(m.loaded, m.total);
			return;
		}
		waiting.get(m.id)?.resolve(m);
		waiting.delete(m.id);
	};
	return worker;
}

function ask(request: DictationRequest): Promise<DictationResponse> {
	return new Promise((resolve) => {
		waiting.set(request.id, { resolve });
		const transfer = request.type === "transcribe" ? [request.audio.buffer] : [];
		dictationWorker().postMessage(request, transfer);
	});
}

/** Start loading the model while the user talks, so the first transcript isn't kept waiting. */
function preload(model: ModelSpec): Promise<DictationResponse> {
	return ask({ type: "load", id: ++seq, model });
}

@customElement("tabkyra-dictation")
export class DictationButton extends LitElement {
	/** The composer's text now, and how to replace it. */
	@property({ attribute: false }) value = "";
	@property({ attribute: false }) setValue?: (value: string) => void;
	@state() private phase: Phase = "idle";
	@state() private level = 0;
	@state() private download?: { loaded: number; total: number };
	private recording?: Recording;
	private meter?: number;
	private model?: { spec: ModelSpec; language?: string };
	private loaded?: Promise<DictationResponse>;

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	private readonly onProgress = (loaded: number, total: number) => {
		this.download = total > 0 && loaded < total ? { loaded, total } : undefined;
	};

	override connectedCallback(): void {
		super.connectedCallback();
		progressListeners.add(this.onProgress);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		progressListeners.delete(this.onProgress);
		this.recording?.cancel();
		if (this.meter) cancelAnimationFrame(this.meter);
	}

	private async start(): Promise<void> {
		try {
			this.model = await resolveModel();
			this.recording = await startRecording();
		} catch (err) {
			if (err instanceof MicPermissionError) {
				Toast.info("Allow the microphone in the tab that opened, then press the microphone again.", 6000);
				void chrome.tabs.create({ url: chrome.runtime.getURL("mic-permission.html"), active: true });
			} else Toast.error(`Dictation couldn't start: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		this.phase = "recording";
		this.loaded = preload(this.model.spec);
		const spec = this.model.spec;
		if (!(await modelCached(spec)))
			Toast.info(
				`First dictation: downloading ${spec.label}, about ${spec.downloadMB} MB, once. Keep talking.`,
				6000,
			);
		const tick = () => {
			this.level = this.recording?.level() ?? 0;
			if (this.phase === "recording") this.meter = requestAnimationFrame(tick);
		};
		tick();
	}

	private async stop(): Promise<void> {
		const recording = this.recording;
		const model = this.model;
		this.recording = undefined;
		if (!recording || !model) return;
		this.phase = "transcribing";
		try {
			const audio = trimSilence(await recording.stop());
			if (audio.length < 1600) {
				Toast.info("No speech heard. Check the microphone and try again.");
				this.phase = "idle";
				return;
			}
			const loaded = await this.loaded;
			if (loaded?.type === "error") throw new Error(loaded.message);
			const reply = await ask({ type: "transcribe", id: ++seq, model: model.spec, audio, language: model.language });
			if (reply.type === "error") throw new Error(reply.message);
			if (reply.type === "text" && reply.text) {
				const before = this.value.replace(/\s+$/, "");
				this.setValue?.(before ? `${before} ${reply.text}` : reply.text);
			}
		} catch (err) {
			Toast.error(`Dictation failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.phase = "idle";
			this.download = undefined;
		}
	}

	private onClick = () => {
		if (this.phase === "idle") void this.start();
		else if (this.phase === "recording") void this.stop();
	};

	private onKeydown = (e: KeyboardEvent) => {
		if (e.key === "Escape" && this.phase === "recording") {
			this.recording?.cancel();
			this.recording = undefined;
			this.phase = "idle";
		}
	};

	override render(): TemplateResult {
		const recording = this.phase === "recording";
		const busy = this.phase === "transcribing";
		const pct = this.download ? Math.round((this.download.loaded / this.download.total) * 100) : undefined;
		const label = recording
			? "Stop dictating and add the text"
			: busy
				? pct !== undefined
					? `Downloading the speech model (${pct}%)`
					: "Turning speech into text on this device"
				: "Dictate (speech to text on this device)";
		return html`<button
				type="button"
				class="relative h-8 w-8 inline-flex items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer disabled:cursor-wait ${
					recording ? "bg-destructive/15 text-destructive" : "text-foreground hover:bg-accent"
				}"
				aria-label=${label}
				aria-pressed=${recording ? "true" : "false"}
				title=${label}
				?disabled=${busy}
				@click=${this.onClick}
				@keydown=${this.onKeydown}
			>
				${busy ? icon(Loader2, "sm", "animate-spin") : recording ? icon(Square, "sm") : icon(Mic, "sm")}
				${
					recording
						? html`<span
								class="absolute bottom-0.5 left-1.5 right-1.5 h-0.5 rounded-full bg-destructive origin-left"
								style="transform: scaleX(${Math.max(0.08, this.level)})"
								aria-hidden="true"
							></span>`
						: nothing
				}
			</button>
			<span class="sr-only" role="status">${recording ? "Listening" : busy ? label : ""}</span>`;
	}
}
