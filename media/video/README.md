# Demo video

The source for `media/demo.mp4` (1920×1080, 30 fps, H.264, silent with burned-in captions)
and `media/demo-poster.jpg` (1280×720). The shot plan is in [STORYBOARD.md](STORYBOARD.md).

Nothing on screen is mocked. `scripts/demo/capture-video.mjs` records a real run and writes
`public/capture/`:

- The built extension in a throwaway headless Chromium, its native host, and `tabkyra mcp`
  driven by a scripted MCP client that declares elicitation, the way Claude Code does. The
  browser frames are that client's own `screenshot` calls.
- The side panel is the extension's `sidepanel.html` in a tab of the same browser, clicked
  through a CDP session attached to that tab only.
- The library and skill lint beats run the real CLI against doi.org, OpenAlex and Crossref.
- `capture.json` holds the tool calls with their real results, the permission prompt, the
  copied setup prompt, and the CLI output and exit codes. Every recorded value in the video
  (call arguments, refs, results, URLs, CLI output and exit codes) is read from it. A few fixed
  labels are written in the scenes: the `# allowed beforehand: tabkyra allow 127.0.0.1` note,
  the argument-free `read_page { filter: "interactive" }` and `get_page_text {}` call lines, and
  the "Pinecrest Library" tab title.
- The video edits the order: the run did the catalog work first and opened Gutenberg after,
  but the video shows the permission beat first. Each call and result is the run's own.

## Re-record and re-render

Needs Node 22.4 or newer for the capture (it uses Node's built-in WebSocket and stops at once
on older versions), the Chromium from `cd cli && npx playwright-core install chromium`, and
network access. The render needs nothing beyond `npm install`: Remotion writes the MP4 and the
poster JPEG itself. Remotion is not open source: it is free for individuals and companies of up
to three people, and larger companies need a Remotion company license (see remotion.dev/license). A capture that fails partway leaves the previous `public/capture/` as it
was.

From the repo root:

```bash
npm run build && (cd cli && npm run build)   # the extension and CLI being filmed
node scripts/demo/capture-video.mjs          # needs network for gutenberg.org, doi.org, OpenAlex, Crossref
cd media/video && npm install
npm run render                               # out/demo.mp4 and out/demo-poster.jpg (no ffmpeg needed)
npm run publish-media                        # copies both to media/
```

`npm run dev` opens Remotion Studio for the `Demo` composition, each scene on its own, and
the `Poster` still. The side panel crops and rings are placed from element boxes the capture
records (`browser.boxes` in `capture.json`), so they follow layout changes. Live data drifts
(citation counts, the Gutenberg page), so a new capture can change a few words of output;
check the captions still match before publishing.

Fonts are Instrument Serif, Instrument Sans and JetBrains Mono under the OFL; their licenses
are in `public/fonts/`.

## Hero video

`media/hero.mp4` (1920×1080) and `media/hero-vertical.mp4` (1080×1920, the same edit for
social), both H.264 with AAC audio at 30 fps and 59 s, plus `media/hero-poster.jpg`
(1280×720). The shot plan is in [HERO-STORYBOARD.md](HERO-STORYBOARD.md); the source is
`src/hero/`, registered as the `Hero`, `HeroVertical` and `HeroPoster` compositions. Every frame
that looks like the product is a capture from `public/capture/` or output from
`capture.json`. The helm, stamps (REFUSED, FLAGGED, BLOCKED), count-ups and type are motion
graphics on top.

```bash
cd media/video && npm install
npm run render:hero      # out/hero.mp4, out/hero-vertical.mp4, out/hero-poster.jpg
npm run publish-hero     # copies all three to media/
```

**Music.** `public/hero/music.m4a` is an instrumental made for this video on Donovan's own
machine (Parish1) with [ACE-Step 1.5](https://huggingface.co/ACE-Step/Ace-Step1.5)
(`acestep-v15-turbo` with the 1.7B planner LM, model revision
`19671f406d603126926c1b7e2adc169acbcade22`), seed 302, 60 s, with this prompt: "High-energy
electronic trap instrumental, 126 BPM, cinematic brass and synth lead, intro build with riser
and filtered drums, big drop with heavy 808 bass and hard-hitting drums, triumphant launch
trailer energy, steady four-on-the-floor sections, clean final hit, no vocals". The model and
its code are MIT-licensed, and its model card states that generated music can be used
commercially. No paid or credit-based service was used.

Five takes were generated (a 30 s test and four 60 s takes) and compared by analysis rather
than by ear: tempo, beat regularity, an energy curve per second and where the drop lands.
Seed 302 was the only take with every part the edit needs: an impact in the first second, a
quieter build, a full second of silence before a +13 dB drop at 15.3 s, two drum breaks and
a clean end at 57.4 s, all on a steady 126 BPM grid. Of the others, two were flat with no
build or drop, and one ran at 99 BPM. Whisper heard no words in it.

The master was trimmed to 57.6 s, peak-limited and set to about -14 LUFS integrated with a
true peak under -1 dBTP, then encoded as AAC. To rebuild the beat map the edit reads:

```bash
ffmpeg -i public/hero/music.m4a -ac 1 -ar 22050 /tmp/hero-music.wav
python3 scripts/analyze_music.py /tmp/hero-music.wav src/hero/music.json   # needs librosa
```

Every cut and slam in `src/hero/` is a beat index into that map, so a new track only needs a
new map (and the scenes re-checked).

**The skill router.** Segment 12 (`Router` in `src/hero/Outro.tsx`) shows four real
`tabkyra skill match` runs and the router's p95 latency from `tabkyra skill eval`, recorded by
`node scripts/demo/capture-router.mjs` (after `cd cli && npm run build`) into
`public/capture/router.json`. The script fails if a task routes anywhere other than its
expected skill, or if the eval's gates fail.
