# Tabkyra hero video: storyboard

The short, music-driven cut. The 85-second captioned walkthrough (`Demo`, `media/demo.mp4`)
stays the full demo; this is the one people share.

**Spec.** `Hero` 1920×1080 and `HeroVertical` 1080×1920, 30 fps, H.264 + AAC, 58.0 s
(1740 frames), the same edit in both. Poster `HeroPoster` 1280×720. Outputs:
`media/hero.mp4`, `media/hero-vertical.mp4`, `media/hero-poster.jpg`.

**Music.** `public/hero/music.m4a`, an instrumental generated on Parish1 with ACE-Step 1.5
(take P2, seed 302; four takes compared by analysis, see the README). 126 BPM, 0.476 s a
beat. The beat map is `src/hero/music.json` from `scripts/analyze_music.py`; every cut and
slam below is a beat index `B` into it, so nothing hardcodes a time the music already knows.
Structure, measured: impact at B0 (0.06 s); intro build B0–B31 with a full silence at
13.4–14.0 s; **drop at B32 (15.30 s)**; drums break B61–B63 and come back at **B64
(30.55 s)**; break B93–B95 and back at **B96 (45.78 s)**; final hit **B120 (57.21 s)**, hard
stop at 57.4 s. That is 8 + 8 + 8 + 6 bars.

**Treatment.** Kinetic type in the brand (Instrument Sans semibold for slams, Instrument Serif
italic for the line, JetBrains Mono for commands and real output), on ink with one brass
accent, tide for "allowed" and "clean", the CLI's red for refusals. Bold camera moves into the
real captures in `public/capture/`: push-ins, pans, parallax and whip transitions with motion
blur. Stamps (REFUSED, BLOCKED, FLAGGED) and count-ups are motion graphics laid over the real
output, never in place of it. Every frame that looks like the product is a real capture or
real recorded output from `capture.json`.
**Signature motif:** the helm assembling peg by peg. The brand forbids rotating the mark, so
instead of spinning it, the eight pegs light up in a clockwise sweep around the hub on 8th
notes, which reads as "spinning up" while the mark stays upright.
**Through-line:** you steer. Every beat shows one thing the user controls or the tool checks,
ending on the command that sets it up.

Both cuts share the timeline. The vertical cut stacks what the wide cut places side by side
and scales captures to the width; type sizes follow the short side.

---

## 1. Cold open (B0–B3, 0.06–1.97 s)

- **What happens:** Black-ink frame, brass flash on the impact at B0. The ring of the helm
  draws itself (B0–B2) while the eight pegs light clockwise on 8th notes; the pointer pops at
  B3. Camera: a fast push from 1.4× to 1.0×.
- **Transition out:** hard cut on B4.

## 2. The line (B4–B11, 1.97–5.71 s)

- **What happens:** **"You steer."** slams in at B4 (the bar's downbeat, within 2 s), huge,
  with a short shake and brass flash. The helm shrinks above it. At B8–B11 **"Your agents
  work the tabs."** lands word by word, one word per beat, in brass serif italic.
- **Transition out:** whip up on B12.

## 3. Build (B12–B27, 5.71–13.42 s)

- **What happens:** Teaser montage of real captures, each with Ken Burns drift: the catalog,
  the Gutenberg page, the side panel. Words slam per two beats: "Your real browser." (B12),
  "Already signed in." (B16), "Their own tabs." (B20). Cuts speed up to one per beat over
  B24–B27 (four captures).
- **Transition out:** the music drops out; everything freezes.

## 4. The gap (B28–B31, 13.42–14.86 s)

- **What happens:** Contrast of rhythm before the impact. Near-silence in the music; on screen
  a slow push into the real pending request card ("claude wants to open www.gutenberg.org"),
  almost still, with a small slate label "a new site".
- **Transition out:** slam zoom on the drop.

## 5. The moment: it asks first (B32–B43, 15.30–20.98 s)

- **What happens:** On the drop (B32) the request card fills the frame with a brass ring,
  brass flash and shake; **"It asks first."** slams. B36: the real inline prompt text
  ("tabkyra: the browser agent wants to open www.gutenberg.org. Allow?") and its three choices
  slam in one per beat. B39: "Allow www.gutenberg.org from now on" is picked. B40: whip to the
  real after-state, www.gutenberg.org under Allowed sites with a tide ring; **"You decide."**
- **Transition out:** whip left on B44.

## 6. Its own tab group (B44–B51, 20.98–24.80 s)

- **What happens:** The browser window with the real Gutenberg screenshot flies in with
  parallax (window, then the tab strip a beat later). Push in on the brass pill "Tabkyra ·
  claude": **"Its own tab group."** (B44), **"Your tabs stay yours."** (B48).
- **Transition out:** cut on B52.

## 7. Fills it, reads it back (B52–B60, 24.80–29.62 s)

- **What happens:** One cut per beat through the real catalog run: home, results, hold form,
  filled form, confirmation. Each cut carries the real tool call that produced it in mono
  (`type`, `click`, `fill`, `fill`, `click`). B57: `get_page_text` and the real result, "Hold
  placed for Ada Lovelace...", punches in; **"Filled. Read back."** with a tide check.
- **Transition out:** the drums break; hold.

## 8. Break: the receipt (B61–B63, 29.15–30.07 s)

- **What happens:** A terminal types the real command `tabkyra library add
  10.1037/0000-0000.000.0.000`. Nothing else moves.
- **Transition out:** the drums come back at B64.

## 9. REFUSED (B64–B71, 30.55–34.36 s)

- **What happens:** On B64 the real refusal prints ("DOI ... is not registered (doi.org
  returned 404)") and a red **REFUSED** stamp slams over it, with a shake. **"Made-up DOIs are
  refused."**
- **Transition out:** whip down on B72.

## 10. Flagged (B72–B79, 34.36–38.16 s)

- **What happens:** The real Wakefield 1998 output. A big number counts up 0 → 3,011 (the real
  citation count from the capture) over two beats: **"citations."** On B76 a red **FLAGGED**
  stamp slams over the real "RETRACTED: don't cite this as support." line: **"Still
  retracted."**
- **Transition out:** whip right on B80.

## 11. BLOCKED (B80–B91, 38.16–44.40 s)

- **What happens:** The bad SKILL.md (real file). The four real lint errors slam in on
  B80–B83, each lighting its line red; a big **4** counts up beside them: **"problems."** B84: a
  red **BLOCKED** stamp. B88: `tabkyra skill lint skills/` → the real **"✓ Clean."** in tide:
  **"Every bundled skill passes."**
- **Transition out:** the music breaks again.

## 12. Slot: the skill router (B92–B95, 43.89–45.78 s)

- **Marked slot.** Reserved for the skill router ("the right skill, in under a millisecond"),
  which is not merged yet (#21). Until it is captured from main, the slot shows a merged
  feature: the real side panel welcome dialog and its "Copy setup prompt for your agent"
  button, with the real toast: **"One prompt sets it up."** The code marks it `RouterSlot`.

## 13. Works with (B96–B103, 45.78–49.59 s)

- **What happens:** On B96 **"Works with"** slams; the agents land one per beat: **Claude Code**
  (B97), **Codex** (B98), **pi** (B99), **OMP** (B100), **Cursor** (B101); B102: "and any MCP
  agent". All five are named in the README's setup section.

## 14. End card (B104–B120 and hold, 49.59–58.0 s)

- **What happens:** The helm assembles again, fast (B104–B106), with the wordmark
  **Tabkyra** (B106) and the line **"You steer. Your agents work the tabs."** (B108). B112:
  the one command that sets it up, `tabkyra setup`, types on with "builds the extension,
  registers the browser, connects your agents". B116: **dbaney.com/tabkyra** and
  github.com/baney75/tabkyra. B120: final hit, a brass flash; hold to 58.0 s while the
  music's tail ends at 57.4 s.
- **Text (untouchable):** "You steer. Your agents work the tabs." / `tabkyra setup` /
  "dbaney.com/tabkyra".

---

## Risks

- **Beat sync drift.** Frames are 33 ms; each beat rounds to the nearest frame (±17 ms).
  Checked after render by detecting cuts in the video and onsets in its audio.
- **Readability at speed.** Real output that must be read (the refusal, the retraction line,
  the confirmation) holds at least 1.5 s; one-beat cuts carry only one short word or call.
- **The mark.** No rotation, no outline, no gradient on the mark itself.
- **Vertical layout.** Side-by-side shots stack; check every beat in the 9:16 cut, not just a
  few.
- **Loudness.** The master is about -14 LUFS with a -1 dBTP ceiling. Checked again on the
  final MP4 with ffmpeg ebur128, because AAC encoding can move the peaks.
