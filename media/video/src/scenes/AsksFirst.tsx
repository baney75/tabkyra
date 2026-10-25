import { useCurrentFrame } from "remotion";
import { DATA, args, field } from "../data";
import { C, FONT } from "../theme";
import { Caption, ChapterLabel, Code, Fill, Pane, PanelCrop, Ring, rise, Watermark } from "../ui";

// The Bridge tab, cropped to Site access through the request (CSS px of the 440-wide panel).
const CROP = { x: 22, y: 425, w: 396, h: 352 };
const SCALE = 1.95;
const PANEL = { left: 1000, top: 150 };
const ANSWER = 215;

/** Claude Code's inline question, with the real message and choices from the elicitation. */
const Prompt: React.FC = () => {
	const frame = useCurrentFrame();
	const o = rise(frame, 60, 10);
	const picked = frame >= ANSWER - 25;
	const done = frame >= ANSWER;
	return (
		<div
			style={{
				position: "absolute",
				left: 80,
				top: 520,
				width: 860,
				padding: "24px 28px",
				borderRadius: 16,
				border: `2px solid ${C.brass}`,
				background: "#16232D",
				opacity: o,
				translate: `0 ${(1 - o) * 16}px`,
				fontFamily: FONT.mono,
				fontSize: 25,
				lineHeight: 1.5,
				color: C.paper,
			}}
		>
			<div style={{ fontFamily: FONT.sans, fontSize: 22, color: C.brass, marginBottom: 8 }}>Your agent asks you</div>
			<div style={{ marginBottom: 14 }}>{DATA.prompt.message}</div>
			{DATA.prompt.choices.map((choice, i) => {
				const on = picked && i === 0;
				return (
					<div
						key={choice}
						style={{
							padding: "4px 12px",
							borderRadius: 8,
							background: on ? "rgba(227,169,59,0.18)" : "transparent",
							color: on ? C.brass : C.mist,
						}}
					>
						{on ? (done ? "✓ " : "› ") : "  "}
						{choice}
					</div>
				);
			})}
		</div>
	);
};

export const AsksFirst: React.FC = () => {
	const frame = useCurrentFrame();
	const after = rise(frame, ANSWER + 10, 12);
	const enter = rise(frame, 20, 16);
	return (
		<Fill>
			<Watermark />
			<ChapterLabel>Asks first</ChapterLabel>
			<Pane
				title="claude · tool calls"
				left={80} top={150} width={860} height={340}
				fontSize={25}
				lines={[
					{ at: 6, kind: "note", text: "# a new site, not allowed yet" },
					{ at: 18, kind: "call", text: args("navigate", 1) },
					{ at: 48, kind: "note", text: "# the call waits for your answer" },
					{ at: ANSWER + 12, kind: "ok", text: `→ title: "${field("navigate", "title", 1)}"` },
				]}
			/>
			<Prompt />
			<div style={{ position: "absolute", left: PANEL.left, top: PANEL.top - 52, fontFamily: FONT.sans, fontSize: 24, color: C.mist, opacity: enter }}>
				Tabkyra side panel · Settings › Bridge
			</div>
			<div style={{ opacity: enter, scale: String(0.97 + 0.03 * enter) }}>
				<PanelCrop src="capture/panel-pending.png" crop={CROP} scale={SCALE} style={{ ...PANEL, opacity: 1 - after }} />
				<PanelCrop src="capture/panel-allowed.png" crop={CROP} scale={SCALE} style={{ ...PANEL, opacity: after }} />
			</div>
			<Ring x={PANEL.left + (47 - CROP.x) * SCALE} y={PANEL.top + (573 - CROP.y) * SCALE} w={346 * SCALE} h={110 * SCALE} at={70} until={ANSWER} />
			<Ring
				x={PANEL.left + (47 - CROP.x) * SCALE}
				y={PANEL.top + (612 - CROP.y) * SCALE}
				w={346 * SCALE}
				h={34 * SCALE}
				at={ANSWER + 20}
				until={400}
				color={C.tide}
			/>
			<Caption from={24} to={ANSWER}>
				A new site? The agent asks first. You answer inline or in the side panel.
			</Caption>
			<Caption from={ANSWER + 10} to={420}>
				Allow it once, for good, or deny it. <Code>tabkyra allow &lt;host&gt;</Code> works too.
			</Caption>
		</Fill>
	);
};
