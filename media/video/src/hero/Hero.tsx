import { AbsoluteFill, Audio, interpolate, staticFile, useVideoConfig } from "remotion";
import { Moment, Form, TabGroup } from "./Agent";
import { BEATS, HERO_FRAMES, Seg } from "./beat";
import { Blocked, Flagged, Refused } from "./Checks";
import { Finish } from "./motion";
import { Build, ColdOpen, Gap, Line } from "./Open";
import { EndCard, Router, WorksWith } from "./Outro";

/**
 * The hero cut. Every segment starts and ends on a beat index from src/hero/music.json, so
 * cuts land on the music. `Hero` (16:9) and `HeroVertical` (9:16) render this same edit.
 */
export const Hero: React.FC = () => {
	const { fps } = useVideoConfig();
	return (
		<AbsoluteFill style={{ background: "#0F1B24" }}>
			<Audio
				src={staticFile("hero/music.m4a")}
				// The master already ends cleanly at 57.4 s; a short fade keeps the end click-free.
				volume={(f) => interpolate(f, [HERO_FRAMES - fps * 0.4, HERO_FRAMES], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
			/>
			<Seg name="Cold open" start={0} end={4}>
				<ColdOpen />
			</Seg>
			<Seg name="The line" start={4} end={12}>
				<Line />
			</Seg>
			<Seg name="Build" start={12} end={28}>
				<Build />
			</Seg>
			<Seg name="The gap" start={28} end={32}>
				<Gap />
			</Seg>
			<Seg name="It asks first" start={32} end={44}>
				<Moment />
			</Seg>
			<Seg name="Its own tab group" start={44} end={52}>
				<TabGroup />
			</Seg>
			<Seg name="Fills it, reads it back" start={52} end={61}>
				<Form />
			</Seg>
			<Seg name="Refused" start={61} end={72}>
				<Refused />
			</Seg>
			<Seg name="Flagged" start={72} end={80}>
				<Flagged />
			</Seg>
			<Seg name="Blocked" start={80} end={92}>
				<Blocked />
			</Seg>
			<Seg name="The skill router" start={92} end={104}>
				<Router />
			</Seg>
			<Seg name="Works with" start={104} end={110}>
				<WorksWith />
			</Seg>
			<Seg name="End card" start={110} end={BEATS.length}>
				<EndCard />
			</Seg>
			<Finish />
		</AbsoluteFill>
	);
};
