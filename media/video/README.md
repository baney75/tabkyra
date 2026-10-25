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
  copied setup prompt, and the CLI output and exit codes. Every line of agent and terminal
  text in the video is read from it.

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
