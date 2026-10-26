import { AbsoluteFill, useCurrentFrame } from "remotion";
import { DATA } from "../data";
import { C, FONT } from "../theme";
import { useBeat } from "./beat";
import { Helm } from "./Helm";
import { Backdrop, ease, Flash, useLayout, Whip, Words } from "./motion";
import { Center, PanelPart, useSize } from "./parts";

/**
 * SLOT: the skill router ("the right skill, in under a millisecond"), not merged yet (#21).
 * Replace this scene with a capture from main once it lands. Until then it shows a merged
 * feature: the side panel's real "Copy setup prompt for your agent" button and its toast.
 */
export const RouterSlot: React.FC = () => {
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const box = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x, y: b.y, w: b.width, h: b.height });
	const dialog = box(DATA.boxes.welcomeDialog);
	const toast = box(DATA.boxes.toast);
	const { vertical } = useLayout();
	const scale = Math.min(2.2, size(620, 900) / dialog.w);
	const copied = frame >= at(94);
	return (
		<Whip dur={at(96) - at(92)} from="up" inDur={6}>
			<Backdrop />
			<Center column={vertical} gap={size(90, 60)}>
				<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: size(24, 30) }}>
					<div style={{ height: toast.h * scale, opacity: ease(frame, at(94), 5), translate: `0 ${(1 - ease(frame, at(94), 8)) * -40}px` }}>
						{copied ? <PanelPart src="capture/panel-copied.png" crop={toast} scale={scale} /> : null}
					</div>
					<PanelPart src="capture/panel-welcome.png" crop={dialog} scale={scale} style={{ scale: String(1 + 0.04 * ease(frame, 0, at(96) - at(92))) }} />
				</div>
				<div style={{ width: size(760, 960) }}>
					<Words
						words={vertical ? ["One prompt", "sets it up."] : ["One", "prompt", "sets", "it", "up."]}
						ats={vertical ? [at(93), at(93) + 6] : [at(93), at(93) + 2, at(93) + 4, at(93) + 6, at(93) + 8]}
						size={size(130, 110)}
						colors={[C.brass, C.paper, C.paper, C.paper, C.paper]}
					/>
				</div>
			</Center>
		</Whip>
	);
};

// All five are named in the README's "Connect your agent" section.
const AGENTS = ["Claude Code", "Codex", "pi", "OMP", "Cursor"];

/** B96–B103: the agents it works with, one per beat. */
export const WorksWith: React.FC = () => {
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	return (
		<Whip dur={at(104) - at(96)} from="zoom" inDur={1}>
			<Backdrop />
			<Center gap={size(40, 50)}>
				<Words words={["Works", "with"]} ats={[0, 0]} size={size(120, 120)} font={FONT.serif} italic colors={[C.mist, C.mist]} />
				<div
					style={{
						display: "flex",
						flexDirection: vertical ? "column" : "row",
						flexWrap: "wrap",
						justifyContent: "center",
						alignItems: "center",
						gap: `${size(20, 24)}px ${size(60, 0)}px`,
						maxWidth: size(1700, 1000),
					}}
				>
					{AGENTS.map((name, i) => (
						<Words key={name} words={[name]} ats={[at(97 + i)]} size={size(130, 130)} colors={[i % 2 ? C.paper : C.brass]} />
					))}
				</div>
				<div style={{ opacity: ease(frame, at(102), 6), fontFamily: FONT.sans, fontSize: size(60, 56), color: C.mist }}>and any MCP agent</div>
			</Center>
			<Flash at={0} strength={0.3} />
		</Whip>
	);
};

/** B104 to the end: the helm assembles, the wordmark, the line, the command, the address. */
export const EndCard: React.FC = () => {
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	const step = (at(106) - at(104)) / 8;
	const command = "tabkyra setup";
	const typed = command.slice(0, Math.max(0, Math.floor((frame - at(112)) / 1.4)));
	return (
		<AbsoluteFill>
			<Backdrop />
			<Center gap={size(26, 40)} style={{ padding: size(80, 60) }}>
				<div style={{ display: "flex", flexDirection: vertical ? "column" : "row", alignItems: "center", gap: size(40, 30) }}>
					<Helm
						size={size(190, 240)}
						ring={ease(frame, 0, at(106))}
						pegs={Array.from({ length: 8 }, (_, i) => ease(frame, i * step, 5))}
						pointer={ease(frame, at(106) - 2, 5)}
					/>
					<div
						style={{
							fontFamily: FONT.sans,
							fontWeight: 600,
							fontSize: size(180, 170),
							letterSpacing: "-0.035em",
							color: C.paper,
							opacity: ease(frame, at(106), 6),
							translate: `${(1 - ease(frame, at(106), 12)) * (vertical ? 0 : -60)}px ${(1 - ease(frame, at(106), 12)) * (vertical ? 40 : 0)}px`,
						}}
					>
						Tabkyra
					</div>
				</div>
				<Words
					words={vertical ? ["You steer.", "Your agents", "work the tabs."] : ["You steer.", "Your agents work the tabs."]}
					ats={[at(108), at(109), at(110)]}
					size={size(96, 96)}
					font={FONT.serif}
					italic
					colors={[C.paper, C.brass, C.brass]}
				/>
				<div
					style={{
						marginTop: size(20, 30),
						padding: `${size(22, 26)}px ${size(40, 44)}px`,
						borderRadius: size(20, 22),
						background: C.inkDeep,
						border: `1px solid ${C.inkLine}`,
						opacity: ease(frame, at(112), 5),
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						gap: 10,
					}}
				>
					<div style={{ fontFamily: FONT.mono, fontSize: size(64, 60), color: C.paper }}>
						<span style={{ color: C.brass }}>$ </span>
						{typed}
					</div>
					<div style={{ fontFamily: FONT.sans, fontSize: size(30, 30), color: C.mist, opacity: ease(frame, at(114), 6), textAlign: "center" }}>
						builds the extension, registers your browser, offers to add your agents
					</div>
				</div>
				<div
					style={{
						marginTop: size(16, 30),
						display: "flex",
						flexDirection: vertical ? "column" : "row",
						alignItems: "center",
						gap: size(50, 18),
						opacity: ease(frame, at(116), 6),
						translate: `0 ${(1 - ease(frame, at(116), 10)) * 30}px`,
					}}
				>
					<span style={{ fontFamily: FONT.mono, fontSize: size(64, 64), color: C.brass }}>dbaney.com/tabkyra</span>
					<span style={{ fontFamily: FONT.mono, fontSize: size(40, 40), color: C.mist }}>github.com/baney75/tabkyra</span>
				</div>
			</Center>
			<Flash at={0} strength={0.35} />
			<Flash at={at(120)} strength={0.4} />
		</AbsoluteFill>
	);
};
