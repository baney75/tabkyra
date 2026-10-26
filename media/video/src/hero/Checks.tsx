import { AbsoluteFill, useCurrentFrame } from "remotion";
import { DATA } from "../data";
import { C, FONT } from "../theme";
import { useBeat } from "./beat";
import { Backdrop, CountUp, ease, Flash, shake, Stamp, useLayout, Whip, Words } from "./motion";
import { Center, Term, useSize } from "./parts";

const madeUp = DATA.cli.libraryMadeUp;
const retracted = DATA.cli.libraryRetracted;
const lint = DATA.cli.lintBad;

/** The citation count the CLI printed, e.g. "cited by 3011". */
const citedBy = (() => {
	const m = retracted.out.match(/cited by (\d+)/);
	if (!m) throw new Error("capture.json: the retracted add has no citation count");
	return Number(m[1]);
})();

/** B61–B71: the break types the real command; on B64 the refusal prints and REFUSED slams. */
export const Refused: React.FC = () => {
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	return (
		<Whip dur={at(72) - at(61)} from="down" inDur={1}>
			<Backdrop hue={C.alarm} />
			<AbsoluteFill style={{ translate: shake(frame, at(64), 26) }}>
				<Center gap={size(60, 70)} style={{ padding: size(100, 50) }}>
					<Term
						width={size(1640, 1000)}
						size={size(40, 34)}
						lines={[
							{ text: madeUp.shown, at: 0, typed: true },
							{ text: madeUp.out, at: at(64), color: C.alarm },
						]}
					/>
					<div style={{ height: size(170, 200), display: "flex", alignItems: "center" }}>
						<Stamp text="REFUSED" at={at(64)} size={size(130, 130)} />
					</div>
					<div style={{ opacity: ease(frame, at(66), 6) }}>
						<Words words={vertical ? ["Made-up DOIs", "are refused."] : ["Made-up", "DOIs", "are", "refused."]} ats={[at(66), at(66) + 3, at(66) + 6, at(66) + 9]} size={size(84, 80)} />
					</div>
				</Center>
			</AbsoluteFill>
			<Flash at={at(64)} color={C.alarm} strength={0.3} />
		</Whip>
	);
};

/** B72–B79: the real retracted paper; its citation count counts up, then FLAGGED. */
export const Flagged: React.FC = () => {
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	const [title, , , , last] = retracted.out.split("\n");
	return (
		<Whip dur={at(80) - at(72)} from="down" inDur={7}>
			<Backdrop hue={C.alarm} />
			<AbsoluteFill style={{ translate: shake(frame, at(76), 22) }}>
				<Center gap={size(40, 60)} style={{ padding: size(100, 50) }}>
					<div style={{ display: "flex", flexDirection: vertical ? "column" : "row", alignItems: "baseline", gap: size(30, 10) }}>
						<CountUp to={citedBy} at={2} dur={at(74) - 2} style={{ fontFamily: FONT.sans, fontWeight: 600, fontSize: size(260, 240), color: C.paper, letterSpacing: "-0.04em" }} />
						<span style={{ fontFamily: FONT.serif, fontStyle: "italic", fontSize: size(110, 100), color: C.mist }}>citations.</span>
					</div>
					<Term
						width={size(1640, 1000)}
						size={size(32, 30)}
						lines={[
							{ text: retracted.shown, at: 0, typed: true },
							{ text: title.replace(/\s{2,}/g, "  "), at: 8, color: C.alarm },
							{ text: last.trim(), at: at(76), color: C.alarm },
						]}
					/>
					<div style={{ height: size(160, 190), display: "flex", alignItems: "center", gap: size(50, 30), flexDirection: vertical ? "column" : "row" }}>
						<Stamp text="FLAGGED" at={at(76)} size={size(120, 120)} tilt={7} />
						{frame >= at(77) ? <Words words={["Still", "retracted."]} ats={[at(77), at(77) + 4]} size={size(90, 84)} colors={[C.paper, C.alarm]} /> : null}
					</div>
				</Center>
			</AbsoluteFill>
			<Flash at={at(76)} color={C.alarm} strength={0.3} />
		</Whip>
	);
};

/** B80–B91: the real bad skill; four real errors slam in, BLOCKED, then the bundled skills pass. */
export const Blocked: React.FC = () => {
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const file = DATA.cli.badSkill.trimEnd().split("\n");
	const errors = lint.out.split("\n").filter((l) => /\berror\b/.test(l));
	const flagged = errors.map((l) => Number(l.match(/SKILL\.md:(\d+)/)?.[1]));
	const clean = frame >= at(88);
	const shown = file.slice(11, 17); // "## Steps" through the three steps
	return (
		<Whip dur={at(92) - at(80)} from="right" inDur={7}>
			<Backdrop hue={clean ? C.tide : C.alarm} />
			<AbsoluteFill style={{ translate: shake(frame, at(84), 24) }}>
				{!clean ? (
					<Center gap={size(36, 44)} style={{ padding: size(80, 50) }}>
						<div
							style={{
								width: size(1640, 1000),
								padding: `${size(22, 24)}px 0`,
								borderRadius: size(26, 26),
								background: C.inkDeep,
								border: `1px solid ${C.inkLine}`,
								fontFamily: FONT.mono,
								fontSize: size(30, 26),
								lineHeight: 1.5,
							}}
						>
							<div style={{ padding: `0 ${size(30, 26)}px 10px`, fontFamily: FONT.sans, fontSize: size(26, 26), color: C.mist }}>page-helper/SKILL.md</div>
							{shown.map((text, i) => {
								const n = i + 12;
								const k = flagged.indexOf(n);
								const on = k >= 0 ? ease(frame, at(80 + k), 5) : 0;
								return (
									<div key={`${n}-${text}`} style={{ display: "flex", background: `rgba(228,107,93,${0.22 * on})`, boxShadow: on ? `inset 8px 0 0 rgba(228,107,93,${on})` : "none" }}>
										<span style={{ width: size(70, 60), textAlign: "right", paddingRight: 16, color: "#43586A", flex: "none" }}>{n}</span>
										<span style={{ color: on > 0.5 ? C.paper : C.mist, paddingRight: 20, whiteSpace: "pre-wrap" }}>{text}</span>
									</div>
								);
							})}
						</div>
						<div style={{ width: size(1640, 1000), fontFamily: FONT.mono, fontSize: size(28, 24), lineHeight: 1.45, color: C.alarm }}>
							{errors.map((l, i) => {
								const t = at(80 + i);
								const parts = l.replace(/\s{2,}/g, "  ").split("  ");
								return (
									<div key={l} style={{ opacity: ease(frame, t, 4), translate: `${(1 - ease(frame, t, 8)) * 60}px 0` }}>
										{parts.slice(0, 3).join("  ")}
									</div>
								);
							})}
						</div>
						<div style={{ display: "flex", alignItems: "center", gap: size(50, 40), height: size(170, 180) }}>
							<span style={{ fontFamily: FONT.sans, fontWeight: 600, fontSize: size(170, 150), color: C.paper, lineHeight: 1 }}>
								<CountUp to={errors.length} at={at(80)} dur={at(84) - at(80)} />
							</span>
							<span style={{ fontFamily: FONT.serif, fontStyle: "italic", fontSize: size(84, 72), color: C.mist }}>problems.</span>
							<Stamp text="BLOCKED" at={at(84)} size={size(110, 96)} />
						</div>
					</Center>
				) : (
					<Whip dur={at(92) - at(88)} from="zoom" inDur={6} exit={false} start={at(88)}>
						<Center gap={size(50, 60)} style={{ padding: size(100, 50) }}>
							<Term
								width={size(1300, 1000)}
								size={size(46, 40)}
								lines={[
									{ text: DATA.cli.lintShipped.shown, at: at(88), typed: true },
									{ text: DATA.cli.lintShipped.out, at: at(89), color: C.tide },
								]}
							/>
							<Words words={["Every", "bundled", "skill", "passes."]} ats={[at(89), at(89) + 3, at(89) + 6, at(90)]} size={size(110, 100)} colors={[C.paper, C.paper, C.paper, C.tide]} />
						</Center>
						<Flash at={at(89)} color={C.tide} strength={0.25} />
					</Whip>
				)}
			</AbsoluteFill>
			<Flash at={at(84)} color={C.alarm} strength={0.3} />
		</Whip>
	);
};
