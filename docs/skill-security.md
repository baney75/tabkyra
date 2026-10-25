# Skill security

A skill is text an agent follows with the user's sign-in. A bad skill is a prompt
injection that never expires: it runs in every session that loads it. This document is
the threat model for skills and the gates every skill passes.

## What a lint can and can't do

No text filter makes prompt injection impossible. Language models follow instructions
wherever they appear, and an attacker can always phrase an instruction a pattern has
never seen. Tabkyra makes injection hard to land and cheap to catch by layering
these defenses:

1. **Skills ship only through review.** Bundled skills live in `skills/`, are compiled
   into the CLI, and change only through a pull request. CODEOWNERS requires a
   maintainer's review for `skills/`, the lint and CI.
2. **Every skill passes `tabkyra skill lint`,** in CI, in `tabkyra skill apply` (the only
   way `rsi` changes a skill), at install time for local edits, and on demand. The lint has no allowlist and no per-file exceptions.
3. **Red-team tests prove the lint still catches each attack** (`cli/test/skill-lint.test.mjs`).
   Weakening a rule turns CI red.
4. **Skills hold Markdown only.** Scripts and binaries are refused, so a skill can't carry
   code that bypasses review.
5. **Agents never see secrets.** The `proton-pass` skill routes credentials through the
   password manager's own injection (`pass-cli run`, `op run`, `bws run`). A model that
   holds only `pass://` references has nothing to leak.
6. **Page text is data.** The MCP server's instructions and every skill say so, and the
   `rsi` loop refuses lessons copied from page text, so an attack on one page can't
   become a skill edit.
7. **Actions under the user's sign-in need the user's yes,** and site access is
   allowlisted per host (README, Safety model).

## The lint rules

| Rule | Catches |
| --- | --- |
| `hidden-text` | Invisible format characters, bidi overrides, Unicode tag characters, filler characters, carriage returns, lookalike letters mixing scripts, HTML comments and any HTML tag outside code |
| `override-instructions` | "Ignore/disregard ... previous/system instructions" |
| `role-hijack` | Fake `system:`, `developer:` or `user:` turns, role tags, "you are now", "developer mode" |
| `conceal-from-user` | "Without telling the user", "without asking", "don't tell the user", "secretly", "quietly", "silently" |
| `remote-code` | Downloads or decoded data piped, substituted (`$(curl ...)`, `<(curl ...)`) or `eval`ed into a shell or interpreter; `iex (irm ...)`; `npx ...@latest` |
| `remote-instructions` | Following instructions fetched from a URL at run time |
| `secret-exfiltration` | Printing, posting or returning passwords, keys, tokens, cookies, card numbers |
| `credential-files` | Reading `~/.ssh`, `~/.aws`, `.env`, browser cookie and login stores, keychain dumps |
| `config-tamper` | Writing agent settings, hooks, MCP config, shell startup files, cron, launch agents |
| `safety-bypass` | `--dangerously-*`, `--no-verify`, `tabkyra allow-all`, disabling prompts or sandboxes |
| `encoded-blob` | Base64 or similar strings of 100+ characters |
| `remote-image` | Any image that isn't a relative path inside the skill, including reference-style images |
| `suspicious-link` | Plain http, raw IPs, link shorteners, punycode, protocol-relative `//host`, `data:`/`javascript:`/`file:` URLs, credentials in URLs |
| `structure` | Missing `## When to use`, numbered `## Steps`, `## Done when`; an unclosed fence; text on a fence line |
| `frontmatter` | Any line that isn't `key: value` for `name`, `description` or `license`; quoted values; duplicates; a name not matching its folder; a missing "Use when" |
| `file-type` | Anything in a skill folder besides `SKILL.md`, `references/*.md` and a license; any symbolic link |

Rules that name a dangerous act (`secret-exfiltration`, `remote-code`, `credential-files`,
`config-tamper`, `safety-bypass`, `remote-instructions`) allow a clause that starts by
forbidding it: "Never print the password", "Don't read ~/.ssh". Only "never", "don't",
"do not", "must not" and "refuse to" count, only at the start of the clause that holds
the match, and every match on the line must be forbidden. Clauses end at punctuation and
at "but", "then", "if", "when", "unless", "otherwise" and "instead".

Every line is checked, including fence lines and code blocks. A model reads the raw file,
so a fence doesn't change what it will follow. Skills describe attacks; they never quote
them. Frontmatter is parsed strictly: one `key: value` per line, allowed keys only, no
quotes, no YAML syntax, no duplicates.

## Local edits

`tabkyra skill apply <folder>` is the only way the `rsi` loop changes a skill. It lints
the draft, refuses edits to `rsi` and `kyraskillmaker`, refuses an edit that drops a
section, backs up the current version to `~/.config/tabkyra/skill-history/`, keeps the edit
in `~/.config/tabkyra/skills-local/` and installs it. `tabkyra skill install` keeps using
the edit while it passes lint, and warns when the bundled skill has changed since the edit
was based on it. `tabkyra skill revert <name>` returns to the bundled text. By default the
`rsi` loop shows the user each diff first. It applies a change on its own only when the
user has turned on both adversarial review and auto-apply, and the reviewer approved.

## Limits

- CODEOWNERS asks for a maintainer's review on the paths that control skills. It blocks a
  merge only if branch protection requires code-owner review.
- The skills CI job also lints with the base branch's lint whenever the base has one. A
  pull request that weakens the lint must still pass the old lint with its own skills.

## Sources studied

The bundled skills were written for Tabkyra, not forked. These were read for
coverage and rejected as fork bases for the reasons given:

| Source | Why it wasn't forked |
| --- | --- |
| smixs/osint-skill (MIT) | Uses paid scrapers to get around captchas and login walls; profiles private people |
| Imbad0202/academic-research-skills | CC BY-NC 4.0, not compatible with AGPL-3.0 |
| bitwarden/agent-access examples | Returns the password to the agent; install fetches the skill at run time |
| NousResearch hermes-agent 1password skill | Stores a service token in a dotfile; examples print secrets |
| uditgoenka/autoresearch (MIT) | Sends optional outbound webhooks; ML-specific loop |
| snyk/agent-scan (Apache-2.0) | Sends skill content to a remote API; Tabkyra's gate runs offline |

Note for anyone adding a Bitwarden route: `@bitwarden/cli` 2026.4.0 on npm carried a
credential stealer (StepSecurity, 2026-04-23). Pin a known-good version.
