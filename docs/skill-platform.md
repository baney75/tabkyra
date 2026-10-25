# Skill platform

How an agent finds the right skill, how CI keeps that working, and how a user edits,
versions and rolls back a skill. Security rules for skill text are in
[skill-security.md](skill-security.md); the context budget is decision D12 in
[decisions.md](decisions.md).

## Router

`cli/src/skill-router.ts` picks the skill for a task. It is offline, has no dependencies and
needs no model, so it runs in the MCP server on every call and in CI.

Each skill is indexed from three parts of its SKILL.md:

| Field | Source | Weight |
| --- | --- | --- |
| name | the folder name, split on `-`; a run-together name like `kyraskillmaker` also counts the words of its own description it contains | 1.5 |
| what | the description up to "Use when" | 1 |
| when | the description from "Use when", plus the bullets under `## When to use` | 1.5 |

Matching is BM25F over lowercased, lightly stemmed words with stopwords removed, plus
three order signals:

- a slash command in the task (`/rsi`, `/fix`) that names a skill: +6;
- a quoted trigger phrase from the description ("learn from this"): +2.5;
- a pair of neighbouring words shared with the skill ("literature review",
  "search operators"): +2 each. In a list such as "write, draft or port a skill", each item
  pairs with the list's last word.

Sentences that send the reader elsewhere ("Not for ...", "For news, use `news-research`")
are left out, and backticked mentions of other skills are dropped, so they don't pull in the
tasks they exclude. A skill the task names as its object ("fix the osint skill",
`/fix news-research`) doesn't score on its own name.

A skill matches when it scores at least 2.5 and has two pieces of evidence (specific words,
word pairs, a phrase or a command), or scores 4.5 on one piece alone. Otherwise the answer is
`none`: a small model does better with no skill than with the wrong one. A word that
appears in more than about a quarter of the skills doesn't count as evidence.

The router indexes the skills in use: the bundled skills and the user's applied local
copies (`tabkyra skill apply`). The index is built once per process and rebuilt only when
`~/.config/tabkyra/skills-local` changes.

### Using it

- `tabkyra skill match "<task>" [--json] [--top N]` prints the best skills with their scores
  and one-line descriptions, or `none`.
- MCP `skill_match {"task": "..."}` returns the same in a few lines, ending with the
  `skill_read` call to make. `skill_read {"name": "..."}` returns one SKILL.md: the user's
  applied edit if there is one, otherwise the bundled text. The server instructions tell
  agents to call `skill_match` first and `skill_read` only for the chosen skill, so only one
  skill enters the context.
- Remote sessions (`tabkyra serve`) see both tools only with the `skills.read` token scope.

## Eval and the regression cases

`skills-eval/router-cases.jsonl` holds one case per line:

```json
{"task": "Find peer-reviewed studies on sleep and memory", "skill": "academic-research"}
{"task": "Convert this JSON to YAML", "skill": "none"}
```

Write cases the way users phrase tasks, not by copying the description. A new skill needs at
least 8 cases (10 or more is better), and near misses belong in `none`.

`tabkyra skill eval [--json] [--cases <file>]` runs every case against the bundled skills and
checks five gates. It exits 1 when any fails.

| Gate | Requirement |
| --- | --- |
| top-1 accuracy | 90% or more of positive cases route to the right skill |
| false invokes | 5% or fewer of `none` cases route to any skill |
| cases per skill | every bundled skill has 8 or more cases |
| p95 latency | under 10 ms per match (the index build time is reported too) |
| baseline | no skill more than 10 points below its accuracy in `skills-eval/baseline.json` |

Cases that name a skill the catalog doesn't have are skipped and listed, so cases can land
before or after their skill. `tabkyra skill eval --update-baseline` rewrites `baseline.json`
from the current results. Commit it in the same pull request as the change that moved the
numbers, so a reviewer sees any accuracy given up.

Measured on 2026-10-25 (13 skills, 244 cases): top-1 92.8% (193 of 208), false invokes 2.8%
(1 of 36), p95 under 0.2 ms per match, index build under 10 ms. Twenty-six positive cases and
six `none` cases were written before the scorer was run on them; on those alone the router
scored 88.5% and 0%.

## CI gates

The `skill-regression` job in `.github/workflows/ci.yml` builds the CLI without install
scripts and runs:

1. `tabkyra skill lint skills`, which includes the `budget` rule: every SKILL.md is 150
   lines and 8,000 characters or fewer. `tabkyra skill apply` runs the same lint, so a local
   edit can't grow a skill past the budget either.
2. `tabkyra skill eval`, the five gates above.
3. `cli/test/skill-router.test.mjs` and `cli/test/skill-platform.test.mjs`.

## Versions

A skill's version is the first 12 hex digits of the SHA-256 of its SKILL.md, so the same
text has the same version wherever it is stored.

- `tabkyra skill list --json` gives each skill's name, description, version and source
  (`bundled` or `local`).
- `tabkyra skill versions <name> [--json]` lists the bundled version, the applied local
  version and every version in `~/.config/tabkyra/skill-history/<name>/` with the time it
  was kept and why (`backup` before an apply, `reverted`, or `<harness>-replaced`).

## Rollback

`tabkyra skill rollback <name> --to <version|time> [--yes]` restores a version from
skill-history. `--to` takes 6 to 12 hex digits of a version or the time `versions` prints.
The text goes through the same checks as `tabkyra skill apply`: lint, the protected skills
(`rsi`, `kyraskillmaker`) and the protected sections. Without `--yes` it prints the diff,
changes nothing and exits 3. An unknown or ambiguous version is refused. To go back to
the bundled text, use `tabkyra skill revert <name>`.

## Editor

`tabkyra skill edit <name> [--yes]` copies the exact source in use (`print --raw`) to
`~/.config/tabkyra/skill-drafts/<name>/SKILL.md`. A draft that already differs from the
source is kept, so an unfinished edit isn't overwritten.

- In a terminal with `$VISUAL` or `$EDITOR` set, it opens the draft, then shows the diff
  through the same checks as `skill apply`, asks `Apply? [y/N]`, and applies with a backup
  only on yes, or straight away with `--yes`.
- Outside a terminal (an agent's shell) it prints the draft path and the `skill apply`
  command, and exits 0 without applying anything.

The protected skills can't be edited this way; they change only through a reviewed pull
request.
