<p align="center">
  <img src="media/brand/hero.png" alt="Tabkyra: you steer, your agents work the tabs" width="760">
</p>

<p align="center">
  <b>Let Claude Code, Codex or any MCP agent drive your real browser, in its own tab group, while you keep working.</b>
</p>

<p align="center">
  Built on <a href="https://github.com/0xSero/sitegeist">0xSero's agent bridge</a> and
  <a href="https://github.com/badlogic/sitegeist">Mario Zechner's Sitegeist</a>.
  <a href="#credits">Credits</a> · <a href="LICENSE">AGPL-3.0</a>
</p>

---

Tabkyra is a Chromium extension and a small CLI. Your coding agent gets a browser that is
already signed in where you are signed in. It works in background tabs it owns, and it
asks before it opens a site you haven't allowed. The extension also has its own side panel
agent for when you want to chat with a page directly.

*Tabkyra* is *tab* plus *kyra*, from Greek *kybernētēs*, "helmsman". You steer, and it
works the tabs.

**Credit where it's due.** The agent bridge is the work of **[0xSero](https://github.com/0xSero)**
([0xSero/sitegeist](https://github.com/0xSero/sitegeist)). That covers the native
messaging bridge, the CLI and MCP server, agent tab groups, per-tab side panels and the
foreground guard that keeps agent popups from stealing focus. The extension itself is
**[Mario Zechner](https://github.com/badlogic)**'s
[Sitegeist](https://github.com/badlogic/sitegeist), built on his
[pi](https://github.com/badlogic/pi-mono) agent libraries. Tabkyra packages their work
with one-command setup, a doctor and a new brand.

## 60 seconds to your first agent-driven tab

You need Node 20+, git, and a Chromium 141+ browser such as Helium, Chrome or Brave (see
[Which browsers?](#faq) for what has been tested).

```bash
mkdir tabkyra-src && cd tabkyra-src        # setup puts two build dependencies beside the clone
git clone https://github.com/baney75/tabkyra && cd tabkyra
(cd cli && npm install && npm run build && npm link)
tabkyra setup
```

If `npm link` fails with a permissions error, skip it and run `node cli/dist/index.js setup`.

The first build clones [pi-mono](https://github.com/badlogic/pi-mono) (pinned and patched)
and [mini-lit](https://github.com/badlogic/mini-lit) next to the `tabkyra` folder, which is
why the clone goes in a folder of its own.

On a Mac with a warm npm cache, a fresh clone reached "Connected" in 45 seconds with
`tabkyra setup --yes`. A first install with a cold cache downloads more and can take a few
minutes.

`tabkyra setup` builds the extension, registers the native host with every Chromium
browser it finds, and offers to add Tabkyra to Claude Code and Codex. For OpenCode,
Cursor and OMP it prints the config block to paste. Then it shows the one step the
browser makes you do by hand:

```
╭─ One step in your browser ─────────────────────────────────────╮
│ 1  Open chrome://extensions, turn on Developer mode,           │
│    and click Load unpacked.                                    │
│ 2  Pick this folder:                                           │
│    /path/to/tabkyra/dist-chrome                                │
│ 3  Optional: click Details on Tabkyra and turn on              │
│    Allow user scripts (faster page scripts).                   │
╰────────────────────────────────────────────────────────────────╯
  ✓ Connected. Tabkyra can reach your browser (1.1.8).
```

Then ask your agent something like:

> Use tabkyra to open news.ycombinator.com and list the top five stories.

If anything is off, `tabkyra doctor` checks each piece and prints the exact command
that fixes it. For the side panel agent, press `Cmd+Shift+S` (`Ctrl+Shift+S`) and add a
provider.

<p align="center">
  <img src="media/demo.gif" alt="A scripted MCP client searches a library catalog, places a hold and reads the confirmation through Tabkyra's tools" width="860">
  <br><sub>Recorded headless by <code>scripts/demo/capture.mjs</code>: a scripted MCP client drives the real stack (MCP server, native host, extension).
  The local site was allowed first with <code>tabkyra allow</code>. The page in each frame is the client's own <code>screenshot</code>, framed for display. <a href="media/demo-steps.png">Still frames</a>.</sub>
</p>

## Connect your agent

`tabkyra setup` does this for you and prints the exact paths for your machine.
`tabkyra install` writes a launcher at `~/.config/tabkyra/tabkyra` that pins Node by
absolute path, so an agent started from a GUI app doesn't need `node` on its PATH. Point
your harness at it (JSON configs need the full path, not `~`):

**Claude Code**

```bash
claude mcp add --scope user tabkyra -- ~/.config/tabkyra/tabkyra mcp
```

**Codex**

```bash
codex mcp add tabkyra -- ~/.config/tabkyra/tabkyra mcp
```

**OpenCode** (`~/.config/opencode/opencode.json`)

```json
{ "mcp": { "tabkyra": { "type": "local", "command": ["/Users/you/.config/tabkyra/tabkyra", "mcp"], "enabled": true } } }
```

**Cursor** (`~/.cursor/mcp.json`)

```json
{ "mcpServers": { "tabkyra": { "command": "/Users/you/.config/tabkyra/tabkyra", "args": ["mcp"] } } }
```

**OMP** (`~/.omp/agent/mcp.json`)

```json
{ "mcpServers": { "tabkyra": { "type": "stdio", "command": "/Users/you/.config/tabkyra/tabkyra", "args": ["mcp"], "enabled": true } } }
```

**pi** has no MCP client, so `tabkyra pi-extension` writes a native pi extension instead.

Any other MCP client can run the stdio server with `~/.config/tabkyra/tabkyra mcp`.

### Teach your agent

```bash
tabkyra skill install            # Claude Code, Codex and OpenCode, wherever they're installed
tabkyra skill print >> AGENTS.md # any other agent, as a section of a project's AGENTS.md
```

Or open the side panel's Settings > Bridge and click **Copy setup prompt for your agent**.
Paste it into Claude Code, Codex, pi, OMP or any agent with a shell, and the agent installs
the CLI, connects itself and installs the skills.

The skill ([skills/tabkyra/SKILL.md](skills/tabkyra/SKILL.md)) is short and written for small
models. It covers when to use Tabkyra, `status` first, then the loop: navigate, `read_page`
for refs, act by ref, read back. It also covers stale refs, waits, dialogs, the safety rules,
cleanup and three worked examples. A test keeps it in step with the MCP server's
instructions and tool schemas. `tabkyra setup` offers to install it.

### Skills

`tabkyra skill install` installs every bundled skill; `tabkyra skill list` shows them.

| Skill | What it does |
| --- | --- |
| `tabkyra` | The browser loop, dialogs, safety rules and cleanup |
| `academic-research` | Find papers, verify each DOI, metadata and retraction status, save BibTeX and Obsidian notes |
| `osint` | Public-record research on companies, domains and people, with a purpose check |
| `news-research` | Primary sources, wire services, more than one side, every statement labeled |
| `dorks` | Search operators and recipes for Google, Bing, DuckDuckGo, GitHub and Scholar |
| `autoresearch` | `/autoresearch`: a research loop with sub-questions, a budget and a stop rule |
| `rsi` | `/rsi`: turn lessons from real work into small, linted, reviewed skill edits |
| `artifacts` | Self-contained HTML reports, checked in the browser before hand-off |
| `proton-pass` | Credentials through Proton Pass, 1Password or Bitwarden, never through the model |
| `kyraskillmaker` | Write a skill to Tabkyra's standard |

Every skill passes `tabkyra skill lint`, which CI runs on every pull request. It refuses
hidden text, instruction overrides, piped remote code, secret handling and config
tampering, and it requires the structure a small model needs. The threat model and every
rule are in [docs/skill-security.md](docs/skill-security.md).

### Library

A local source library in the spirit of Zotero. Every source is fetched from its DOI's
registry and checked against OpenAlex and Crossref's retraction notices before it's saved. When a
check can't finish, the source is saved marked "retraction check incomplete" until `tabkyra library verify`
completes it.

```bash
tabkyra library add 10.1037/0033-2909.132.3.354 --quote "..." --location "p. 354"
tabkyra library cite cepeda2006distributed --style apa
tabkyra library export --format bibtex --out refs.bib   # or ris, csl: Zotero, Word, LaTeX
tabkyra library obsidian ~/Vault                         # one note per source in Sources/
```

Agents get the same through the `library_add`, `library_search` and `library_cite` MCP
tools. An unregistered DOI is refused, and a retracted source is flagged everywhere it
appears.

## What your agent can do

| Tools | |
| --- | --- |
| `status` | Is the browser connected, which sites are allowed, which tabs are mine |
| `navigate`, `tabs_context`, `tabs_create`, `tabs_select`, `tabs_close` | Open pages in its own background tabs |
| `read_page`, `find`, `get_page_text`, `get_page_html`, `screenshot` | Read a page as element refs and text, or look at it |
| `click`, `type`, `fill`, `press`, `hover`, `scroll`, `drag`, `actions` | Act with real input events, by ref or by screenshot pixel |
| `run_js`, `wait`, `read_console`, `read_network` | Scripts, waits and debugging |
| `handle_dialog` | Answer an alert, confirm or prompt box. While one is open, other calls fail at once with its text |
| `tabs_show` | Bring a tab in front of you, when you need to sign in or see it |

Every tool's description documents its parameters and includes an example.

## Safety model

Your browser is signed in as you, so the defaults are conservative.

- **The agent asks before it opens a new site.** Claude Code and Codex show the prompt
  inline; otherwise answer it in the side panel under Settings > Bridge. Run
  `tabkyra allow <host>` to pre-approve a site, `tabkyra allow-all` to skip prompts and
  `tabkyra ask` to turn them back on.
- **Page text is data, not instructions.** The MCP server tells every agent that page
  content is untrusted and that it must ask you before acting under your sign-in:
  sending, posting, buying, deleting or changing settings. It also tells the agent never
  to type passwords or payment details. For a sign-in or a captcha, it brings the tab to
  you. These are instructions to the model, not enforcement: a hostile page can still
  attempt prompt injection. The site permission limits which sites an agent can open.
  It doesn't limit what the agent does on a site you've allowed, including running
  scripts there with `run_js`. Allow only sites you'd let the agent act on, and for
  high-stakes accounts, run agents in a separate browser profile that isn't signed in.
- **Agents stay in their own tab group** ("Tabkyra · claude", "Tabkyra · codex"). Their
  tabs open in the background, they can't see your other tabs, and popups from their
  tabs don't steal focus. `tabs_show` is the only tool that changes what you see.
- **Nothing listens on the network.** The browser starts the native host, which relays
  frames over a Unix socket in `/tmp/tabkyra-bridge-<user>/` (0700 directory, 0600
  socket). Other users can't reach it, and the client refuses sockets another user owns.
  Any program running as you can, which is the same trust level as your shell.
- **Only this extension can make the browser start the host.** The host manifest's `allowed_origins`
  names one fixed extension id, `kenehmggpggpiolepbjojeenmeapgfoc`, derived from the
  manifest `key` (the e2e test checks it).
- **API keys only, no subscription sign-in.** The ChatGPT, GitHub Copilot and Gemini
  sign-ins this fork inherited worked by posing as Codex CLI, VS Code and Gemini CLI.
  Their terms forbid that, and accounts get suspended for it, so they're gone, along with
  Claude Pro/Max login. The side panel takes API keys, which each provider bills. The
  sources and dates are in [docs/auth-policy.md](docs/auth-policy.md).

- **Private mode** (Settings > Privacy) keeps the side panel agent to OpenRouter with zero
  data retention enforced per request, or to models on your own machine, your network, or
  hosts you list as yours.
- **Bug reports are off unless you turn them on,** and even then nothing leaves the browser:
  you review the redacted report in Tabkyra, copy it, and paste it into a GitHub issue.

## Updating

```sh
tabkyra update --check   # exit 0 up to date, 100 update available
tabkyra update           # download, verify the signature and checksum, swap in, keep the last version
tabkyra update --rollback
```

Releases are signed with minisign. The update refuses a bad signature, a signature made
for another version, or a wrong checksum, and leaves the installed copy as it was. The
side panel shows a quiet "Update available" line, but nothing updates without you. Use
`--channel nightly` for prereleases. Details, and the one-time key setup for releases, are
in [docs/updates.md](docs/updates.md).

## How it works

```mermaid
flowchart LR
  A["Your agent<br/>Claude Code, Codex, OpenCode, Cursor"] -- "MCP (stdio)" --> B["tabkyra mcp"]
  B -- "Unix socket<br/>user-only" --> C["Native host<br/>started by the browser"]
  C -- "Native messaging" --> D["Tabkyra extension"]
  D -- "chrome.debugger,<br/>tab groups" --> E["Background tabs<br/>Tabkyra · claude"]
  U(["You"]) -. "approve sites,<br/>watch, take over" .-> D
```

Each agent session gets its own tab group, and the session survives extension reloads,
so a harness that reconnects lands back on its own tabs. Screenshots and input go
through `chrome.debugger`, which works on hidden tabs, so the agent never needs your
window in front. Protocol and design notes are in
[`docs/agent-bridge-design.md`](docs/agent-bridge-design.md), and the CLI is documented in
[`cli/README.md`](cli/README.md).

## FAQ

**Is this the Chrome Web Store version?** No. Tabkyra loads unpacked from
`dist-chrome`, and `tabkyra setup` builds it for you. The fixed manifest key gives every
Chromium browser the same extension id.

**Does my agent see my other tabs?** No. It sees and controls only the tabs in its own
group.

**Can I watch it work?** Yes. Click its tab group, or have the agent call `tabs_show`.

**Why does my agent stop and ask about a site?** That's the permission prompt. Approve
it once or for good, or run `tabkyra allow <host>` ahead of time.

**It says "Tabkyra isn't connected."** The browser isn't running with the extension
loaded, or the extension hasn't reached the native host yet. `tabkyra doctor` says
which one.

**Which browsers?** Chromium 141 or newer. Tested: Chromium, headless, end to end (the e2e
test), and host registration for Helium and Chrome on macOS (the install test). Live
use in Helium or Chrome, and Brave, Edge, Arc, Vivaldi and Opera (registered the same way, on
macOS and Linux), haven't been tried yet. Windows registry entries are written but untested.

**Does it send my data anywhere?** Tabkyra itself collects nothing and has no server; the
bridge never leaves your machine. But whatever an agent reads through it (page text,
screenshots) goes to that agent's model provider, as with any tool the agent uses. The
side panel likewise talks to the provider you configure.

## Development

Clone this repo plus its sibling dependencies into the same parent directory:

```
parent/
  mini-lit/          # https://github.com/badlogic/mini-lit
  pi-mono/           # https://github.com/badlogic/pi-mono
  tabkyra/           # this repo
```

`./scripts/setup-siblings.sh` clones them, checks out pi-mono at the pinned commit,
applies `patches/pi-mono.patch`, builds the declarations and installs everything.
`./dev.sh` starts the watchers. Rebuild and reload from the terminal with
`npm run build && tabkyra reload`. A production build bumps the version in
`static/manifest.chrome.json`; `TABKYRA_NO_BUMP=1` skips that.

```bash
./check.sh                              # biome + tsc for the extension and the site
(cd cli && npm run check && npm test)   # CLI typecheck, build, setup/doctor/MCP tests
(cd cli && npm run test:e2e)            # extension + host + MCP in a throwaway headless Chromium
                                        # (first time: cd cli && npx playwright-core install chromium)
node media/brand/build.mjs              # regenerate icons and brand art from media/brand
node scripts/demo/capture.mjs           # re-record the README demo (needs ffmpeg and `cd site && npm install`)
```

The brand (mark, palette, type, voice) is documented in
[`media/brand/BRAND.md`](media/brand/BRAND.md).

## Credits

- **[0xSero](https://github.com/0xSero)**, [0xSero/sitegeist](https://github.com/0xSero/sitegeist):
  the agent bridge (native messaging host, Unix-socket client, MCP server and CLI), one
  tab group per agent session, background screenshots and input through
  `chrome.debugger`, per-tab side panels, the foreground guard, and runtime model
  discovery. Details are in [`docs/fork-changes.md`](docs/fork-changes.md).
- **[Mario Zechner](https://github.com/badlogic)**, [badlogic/sitegeist](https://github.com/badlogic/sitegeist):
  the original Sitegeist extension, its side panel agent and tools, and the
  [pi](https://github.com/badlogic/pi-mono) and [mini-lit](https://github.com/badlogic/mini-lit)
  libraries it runs on.
- **Tabkyra** ([baney75/tabkyra](https://github.com/baney75/tabkyra)): the name and brand,
  `tabkyra setup` and `doctor`, the Helium host registration, the MCP polish and the
  end-to-end test.

Licensed AGPL-3.0, like upstream. See [LICENSE](LICENSE).
