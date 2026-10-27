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
social), both H.264 with AAC audio at 30 fps and 57.6 s, ending with the music, plus
`media/hero-poster.jpg` (1280×720). The shot plan is in [HERO-STORYBOARD.md](HERO-STORYBOARD.md);
the source is `src/hero/`, registered as the `Hero`, `HeroVertical` and `HeroPoster` compositions.

**What is recorded and what is drawn.** The browser frame is drawn; the page, the group name
and all tool output are recorded. In full: page screenshots, side panel crops, the elicitation
prompt's message and choices, the tab group name, tab titles, URLs, every tool call's arguments
and result, all CLI output and the router's matches and timing come from `public/capture/`.
Drawn are the browser frame around the page screenshots, the box around the inline prompt, the
panels that hold calls and terminal output, and the motion graphics: the helm, the stamps
(REFUSED, FLAGGED, BLOCKED), the count-ups and the type.

Every claim a stamp, highlight or label makes is checked against the recording before render:
each typed command against the recorded args (the shipped lint must have run on `skills/`),
the made-up DOI's refusal line and non-zero exit, the retraction lines and exit 3, the four lint
errors (each naming a line of the shown skill file) and non-zero exit, the shipped skills'
"✓ Clean." with no errors and exit 0, the catalog calls, found by content in recorded order, each
acting on the latest recorded `read_page`, with the `//` labels on the two clicks taken from that
snapshot's button names, the search text against the recorded results, each action's own recorded result (navigate,
type, click and fill all succeeded), the read-back sentence (the recorded `get_page_text`
result, with the book searched, the card name and the branch filled in their places), the
prompt choice the run answered (for the book's site), and the router's p95 (under 1 ms) and
each row's command (the recorded task, quoted as the capture quotes it) and routed skill, parsed from the recorded output. The checks live in `src/hero/claims.ts`, and
the scenes show what it returns. `src/hero/heroClaims.ts` runs them when Hero, HeroVertical or
HeroPoster renders, so a recording that doesn't back a claim fails those renders while the Demo
composition and Studio still load. `npm test` runs the same checks on the real capture and on
doctored copies (a doi.org outage, a failing shipped lint, an extra click before the hold, a
p95 over 1 ms, a stale confirmation, a recorded deny and more) and expects each doctored copy to
fail.

```bash
cd media/video && npm install
npm test                 # the checks above, on the real capture and on doctored copies
npm run render:hero      # out/hero.mp4, out/hero-vertical.mp4, out/hero-poster.jpg
npm run publish-hero     # copies all three to media/
```

**Music.** `public/hero/music.m4a` is an instrumental made for this video on the maintainer's
own machine (Parish1) with [ACE-Step 1.5](https://huggingface.co/ACE-Step/Ace-Step1.5) at revision
`19671f406d603126926c1b7e2adc169acbcade22`, seed 302. Its components are MIT-licensed, except
the bundled Qwen3-Embedding-0.6B text encoder, which is Apache-2.0; neither license restricts
outputs, and the model card says "You can strictly use the generated
music for **commercial purposes**." The track is distributed here under the repository's
AGPL-3.0, like every other asset. Prompt, components and their licenses, and the quote's source
are in [public/hero/NOTICE.md](public/hero/NOTICE.md). No paid or credit-based service was used.

Five takes were generated (a 30 s test and four 60 s takes) and compared by analysis rather than
by ear: tempo, beat regularity, energy per second and where the drop lands. Seed 302 was the only
take with every part the edit needs: an impact in the first second, a quieter build, 0.6 s of
near-silence (13.4–14.0 s) before the drop at 15.30 s, two drum breaks and a clean end, on a
steady 126 BPM grid. Of the others, two had no build or drop, and one ran at 99 BPM. Whisper
heard no words in it. The master was trimmed to 57.6 s with a 0.2 s fade-out, peak-limited and
set to about -14 LUFS with a true peak under -1 dBTP, then encoded as AAC.

The beat map the edit reads, `src/hero/music.json`, comes from the committed track; rerunning
this reproduces it:

```bash
ffmpeg -i public/hero/music.m4a -ac 1 -ar 22050 /tmp/hero-music.wav
python3 scripts/analyze_music.py /tmp/hero-music.wav src/hero/music.json public/hero/music.m4a   # needs librosa
```

It records the beats (126.05 BPM), downbeats, the entries where the full band comes back (15.30,
30.55 and 45.78 s; the first is the drop, +16.2 dB) and the end. Every cut and slam in
`src/hero/` is a beat index into it, so a new track only needs a new map (and the scenes
re-checked).

**The skill router.** Segment 11 (`Router` in `src/hero/Outro.tsx`) shows four real
`tabkyra skill match` runs and, from one `tabkyra skill eval --json` run, the router's p95 time
per match, the number of timed matches and the bundled skill count. The headline says "in under
a millisecond at p95": the figure is the match itself, not a whole `tabkyra` command, which also
starts Node. `node scripts/demo/capture-router.mjs` (after `cd cli && npm run build`) records it
into `public/capture/router.json` (stdout only; a `skill match` that writes to stderr fails it), and fails if a task routes anywhere other than its expected
skill, if the eval's gates fail, or if p95 is not under a millisecond.
