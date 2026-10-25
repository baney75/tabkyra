<p align="center">
  <img src="media/brand/hero.png" alt="Tabkyra: you steer, your agents work the tabs" width="720">
</p>

# Tabkyra

An AI agent in your browser's side panel, and a browser your coding agents can use.
Claude Code, Codex, OpenCode or any MCP client drives tabs in its own tab group in the
background while you keep working in yours. Bring your own API key or sign in with
ChatGPT, GitHub Copilot or Google Gemini. Nothing is collected or tracked.

## Quick start (60 seconds)

1. **Build** (once): `./scripts/setup-siblings.sh && npm run build`, which makes `dist-chrome/`.
2. **Load it** in Helium or Chrome: open `chrome://extensions`, turn on Developer mode,
   click **Load unpacked** and pick `dist-chrome/`. The id is always
   `kenehmggpggpiolepbjojeenmeapgfoc` (fixed by the manifest `key`).
3. **Install the CLI and the native host:**

   ```bash
   (cd cli && npm link)      # puts `tabkyra` (and the old `sitegeist` alias) on PATH
   tabkyra install           # registers ai.tabkyra.bridge for Helium, Chrome, Chromium, Edge, Brave, ...
   ```

   Reload the extension once, then `tabkyra status` lists which browsers have the host
   and whether the extension is connected.
4. **Connect your agent:**

   ```bash
   claude mcp add tabkyra -- tabkyra mcp
   ```

   Codex (`~/.codex/config.toml`):

   ```toml
   [mcp_servers.tabkyra]
   command = "tabkyra"
   args = ["mcp"]
   ```

   OpenCode, OMP or any other MCP client: a stdio server with command `tabkyra`, args `["mcp"]`.

For the side panel itself, press `Cmd+Shift+S` / `Ctrl+Shift+S` and add a provider.
Requires Chromium 141 or newer.

## Safety model

- **Nothing listens on the network.** The browser spawns the native host; the host owns a
  socket in `/tmp/tabkyra-bridge-<user>/` (0700 directory, 0600 socket) and only relays
  frames. The client refuses sockets and directories another user owns.
- **Only this extension can reach the host.** The host manifest's `allowed_origins` names
  the one fixed extension id.
- **Agents work in their own tab group** ("Tabkyra · claude", ...). Tabs open in the
  background and agents cannot see your other tabs. `tabs_show` is the only tool that
  changes what you see, and popups from agent tabs do not steal focus.
- **Site permissions.** By default an agent must ask before it opens a new site. Claude
  Code and Codex show the prompt inline; otherwise answer it in the side panel under
  Settings > Bridge or run `tabkyra allow <host>`. `tabkyra allow-all` allows any site and
  `tabkyra ask` turns prompting back on.
- **No Claude subscription login.** Anthropic does not allow Claude Pro/Max subscriptions
  in third-party apps, so Tabkyra takes Anthropic API keys only.

More: `cli/README.md` (commands, environment variables, MCP tools) and
`docs/agent-bridge-design.md` (protocol and design).

## Development

Clone this repo plus its sibling dependencies into the same parent directory:

```
parent/
  mini-lit/          # https://github.com/badlogic/mini-lit
  pi-mono/           # https://github.com/badlogic/pi-mono
  tabkyra/           # this repo
```

Check out pi-mono at the pinned commit, apply `patches/pi-mono.patch` (model registration,
composer history and slash commands, thinking level in the model picker), build the sibling
declarations and install everything:

```bash
./scripts/setup-siblings.sh
```

`./dev.sh` starts the watchers for mini-lit, pi-mono, the extension and the site.

Rebuild the extension and reload it from the terminal:

```bash
npm run build && tabkyra reload
```

Note: a production build bumps the version in `static/manifest.chrome.json`.

## Checks

```bash
./check.sh        # biome + tsc for the extension and the site
(cd cli && npm run check && npm test)   # CLI typecheck, build, installer test
(cd cli && npm run test:e2e)            # extension + host + MCP in a throwaway headless Chromium
                                        # (first time: cd cli && npx playwright-core install chromium)
```

The Husky pre-commit hook runs `./check.sh`.

## Credits

Tabkyra is a fork of [Sitegeist](https://github.com/badlogic/sitegeist) by Mario Zechner
(badlogic), via [0xSero's fork](https://github.com/0xSero/sitegeist), which added the
agent bridge, background tab groups, per-tab panels and runtime model discovery
(details in `docs/fork-changes.md`). Licensed AGPL-3.0, like upstream. See [LICENSE](LICENSE).
