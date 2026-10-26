# Decisions

Conventional defaults chosen while implementing the Done Criteria (DC-1 to DC-14), and the
owner's answers to the questions that changed the outcome. Newest last. Each entry names
the criterion it serves.

## D1. Tabkyra skill metadata lives in `skill.toml`, not in SKILL.md frontmatter (DC-3)

DC-3 lists name, description, triggers, required tools, permissions, version and
provenance as frontmatter. Harnesses read SKILL.md frontmatter, and some act on keys they
recognize (Claude Code's `allowed-tools` pre-approves tools), so extra keys there are an
escalation route. SKILL.md keeps `name`, `description` and `license`, which every harness
reads the same way. The Tabkyra fields go in `skill.toml` in the same folder, which only
Tabkyra reads and the lint validates. The installer copies only SKILL.md into harness
folders. Same information, no new attack surface in the harness.

## D2. CAPTCHA handling (DC-10, DC-12)

Owner, 2026-10-25: allow solving for search, removing your own data from brokers (ghost),
and OSINT on companies and domains, "with the exception of exploitation like scalping".
Implementation default:

- Off by default. Turned on once at setup, behind a plain warning that solving breaks
  most sites' terms and can get an account or IP flagged. The setting then syncs to the
  user's other devices.
- Tabkyra ships no solver. When the setting is on, the agent may use a solver extension
  the user installed themselves (Buster), one challenge at a time at human pace.
- Allowed for search engines, the `ghost` skill and the `osint` skill's company and domain
  research. Never for buying, ticketing, account creation, posting, or any site the user
  hasn't allowed. People research hands the challenge to the user, as the owner's chosen
  option said.
- Everything else gets the DC-10 handoff: pause, notify, user solves, resume.
- CI fails any first-party skill that bundles a solver or calls a solving service.

## D3. People research scope (DC-12 osint)

The osint skill covers companies, domains, public figures, a person's professional
footprint, and genealogy of the user's own family or of people who consented. It does
not unmask anonymous accounts or people, and it doesn't compile a private person's home
address, phone, relatives or routine for someone else. These are the stalking and doxxing
uses the safety rules exist to stop, so the skill refuses them instead of gating them.

## D4. "ChatGPT Daybreak" (DC-14)

Owner, 2026-10-25: it is the Codex `daybreak` flag. It runs as an optional
second-opinion security reviewer through `codex exec` on the user's own sign-in, with
no API billing. Until Daybreak supports the review model, calls pass `-c daybreak=false`
for gpt-6.1-sol, as the existing field note documents.

## D5. Bug report transport (DC-13)

Owner, 2026-10-25: GitHub issues filed through the user's own `gh` sign-in on
baney75/tabkyra. Reports are de-duplicated by a fingerprint of the scrubbed error (an
open issue with the same fingerprint gets a comment instead of a new issue). Off by
default. Without `gh` signed in, the report falls back to the prefilled issue link the
user submits.

## D6. Personal and shared skills (owner note, DC-5)

Every skill has a category in `skill.toml`: `personal` or `shared`. `tabkyra` classifies
it automatically and the stricter answer wins. Anything matching personal data (emails,
phone numbers, street addresses, account or student IDs, home paths, names the user marks
as private, signed-in site data) makes it `personal`. Personal skills are never submitted,
pushed, uploaded to GitHub or put in the skill DB, in any form. They sync only to the
user's own devices, end-to-end encrypted. Submission refuses a personal skill outright;
it doesn't ask.

## D7. Clean-container check for the install prompt (DC-1)

Pasting the prompt into each harness needs that harness signed in and calling a model.
That uses the owner's sign-ins and, for some harnesses, metered API use, which is not
allowed without the owner. The default check runs the prompt's commands, unchanged, in a
fresh container per harness with that harness's binary installed. It checks harness
detection, skills folder, MCP config and `tabkyra doctor`. The model-in-the-loop
transcripts are recorded as blocked until the owner signs in a harness for the run.

## D8. Stacked pull requests

#13 (skills, lint, CI), #14 (library) and #15 (private mode, bug reports) are reviewed
and merged in order. Owner, 2026-10-25, answering whether to run a second review series
on #13 and then review and merge #14 and #15: "Yes, review and merge".

## D9. Remote MCP and tunnels (DC-2, DC-9)

`tabkyra serve` speaks MCP over Streamable HTTP and binds to loopback only; it refuses any
other address. Every request needs a bearer token from `tabkyra token create`. Tokens are
per client, stored as SHA-256 hashes, revocable at once, and limited to named scopes
(`browser.read`, `browser.navigate`, `browser.act`, `browser.script`, `library.read`,
`library.write`). There is no wildcard. A session sees only its scopes' tools, and another
token can't reuse it. The stdio server that a local harness runs keeps full access: it
runs as the user, so a token there would protect nothing. TLS comes from the tunnel:
`tabkyra tunnel tailscale` (tailnet only; `--public` uses Funnel and warns) or
`tabkyra tunnel cloudflare` (a quick tunnel under the user's own `cloudflared`).

## D10. Appearance customization and the contribution network (owner, 2026-10-25)

Users and their agents customize Tabkyra's look through a theme file: design tokens and
CSS custom properties as data, checked by a linter. A theme can't contain code, URLs or
selectors that hide controls. A modified build is still allowed (AGPL-3.0).

"Lose access to the contribution network if they tamper with the code" is enforced where
it can actually hold. The client can't prove it is unmodified: it is open source, so any
check inside it can be patched out or faked. So the network never trusts the client.

- Every contribution (skill fix, success or failure report, bug report) is signed with a
  per-install key and carries the build's hash. Builds whose hash isn't in the signed
  release manifest are labeled `unofficial build`. Their contributions go to a separate
  queue that is never auto-accepted.
- Every contribution, from any build, passes the same server-side gates: CI lint, the
  red-team suite, adversarial review, and a maintainer for sensitive scopes. Security
  rests on these gates, not on trusting the client.
- Abuse (repeated rejected or malicious submissions) revokes that install key.

## D11. Worldwide successes and failures (owner, 2026-10-25)

Off by default and opt-in at first run, next to bug reports. When on, a skill run's
outcome is scrubbed by the DC-7 scrubber and contributed. It includes the skill name and
version, the model class, pass or fail, the step that failed, and the fix if `/fix`
produced one. Personal skills (D6) and page content are never included. Outcomes reach
the shared library only through D10's gates, as proposed fixes. Raw data never edits a
skill directly.

## D12. Small-model context budget (owner direction; numbers set by Claude, 2026-10-25)

The owner asked that skills not bloat context, "especially for the super small models"
(2026-10-25). He set no number; the figures below are Claude's. Harnesses see only each skill's name and its one-line description. The full SKILL.md
loads when the skill is invoked. Each first-party skill stays under 150 lines and
8,000 characters (about 2,000 tokens; `BUDGET_LINES` and `BUDGET_CHARS` in
`cli/src/skill-lint.ts`). Claude first set 1,500 tokens and raised it the same
day, because every well-specified skill exceeded it; the owner hasn't ruled on the number. Enforced by the lint's `budget` rule, and longer material is
split into separate skills, not appendices. The
router (DC-3) picks at most one skill per task for small models. The `rsi` and `fix`
skills apply their edits with `tabkyra skill apply`, which runs the same lint, so an improvement can't bloat a skill past it (`fix` also aims for under 150 lines).

## D13. Local model providers (owner, 2026-10-25)

A "Local models" provider set in the side panel. It finds OpenAI-compatible servers
(Ollama :11434, LM Studio :1234, llama.cpp and vLLM :8080 and :8000) on this machine and on
the user's tailnet peers. The native host asks `tailscale status --json` for the peers and
probes each port with a short timeout. A model on a tailnet peer counts as local for
private mode only once the user lists it as their own (#15's rule in `src/privacy/private-mode.ts`: only loopback is trusted automatically).

## D14. Fix submissions and tier variants (owner, 2026-10-25)

`submit` in `~/.config/tabkyra/rsi.json` takes `"ask"` (default), `"auto"` or `"never"`.
The owner asked that users be able to submit fixes automatically, which overrides DC-5's
confirm-each-submission default for users who choose `"auto"`. Auto submission still only
opens a pull request: CI, adversarial review and a maintainer decide what enters the
library (D10). A skill classified personal (D6) is never submitted under any setting.
When a fix for a small model would weaken a skill that works for large ones, `/fix`
writes a `<name>-lite` skill instead of editing the original. The router (DC-3) picks the
variant by model tier.

## D15. Voice and mail skills (owner, 2026-10-25)

The writing-voice skill learns the user's style only from the user's own mail and
documents, read in place through their signed-in Tabkyra tabs or their Drive. It keeps
just a style profile (sentence length, word choice, openings, sign-offs, a few short
example lines), not the messages. The profile is a personal skill (D6): it stays on the
user's devices and is never submitted, synced to shared storage or put in a bug report.
Email organization reads freely, but creating labels, moving mail or changing filters acts
under the user's sign-in. It shows the plan and waits for the user's yes, per the safety
rules.

## D16. SDKs and vendor terms (owner, 2026-10-25: "we don't want to break ToS")

No user should risk a ban for using Tabkyra.

- **Harnesses the user runs** (Claude Code, Codex, pi, OMP, OpenCode, Cursor) connect to
  Tabkyra as an MCP server, a pi extension or skills. The user's own harness, signed in
  however its vendor allows, calls Tabkyra. Nothing is borrowed or impersonated, so this
  is the primary integration.
- **pi** (`@mariozechner/pi-ai`, `pi-agent-core`, `pi-web-ui`, MIT) already powers the side
  panel with API keys. OMP is integrated through MCP config.
- **Vendor agent SDKs** (Claude Agent SDK, Codex SDK) are used only with an API key the
  user supplies and pays for, never with a subscription sign-in inside Tabkyra. Products
  built on these SDKs are expected to use API keys, and reusing a consumer sign-in in
  another app is what got the old Sitegeist sign-ins removed (docs/auth-policy.md).
- `/fix` and `adversarial-review` run a stronger model by calling the user's own CLI
  (`claude -p`, `codex exec`) on their machine, the same way the user would.
