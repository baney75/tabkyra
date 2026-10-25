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
- a quoted trigger phrase of two or more words from the description ("learn from this"):
  +2.5. It counts as evidence only if it holds a word specific enough to be evidence by
  itself, so a phrase of common words ("what's going on with") can rank a skill but can't
  make a match alone ("What's going on with my Docker build?" is none). A one-word quote is
  just a word, scored as one;
- a pair of neighbouring words shared with the skill ("literature review",
  "search operators"): +2 each. In a list such as "write, draft or port a skill", each item
  pairs with the list's last word.

Sentences that send the reader elsewhere ("Not for ...", "For news, use `news-research`")
are left out, quoted phrases in them included, and backticked mentions of other skills are dropped, so they don't pull in the
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
  They match and read the bundled skills only, never the user's local skills or edits: a
  remote session can be a cloud agent off the user's devices, and personal skills stay on
  them (D6).

## Eval and the regression cases

`skills-eval/router-cases.jsonl` holds one case per line:

```json
{"task": "Find peer-reviewed studies on sleep and memory", "skill": "academic-research"}
{"task": "Convert this JSON to YAML", "skill": "none"}
```

Write cases the way users phrase tasks, not by copying the description. A new skill needs at
least 8 cases, and near misses belong in `none`. Cases are append-only: CI fails a pull
request that removes or relabels one (see CI gates).

`skills-eval/router-heldout.jsonl` has the same format. Its cases were written before the
scorer was run on them, and the scorer's constants are never tuned on it. Add held-out cases
without looking at how they score, and don't change the scorer because of them.

**What the numbers mean.** The scorer's constants and the descriptions' "Use when" phrases
were tuned against `router-cases.jsonl`. Its gates measure regression on a tuned set, not
true accuracy on new phrasings. The held-out figures are the closer estimate of that, and
they have lower floors.

`tabkyra skill eval [--json] [--cases <file>]` runs every case against the bundled skills and
checks seven gates. It exits 1 when any fails.

| Gate | Requirement |
| --- | --- |
| top-1 accuracy | 90% or more of positive cases route to the right skill |
| false invokes | 5% or fewer of `none` cases route to any skill |
| cases per skill | every bundled skill has 8 or more cases |
| p95 latency | under 10 ms per match (the index build time is reported too) |
| baseline | every bundled skill and `none` has a value from 0 to 1 in `skills-eval/baseline.json`, and none is more than 10 points below it |
| held-out top-1 | 80% or more of held-out positive cases |
| held-out none | 10% or fewer of held-out `none` cases route to a skill |

Cases that name a skill the catalog doesn't have are skipped and listed, so cases can land
before or after their skill. `tabkyra skill eval --update-baseline` rewrites `baseline.json`
from the current results. Commit it in the same pull request as the change that moved the
numbers, so a reviewer sees any accuracy given up.

Measured on 2026-10-25 (13 skills): on the tuned set of 247 cases, top-1 90.4% (188 of 208)
and false invokes 2.6% (1 of 39); on the 49 held-out cases, top-1 94.9% (37 of 39) and false
invokes 10% (1 of 10). Matching takes about 0.2 ms at p95 and the index build about 20 ms on
the CI runner (about 0.1 ms and under 10 ms on an Apple-silicon Mac).

## CI gates

The `skill-regression` job in `.github/workflows/ci.yml` builds the CLI without install
scripts and runs:

1. `tabkyra skill lint skills`, which includes the `budget` rule: every SKILL.md is 150
   lines and 8,000 characters or fewer. `tabkyra skill apply` runs the same lint, so a local
   edit can't grow a skill past the budget either.
2. `tabkyra skill eval`, the seven gates above.
3. `cli/test/skill-router.test.mjs` and `cli/test/skill-platform.test.mjs`.
4. On a pull request, the base branch's code, built around the pull request's `skills/`,
   runs `tabkyra skill eval --base <base checkout>` from the pull request's checkout. It
   fails when the pull request:
   - removed or relabeled a case from either case file;
   - lowered a skill's value in `baseline.json` more than the regression threshold below
     the base branch's, or dropped it;
   - loosened a threshold in `cli/src/skill-eval.ts` (each may only move the strict way);
   - has skills that fail the base branch's gates on the base branch's cases and baseline.

   The scorer's own constants in `skill-router.ts` may change in a pull request; that is how
   routing improves, and the gates measure the result. `.github/CODEOWNERS` also requires a
   maintainer's review for `skills-eval/`, `skill-eval.ts` and `skill-router.ts`.

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
`~/.config/tabkyra/skill-drafts/<name>/SKILL.md` and records the version it was taken from
in `skill-drafts/.bases/<name>`. An unfinished draft taken from the current version is
resumed. A draft taken from an older version (an apply or rollback happened since) would
undo those changes, so it is moved to `skill-drafts/.backups/<name>/`, with a warning, and a
fresh draft is started.

- In a terminal with `$VISUAL` or `$EDITOR` set, it opens the draft, then shows the diff
  through the same checks as `skill apply`, asks `Apply? [y/N]`, and applies with a backup
  only on yes, or straight away with `--yes`.
- Outside a terminal (an agent's shell) it prints the draft path and the `skill apply`
  command, and exits 0 without applying anything.

The protected skills can't be edited this way; they change only through a reviewed pull
request.
