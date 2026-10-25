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
2. **Every skill passes `tabkyra skill lint`,** in CI, before `rsi` applies an edit, and
   on demand. The lint has no allowlist and no per-file exceptions.
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
| `hidden-text` | Invisible format characters, bidi overrides, Unicode tag characters, lookalike letters mixing scripts, HTML comments and raw HTML outside code fences |
| `override-instructions` | "Ignore/disregard ... previous/system instructions" |
| `role-hijack` | Fake `system:` or `developer:` turns, role tags, "you are now", "developer mode" |
| `conceal-from-user` | "Without telling the user", "secretly", "silently send" |
| `remote-code` | Downloads or decoded data piped into a shell or interpreter |
| `remote-instructions` | Following instructions fetched from a URL at run time |
| `secret-exfiltration` | Printing, posting or returning passwords, keys, tokens, cookies, card numbers |
| `credential-files` | Reading `~/.ssh`, `~/.aws`, `.env`, browser cookie and login stores, keychain dumps |
| `config-tamper` | Writing agent settings, hooks, MCP config, shell startup files, cron, launch agents |
| `safety-bypass` | `--dangerously-*`, `--no-verify`, `tabkyra allow-all`, disabling prompts or sandboxes |
| `encoded-blob` | Base64 or similar strings of 100+ characters |
| `remote-image` | Remote Markdown images, which leak data through their URLs |
| `suspicious-link` | Plain http, raw IPs, link shorteners, punycode, `data:`/`javascript:`/`file:` URLs, credentials in URLs |
| `structure` | Missing `## When to use`, numbered `## Steps`, `## Done when`, or an unclosed fence |
| `frontmatter` | Name not kebab-case or not matching its folder, a missing "Use when", or any key beyond `name`, `description`, `license` |
| `file-type` | Anything in a skill folder besides `SKILL.md`, `references/*.md` and a license |

Rules that name a dangerous act (`secret-exfiltration`, `credential-files`, ...) allow
a sentence that forbids it, such as "Never print the password", but only when the
negation comes before the act in the same sentence. To teach a model what an attack
looks like, quote it in a fence whose info string is `untrusted`; override and
role-hijack phrases are allowed only there, and remote code and secret rules still apply.

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
