# tabkyra (CLI)

Bridge between coding harnesses and the Tabkyra browser extension. Any MCP client
(Claude Code, Codex, omp) and pi can drive a Chromium browser through it. Each harness
gets its own tab group and works in the background while you keep using your tabs.

```
harness ── stdio MCP ── tabkyra mcp ── unix socket ── native host ── native messaging ── extension
```

Nothing listens on the network. The browser spawns the native host; the host owns a
socket in `/tmp/tabkyra-bridge-<user>/` (0700 directory, 0600 socket) that only your
user can reach. The client refuses sockets and directories it does not own.

## Install

```bash
npm link                      # from this directory; puts tabkyra (and the sitegeist alias) on PATH
tabkyra install               # writes the native-messaging manifest for every Chromium browser found
```

`tabkyra mcp` runs the installer itself on first use, so a harness configured to start
it needs no extra step. Reload the extension once after the first install.

## Commands

| Command | Purpose |
| --- | --- |
| `tabkyra mcp` | stdio MCP server exposing the browser tools |
| `tabkyra install [--force]` | write the native host manifest (Helium, Chrome, Chromium, Brave, Edge, Arc, Vivaldi, Opera; Linux and Windows too) |
| `tabkyra status` | which browsers have the host manifest, is the extension connected |
| `tabkyra allow <host>` | let agents open a site without a prompt (subdomains included) |
| `tabkyra reload` | reload the extension (after rebuilding `dist-chrome`) |
| `tabkyra debug` | bridge state, recent request timings, Chrome API benchmark |
| `tabkyra pi-extension` | write `~/.pi/agent/extensions/tabkyra.ts` for pi |

## Harness setup

```bash
claude mcp add tabkyra -- tabkyra mcp
tabkyra pi-extension
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.tabkyra]
command = "tabkyra"
args = ["mcp"]
```

omp: add an MCP server entry that runs `tabkyra mcp`.

## Permissions

By default the extension asks before an agent opens a new site. MCP clients that support
elicitation (Claude Code, Codex) show the prompt inline; otherwise answer it in the
Tabkyra side panel under Settings > Bridge, run `tabkyra allow <host>`, or switch the
mode to "allow any site" there. pi: set `TABKYRA_AUTO_ALLOW=1` to auto-approve.

`TABKYRA_SESSION=<name>` makes a harness re-adopt the same tab group across restarts.
`TABKYRA_CLIENT_NAME` overrides the tab group label.

## MCP tools

`tabs_context`, `tabs_create`, `tabs_close`, `tabs_select`, `tabs_show`, `navigate`,
`screenshot`, `read_page`, `get_page_text`, `get_page_html`, `find`, `click`, `hover`,
`type`, `press`, `fill`, `scroll`, `drag`, `run_js`, `wait`, `read_console`,
`read_network`. `tabs_show` is the only tool that changes what the user sees.
