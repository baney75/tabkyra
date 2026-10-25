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
