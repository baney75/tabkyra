# DC-2 and DC-9 records

## 2026-10-25: scoped tokens and loopback HTTP (narrow checks, not the DC Checks)

Command: `cd cli && npm run build && node --test test/remote.test.mjs`
Result: 6 pass, 0 fail.

What each test could fail on:

- Token creation with no scope, "*", "all", "browser.*" or an unknown scope must exit 2,
  and tokens.json must not contain the secret.
- A request with no token, a fake token, or a raw POST gets 401.
- A `library.read` token's session lists exactly library_cite and library_search; a call to
  `click` errors; `library_search` succeeds.
- Another token on an existing session id gets 403. After `token revoke`, the old session
  is refused, and `token list` shows it revoked.
- `tunnel tailscale` calls `tailscale serve --bg --yes --https=443 --set-path=/tabkyra
  http://127.0.0.1:8787`; `--public` calls `funnel`; `--off` turns it off (stub binary
  records the arguments).
- `tunnel cloudflare` without cloudflared exits 1 and starts nothing.

## Not yet run

- DC-2 Check: CLI and MCP parity on every command.
- DC-9 Check: a cloud agent reaching MCP through a real Tailscale and a real Cloudflare
  tunnel with a token, and being refused without one. This changes the owner's tailnet
  serve config and needs `cloudflared`, so it waits for a run he starts.
