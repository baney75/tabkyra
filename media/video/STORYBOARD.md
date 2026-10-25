# Tabkyra demo video: storyboard

**Spec.** 1920×1080, 30 fps, H.264 MP4 under 20 MB, about 85 s, silent, captions burned in.
Poster: 1280×720 JPEG. Shown on dbaney.com/tabkyra, in the README and in the portfolio.

**Treatment.** A coding agent works a real browser while the user stays in charge. Every
browser frame, side panel frame and line of command output comes from a real run recorded by
`scripts/demo/capture-video.mjs` (the built extension in headless Chromium, its native host,
`tabkyra mcp` driven by a scripted MCP client, and the real CLI against doi.org, OpenAlex and
Crossref). Visual language is the brand: ink background (#0F1B24), paper text (#F6F2EA), one
brass accent (#E3A93B), tide (#43B3A0) for success. Type: Instrument Serif italic for the
line, Instrument Sans for captions and titles, JetBrains Mono for tool calls and terminals.
**Signature motif:** the brass tab-group pill, "Tabkyra · claude", the agent's own group. It
sits on every browser window, so the viewer learns where the agent works.
**Through-line:** the user's hand stays on the wheel. Each chapter adds one control (asks
first, own tabs, reads back, checked sources, linted skills), and the last chapter hands the
wheel to the viewer: one prompt to get started.

Every scene has one chapter label (top left, brass, small caps) and one caption (bottom, 52
px, paper on an ink plate). The captions say what happens on screen in plain words.

---

## Chapter 1: Title (0.0–5.0 s)

- **What happens:** On ink, the brass app tile rises 40 px and fades in (0.0–1.0 s). The
  wordmark "Tabkyra" fades in under it (0.6–1.4 s). The line types on word by word:
  "You steer." (1.4 s), "Your agents work the tabs." (2.0 s). A slate subline fades in at
  2.8 s: "A Chromium extension and CLI for Claude Code, Codex and any MCP agent."
- **Camera:** static; a slow 2% push over the whole shot.
- **Text:** "Tabkyra" / "You steer. Your agents work the tabs." / subline above.
- **Transition out:** the title group fades and lifts while the first scene slides up
  from below (12-frame fade).

## Chapter 2: Asks first (5.0–19.0 s)

- **What happens:** Left, an agent pane ("claude · tool calls") prints
  `navigate { url: "https://www.gutenberg.org/ebooks/2701" }`. Under it, the inline
  prompt from the real elicitation appears: "tabkyra: the browser agent wants to open
  www.gutenberg.org. Allow?" with the three real choices. Right, the real side panel
  (Settings > Bridge) shows the same request, "claude wants to open www.gutenberg.org",
  with Allow site / Allow once / Deny. A brass ring pulses on the request card (8.0 s).
  At 11.5 s the highlight lands on "Allow www.gutenberg.org from now on", the choice is
  confirmed, and the side panel crossfades to the real after-state: the request is gone and
  www.gutenberg.org is listed under Allowed sites (12.5 s), with a tide ring on that row.
- **Camera:** static; the side panel scales from 0.97 to 1.0 as it enters.
- **Text:** label "ASKS FIRST". Caption (5.6 s): "A new site? The agent asks first. You
  answer inline or in the side panel." Caption swap (12.5 s): "Allow it once, for good,
  or deny it. `tabkyra allow <host>` works too."
- **Transition out:** the side panel slides right and out while a browser window slides
  in from the right (match on the right half of the frame).

## Chapter 3: Its own tabs (19.0–31.0 s)

- **What happens:** A browser window holds the real screenshot of the Project Gutenberg
  page. Its tab strip shows the brass group pill "Tabkyra · claude" and the real tab title.
  The pill gets a brass glow ring at 20.0 s. The agent pane prints `get_page_text` and the
  real text it got back types in: the title line and the first sentence of the summary.
- **Camera:** a slow push (1.00 to 1.04) on the browser window.
- **Text:** label "ITS OWN TABS". Caption: "It opens pages in its own background tab group.
  It can't see your other tabs, and it never steals focus."
- **Transition out:** the page inside the window crossfades to the library catalog (the
  window frame stays: a match cut on the window).

## Chapter 4: Fills forms, reads back (31.0–47.0 s)

- **What happens:** The window shows the real local catalog. The agent pane runs the real
  calls one by one, each synced to the screenshot it produced:
  `read_page { filter: "interactive" }` returns `e1 textbox "Search the catalog"`,
  `type { ref: "e1", text: "Moby-Dick", submit: true }` (results screenshot),
  `click { ref: "e1" }  // Place hold`, `read_page` returns `e1 textbox "Library card name"`
  and `e2 combobox "Pickup branch"`, two `fill` calls (form screenshot), `click e3 // Confirm
  hold`, then `get_page_text` returns "Hold placed for Ada Lovelace: Moby-Dick. Pick it up at
  Main Street after Thursday." (confirmation screenshot), with a tide check.
- **Camera:** static; each new screenshot crossfades in over 8 frames.
- **Text:** label "FILLS FORMS, READS BACK". Caption: "It reads the page as element refs,
  acts by ref, then reads the result back to check it." Small slate note at 31.5 s:
  "127.0.0.1 was allowed beforehand with `tabkyra allow 127.0.0.1`."
- **Transition out:** the window and agent pane slide left and out, a terminal slides in
  from the right (a push).

## Chapter 5: Checked sources (47.0–61.0 s)

- **What happens:** A terminal. `tabkyra library add 10.1037/0033-2909.132.3.354` types on;
  the real output appears: "Added cepeda2006distributed ... verified by doi.org, openalex,
  crossref-updates; cited by 1883" with a tide rule. Then
  `tabkyra library add 10.1016/S0140-6736(97)11096-0` types on; the real output appears and
  "[RETRACTED]", the two notices and "RETRACTED: don't cite this as support." are marked with
  a red underline and the exit code 3 shows. Then a made-up DOI is refused ("is not
  registered (doi.org returned 404)").
- **Camera:** static; the terminal scrolls up as lines arrive.
- **Text:** label "CHECKED SOURCES". Caption (47.6 s): "`tabkyra library` checks every DOI
  against doi.org, OpenAlex and Crossref before it saves it." Caption swap (53.0 s):
  "Retracted papers are flagged everywhere they appear. Made-up DOIs are refused."
- **Transition out:** the terminal's contents wipe upward; the same terminal frame carries
  into the next chapter.

## Chapter 6: Linted skills (61.0–72.0 s)

- **What happens:** Left, the bad skill's SKILL.md (the real file the capture linted).
  Lines 14, 15 and 16 get a red bar one by one as the lint output names them. Right, the
  terminal runs `tabkyra skill lint page-helper` and prints the four real errors
  (remote-code, safety-bypass, conceal-from-user, secret-exfiltration) and "✗ 4 problems."
  Then `tabkyra skill lint skills/` prints "✓ Clean." for the bundled skills.
- **Camera:** static.
- **Text:** label "LINTED SKILLS". Caption: "Skill lint refuses piped installers, safety
  bypasses, secret grabs and hidden text. CI runs it on every pull request."
- **Transition out:** quiet beat: everything fades to ink for 10 frames before the payoff.

## Chapter 7: Get started (72.0–80.5 s)

- **What happens:** The real side panel welcome dialog. A cursor glides to "Copy setup prompt
  for your agent" (the button box recorded in the capture) and clicks at 74.0 s; the panel
  crossfades to the real "Setup prompt copied. Paste it into your agent." toast. Beside it,
  the first lines of the real copied prompt type into an agent pane ("Set up Tabkyra
  (https://github.com/baney75/tabkyra) so you can use my browser...").
- **Camera:** a gentle push toward the button before the click.
- **Text:** label "GET STARTED". Caption: "One prompt sets it up. Your agent installs the CLI,
  connects itself and installs the skills."
- **Transition out:** crossfade to the end card (15 frames).

## Chapter 8: End card (80.5–86.0 s) — closing lines are untouchable

- **What happens:** The brass tile, "Tabkyra", the line "You steer. Your agents work the
  tabs.", then two URLs in JetBrains Mono: **github.com/baney75/tabkyra** and
  **dbaney.com/tabkyra**, and a slate line "Free and open source. AGPL-3.0." Hold to the end.
- **Camera:** static.
- **Text (untouchable):** "You steer. Your agents work the tabs." /
  "github.com/baney75/tabkyra" / "dbaney.com/tabkyra".
- **Transition out:** none; the last frame holds.

---

## Risks

- **Text too small on phones.** Code lines are set at 26 px or more and captions at 52 px;
  check at 1280 wide and at 640 wide before calling it done.
- **Reading time.** Each caption stays up at least 4 s; terminal output holds at least
  2.5 s after its last line.
- **Live data drifts.** Citation counts, page text and the Gutenberg page change over time.
  The video shows the run recorded in `public/capture/capture.json`, dated in that file.
- **File size.** Mostly flat colour and text; CRF 20 should land well under 20 MB.
- **Licensing.** Fonts are OFL (licenses in `public/fonts/`). No music.
- **Render time.** About 2,600 frames; render with `--concurrency` set to the core count.
