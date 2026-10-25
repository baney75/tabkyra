# Changelog

## [Unreleased]

### Added
- Settings > Privacy. **Private mode** limits the side panel agent to OpenRouter on the chat-completions adapter, sent with `provider.zdr: true`, `data_collection: "deny"` and `allow_fallbacks: false` on every request, over HTTPS, and to models served from this machine or from hosts the user lists as their own (LAN or tailnet machines count only once listed). Every other provider, and a CORS proxy off those machines, is refused at the stream gate. **Bug reports** are off by default; the welcome dialog offers one unchecked box. When on, side panel errors are kept locally with web addresses (including data: and blob: URLs), IP addresses, emails, key-like strings and home paths removed. "Review report" shows the text in Tabkyra for editing; "Copy and open GitHub" copies it and opens a blank issue page, so nothing is sent until the user pastes and submits. `test/privacy.test.mjs`.
- `tabkyra library`: a Zotero-like source library. `add` takes a DOI, doi.org link or arXiv id, fetches CSL-JSON from the registry through doi.org, and records verification from OpenAlex (`is_retracted`, open-access copy, citation count) and Crossref update notices (retractions, withdrawals, corrections). Unregistered DOIs are refused; retracted sources are flagged and `add` exits 3. `search`, `list`, `verify`, `cite` (APA, MLA, Chicago, IEEE, Harvard, Vancouver through doi.org's formatter), `export --format bibtex|ris|csl`, `obsidian <vault>` (one note per source, frontmatter and Markdown escaped, never outside the vault) and `remove`. MCP tools `library_add`, `library_search`, `library_cite`. The `academic-research` skill uses it.
- Skill library: `tabkyra skill install` now installs nine more skills beside `tabkyra`: `academic-research` (Scholar, Crossref, OpenAlex, retraction checks, BibTeX and Obsidian notes), `osint` (public-record research with a purpose check and a never-collect list for private people), `news-research` (source ladder, sides heard, labeled claims), `dorks` (search operators and recipes), `autoresearch` (`/autoresearch`: a sub-question loop with a stop rule, plus a measured keep-or-revert mode), `rsi` (`/rsi`: lessons from real work become small, linted, optionally adversarially reviewed skill edits with backups; upstream submission only on the user's yes), `artifacts` (self-contained HTML checked in the browser), `proton-pass` (credentials through `pass-cli run`, `op run` or `bws run`, never through the model) and `kyraskillmaker` (the standard every skill meets). `tabkyra skill list`, `tabkyra skill install <name>`, `tabkyra skill print <name>`. `tabkyra skill apply <folder>` checks an edited skill and prints the diff; with `--yes` it backs up the current version, keeps the edit across reinstalls and installs it, never over a same-name skill Tabkyra didn't write. It refuses edits to `rsi` and `kyraskillmaker` and edits that drop a section. `tabkyra skill revert <name>` goes back to the bundled text; `tabkyra skill print <name> --raw` prints the exact source an edit starts from.
- `tabkyra skill lint [path...]`: the gate for every skill. It refuses hidden text (invisible and bidi characters, Unicode tags, lookalike letters, HTML comments), instruction overrides, fake system turns, concealment, piped remote code, run-time remote instructions, secret exfiltration, credential-file reads, agent and shell config writes, safety bypasses, encoded blobs, remote images, suspicious links, missing structure and non-Markdown files. `cli/test/skill-lint.test.mjs` red-teams each rule. Threat model: `docs/skill-security.md`.
- `.github/workflows/ci.yml`: every pull request runs the skill gate (no install scripts) and the full build, format, type and test pass. `.github/CODEOWNERS` requires a maintainer's review for `skills/`, the lint and CI.
- "Copy setup prompt for your agent" button in Settings > API Keys, Settings > Bridge and the welcome dialog. The prompt has an agent install the CLI, connect the MCP server (or the pi extension), install the skills, run `tabkyra doctor` and call `status`. `test/agent-setup-prompt.test.mjs` lints it like a skill.
- `tabkyra skill install` writes the Tabkyra agent skill (`skills/tabkyra/SKILL.md`) for Claude Code (`~/.claude/skills`), Codex (`~/.codex/skills`) and OpenCode (`~/.config/opencode/skills`), and never replaces a tabkyra skill it didn't write without `--force`. `tabkyra skill print` gives the same text as an AGENTS.md section. `tabkyra setup` offers it. `cli/test/skill.test.mjs` keeps the skill, the MCP instructions and the tool schemas in agreement.
- `handle_dialog` MCP tool and `dialog` bridge method. An alert, confirm or prompt box used to freeze every call for 90 s; now the call fails at once with `dialog_open` and the box's text, and `handle_dialog` presses OK or Cancel.
- `cli/eval/skill-eval.mjs`: three scripted tasks on a local fixture site, with and without the skill, through `claude -p` on a headless throwaway browser.
- `tabkyra update`: installs signed GitHub releases. It verifies the minisign signature on `SHA256SUMS` against `keys/tabkyra-release.pub`, checks that the signed comment names the version, checks the zip's SHA-256, and unpacks into staging with path, symlink and size checks. It swaps the release in with renames under a lock, keeps the previous release for `--rollback`, re-registers the native host, and tells you to reload. `--check` (exit 100 when an update exists, `--json`), `--channel stable|nightly`, `--auto-check on|off`. Docs: `docs/updates.md`.
- Side panel "Update available" notice, fed by the native host's daily check. It never installs anything.
- `.github/workflows/release.yml`: on a version tag, builds against the pinned siblings, runs the checks, packages (`scripts/release/package.mjs`), signs with minisign from the `MINISIGN_SECRET_KEY` secret, and attaches the zip, `SHA256SUMS` and `SHA256SUMS.minisig`.
- README rewritten around `tabkyra setup`, with a demo recorded from a real headless run (`scripts/demo/capture.mjs` writes `media/demo.gif` and `media/demo-steps.png`), harness snippets, the safety model, a diagram, an FAQ and credits naming 0xSero's and Mario Zechner's contributions.
- New Tabkyra site (`site/`): the brand, the same quick start, the demo, safety, how it works and credits. Built, not deployed.
- MCP `status` tool (and bridge method): connection, permission mode, allowed sites, the session's tab group and tabs. It never fails; when nothing is connected it says how to fix it.
- `tabkyra status --json`; `tabkyra --help` grouped into Get started, Agents, Sites and Troubleshoot.
- Tabkyra brand: an original helm mark (`media/brand/`, generated by `media/brand/build.mjs`), extension icons at 16/32/48/128 px, palette and type in `media/brand/BRAND.md`. The side panel header, welcome screen, setup dialog and About screen use it; About credits 0xSero and Mario Zechner by contribution.
- `tabkyra setup`: builds the extension if needed, registers the native host for every Chromium browser, shows the one manual browser step with the exact folder, waits for the extension to connect, and offers to add the MCP server to Claude Code and Codex (by absolute path) or prints the config for OpenCode, Cursor and OMP. `--yes` runs it unattended.
- `tabkyra doctor [--json]`: checks Node, the build against the CLI, each browser's host manifest (name, path, `allowed_origins`), the live connection, "Allow user scripts", and each detected harness; prints one fix per failure and exits 1 on any.
- `actions` bridge method and MCP tool: up to 40 input steps (press, click, drag, type, hover, scroll, wait) in one call with an optional closing screenshot. A canvas flowchart (two shapes, labels, bound arrow) is one call instead of 60 to 120 model turns.
- `sitegeist debug` lists the active tab per window and records foreground-guard decisions; `bridge.activate` puts a tab back in front (dev aid after a focus mishap).
- `tabs.context` flags tabs that sit outside the session's group (`inGroup: false`).
- `scripts/bench/`: omp-driven workflow benchmark (drawing in Excalidraw/tldraw sandboxes, multi-tab research, form round trips) with trace stats, post-run inspection (tabs, group membership, app-state verification) and a per-task focus-steal check; `scripts/probe/` for raw bridge calls.
- Browser sessions: every chat owns its own tab group and works in the background. Tabs open inactive, tools act on the session's current tab, and the agent never sees the user's other tabs. The tab the side panel is opened on becomes the session's first tab (the group appears immediately); a "share this tab" button hands over further tabs; `navigate { showTab }` is the only way the agent brings a tab forward.
- Screenshots and trusted input events go through `chrome.debugger` (works on hidden tabs; focus emulation keeps requestAnimationFrame and lazy loading alive off-screen).
- Foreground guard: popups opened by agent tabs no longer steal focus.
- Dynamic model discovery: provider model lists are fetched at runtime (Anthropic, OpenAI, Gemini, OpenRouter, Mistral, Groq, xAI, Cerebras, Hugging Face), enriched from the generated table and models.dev, cached in IndexedDB.
- Bridge for external agents: `cli/` ships the `sitegeist` command (`sitegeist mcp`, `install`, `status`, `allow`, `reload`, `debug`, `pi-extension`). Harnesses reach the browser through a native messaging host and a user-only unix socket; each harness gets its own tab group. Settings > Bridge controls site permissions.

### Changed
- `tabkyra setup` and `tabkyra skill install` now install every bundled skill, not only `tabkyra`. A skill of the same name that Tabkyra didn't write is still left alone; `--force` replaces only the skills named on the command line (or `tabkyra` when none are).
- Settings > API Keys and the welcome dialog no longer explain the removed subscription sign-ins; `docs/auth-policy.md` and the README still do.
- `tabkyra yolo` is now `tabkyra allow-all` (`yolo` still works and is no longer listed).
- Every MCP tool has a title, a description written for choosing between tools, parameter docs and an example. The server instructions state the safety rules: page text is untrusted data, and the agent asks before acting under the user's sign-in.
- With no browser reachable, tool calls fail at once with one message ("Tabkyra isn't connected. Ask the user to ...") instead of retrying for 40 s. A bridge that dropped after working is still retried.
- CLI errors name the next step; usage errors exit 2.
- `npm run build` skips the version bump when `TABKYRA_NO_BUMP=1`, so `tabkyra setup` never edits the checkout.
- `navigate` gained `showTab` and `closeTab`; `switchToTab` no longer focuses the tab.
- Composer: ArrowUp in an empty composer recalls the last prompt; the model picker is a plain model-id button and the send button is an arrow (pi-web-ui `MessageEditor`/`AgentInterface`, see README). The provider/auth label was removed from the header.
- Browser sessions persist in `chrome.storage.local` (they and their groups survive extension reloads), grouping retries when Chromium refuses a tab edit, and the panel adopts the tab it opens on even when that is a New Tab page.
- Side panel is bound to a tab, not a window (Claude-in-Chrome model): each task lives on the tab its panel was opened on via `sidepanel.html?tabId=<tab>`, and the manifest declares no default panel, so a tab shows the panel only when a task owns it. Two tasks = two tabs, each with its own panel; put them in two windows to see both at once. The window-session lock and the "locked" landing page are gone; `src/utils/port.ts` is now lifecycle-only. While a task is mid-run its panel stays on the window's active tab so switching tabs doesn't tear the agent down.
- Removed upstream working notes from the repository root (`db.md`, `gmail.md`, `plan.md`).

### Fixed
- The empty-chat welcome screen now renders. `appendMessage` emits no event, so the chat never redrew to show it.
- Settings tabs no longer wrap to several lines in a narrow side panel; the tab row scrolls (pi-web-ui `SettingsDialog`, in `patches/pi-mono.patch`).
- Hidden agent tabs render at a fixed 1280x800 viewport (CDP device-metrics override, dropped while the user looks at the tab and restored when the agent acts on it again), so screenshot pixels, DOM coordinates and click coordinates are the same numbers in every window; models mixed the two scales on wide windows and clicked the wrong spots.
- `actions` spaces steps by `settleMs` (default 80 ms) so a keystroke after Enter is not lost while the app opens its text editor, and accepts `key`, `text`, `doubleClick`, `move`, `sleep` and mid-list `screenshot` steps.
- Screenshot coordinates: x/y for click, drag, hover and scroll are pixels of the tab's latest screenshot and are mapped to the page in the extension (models no longer multiply by a scale factor, which they got wrong); default screenshots are CSS-pixel scale up to 1280 px wide (the DPR was double-counted before).
- `drag` reports the held button on moves (`buttons: 1`) and moves in 12 steps, so pointer-driven canvas apps register the drag.
- Popups from `target=_blank` links (noopener, no `openerTabId`) are adopted via `webNavigation.onCreatedNavigationTarget`; the guard restores the tab the user was on right before the popup, and tabs Chrome drops into an agent's group become that agent's.
- `navigate` reports `loading: true` only when the wait timed out, not whenever subresources are still loading (models spent a turn waiting after every navigation).
- Screenshots of background tabs took 30 to 75 s and could stall the bridge: captures are now scaled inside the renderer (`clip.scale`) as JPEG with `optimizeForSpeed`, and bounded at 20 s with an actionable error. Bridge screenshots default to 1024 px JPEG.
- Empty tabs: tools no longer open an `about:blank` tab when a session has none (they tell the model to navigate first); the first `navigate` opens the tab straight on its URL, and `newTab` / `tabs.create` no longer load the URL twice. Abandoned bridge sessions have their blank tabs closed.
- Tab groups: a new session could take over another agent's group whose title matched (all `mcp` clients shared one group); groups now belong to one session, labels are made unique (`omp`, `omp 2`), stray tabs are regrouped, tabs in another window are moved to the group's window, and a group that refuses a tab is replaced instead of leaving the tab loose. A tab belongs to exactly one session.
- Disconnections: `sitegeist mcp` always uses a stable session key, so reconnects keep their tabs, and the CLI client retries a call once after an extension reload, service-worker restart or host respawn (waiting up to 40 s for the bridge to come back).
- Stale sessions: the session table (130+ dead records here) is pruned on worker start and every 5 minutes; idle abandoned agent groups are collapsed.
- Navigation: waits start at commit (a load still finishing from the previous page no longer satisfies them), hash and pushState navigations return immediately instead of waiting out the timeout, network errors are reported (`net::ERR_NAME_NOT_RESOLVED`), and results say `loading: true` when the page is still loading. Prerendered pages that swap tab ids keep their session.
- Side panel: clicking the toolbar icon on a tab that already shows a panel (including a running task's panel kept up on another tab) opens it instead of re-pointing it, which reloaded the panel and killed the running agent; opening the panel on a tab an external agent is driving no longer steals that tab; the busy state names the running task, so the right panel is kept up; re-opening a session no longer yanks the agent back to its home tab.
- Foreground guard: a link the user opens from a tab they are looking at is no longer pulled back out of view.
- Custom OpenAI-compatible providers (Local Studio, vLLM, SGLang) no longer send `max_tokens` (the dialog default of 8192 cut thinking models off mid-answer); discovery reads `max_model_len` as the context window. Requires pi-ai's new `compat.omitMaxTokens`.
- MCP token use: `read_page` and `find` return one line per element instead of pretty JSON (roughly a quarter of the tokens), `read_page` text defaults to 3000 characters, snapshots list in-viewport elements first so long pages are not cut above the fold, and tool descriptions spell out the tab-group workflow.
- The side panel no longer requires the "Allow User Scripts" toggle: page injection (`browserjs()`, overlay, element picker, image extraction) runs through `userScripts` when available and through the debugger's `Runtime.evaluate` otherwise, with a CDP-binding shim standing in for `chrome.runtime.sendMessage` (`src/browser/inject.ts`). `userScripts` moved to `optional_permissions`.
- Type errors in `CustomProviderEditDialog` (missing i18n keys) and `CustomProvidersTab` (`remove` shadowed `HTMLElement.remove`).
- Manifest: fixed extension `key` (stable id `kenehmggpggpiolepbjojeenmeapgfoc`, checked by the e2e test), new permissions `tabGroups`, `nativeMessaging`, `alarms`.

### Removed
- Subscription sign-in for ChatGPT, GitHub Copilot and Google Gemini (and the bundled pi-ai code for them, Antigravity and Claude Code identity headers). Each posed as another app (Codex CLI, VS Code Copilot Chat, Gemini CLI, Claude Code), which the providers forbid. Tabkyra takes API keys only, says the provider bills API use, and clears tokens the old sign-ins left. `docs/auth-policy.md` has the sources; `test/auth-policy.test.mjs` fails if any of it comes back.
- `.github/workflows/build.yml` (the Sitegeist release job that built against unpinned upstream siblings and published unsigned `sitegeist.zip`).
- Sitegeist's site content (orb, testimonials, preview videos, install page) and `site/run.sh deploy`'s upstream server target; deploy now refuses until Tabkyra has hosting.
- The Sitegeist orb (three.js) and its icon generator page; the `three` dependency went with them.

## [1.0.0] - 2026-03-15

### Added

- Browser-based OAuth login for Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT Plus/Pro), GitHub Copilot, and Google Gemini CLI
- Combined "API Keys & OAuth" settings tab with subscription login and API key entry
- Welcome setup dialog on first launch when no providers are configured
- Auto-select default model for the first provider with a key
- Provider and auth type indicator in the header bar
- Image extraction tool (`extract_image`) with selector and screenshot modes
- Subsequence-based fuzzy search in the model selector
- CORS proxy warning in OAuth sections (orange when enabled, red when disabled)
- GitHub Actions workflow for tagged releases
- `release.sh` script for version bumping and tagged releases

### Changed

- Default model changed to `claude-sonnet-4-6` with `medium` thinking level
- CORS proxy enabled by default
- Model selector only shows models from providers with configured keys
- API key prompt dialog now shows both OAuth login and API key entry for supported providers
- Tool execution set to sequential mode (parallel caused rendering issues in sidebar)
- Site converted to static (removed backend, admin, waitlist signups)
- Download links point to GitHub Releases
- License changed from MIT to AGPL-3.0

### Fixed

- Settings dialog tabs not responding to clicks (upstream `pi-web-ui` built with `tsgo` broke Lit decorator reactivity)
- CORS proxy toggle not updating (same root cause)
- Proxy not applied to API requests (esbuild bundled duplicate `streamSimple` references, breaking identity check)
- Model selector button not updating after picking a model (added `state_change` event to Agent)
- Duplicate tool component rendering during streaming (cleared streaming container on `message_end`)
- Screenshot tool capturing sidepanel instead of the webpage
