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

- a slash command that names a skill: +6. It counts only as the task's first token, and not
  when followed by `/` or `.`, so paths like `ls /fix` or `cat /bug/report.txt` don't. Other
  path-like words (starting with `/`, `./`, `../` or `~/`) are dropped as data;
- a skill the task asks for by name ("use the osint skill on this landlord", "run the
  dorks skill"): +6, the same as its command;
- a quoted trigger phrase of two or more words from the description ("learn from this"):
  +2.5. It counts as evidence only if it holds a word specific enough to be evidence by
  itself, so a phrase of common words ("what's going on with") can rank a skill but can't
  make a match alone ("What's going on with my Docker build?" is none). A one-word quote is
  just a word, scored as one;
- a pair of neighbouring words shared with the skill ("literature review",
  "search operators"): +2 each. In a list such as "write, draft or port a skill", each item
  pairs with the list's last word.

Sentences that send the reader elsewhere ("Not for ...", "For news, use `news-research`")
are left out, quoted phrases in them included, and backticked mentions of other skills are
dropped, so they don't pull in the tasks they exclude. "Use `x` ..." counts as a redirect
only when `x` is a skill; "Use `pass-cli run` when ..." is a trigger and stays.

How a task names a skill ("<name> skill") decides what the name does:

- **Changed:** an edit verb (fix, repair, edit, update, rewrite, improve, review, change,
  correct, port...) governs the mention, as in "fix the osint skill", "rewrite my old dorks
  skill", "edit to the osint skill" or "the osint skill failed, repair it", or a slash
  command is the first token (`/fix news-research`). The name doesn't score for itself, and
  the task counts as evidence for the skills whose job is skills. An edit-like word elsewhere
  ("the latest updates", "review what you find") doesn't count.
- **Ruled out:** a negation governs it, within a few words before it: "don't/do not/never
  use (or run, apply, follow) the osint skill", "without", "instead of", "rather than",
  "skip", "avoid", or "not the osint skill". That skill is never returned for the task. A
  "no" or "not" elsewhere ("no rush, use the osint skill", "why not use the osint skill",
  "I have no idea who runs this, so use the osint skill") rules nothing out.
- **The CLI:** `tabkyra skill install` (or another subcommand) is the Tabkyra CLI, read as
  "tabkyra cli", not a request for the tabkyra skill.
- **Requested:** otherwise ("use the osint skill on this landlord"), +6 for that skill.

A skill matches when it scores at least 2.5 and has two pieces of evidence (specific words,
word pairs, a phrase or a command), or one piece and a score of 4.5. Otherwise the answer is
`none`: a small model does better with no skill than with the wrong one. A word that
appears in more than about a quarter of the skills doesn't count as evidence, so common
words alone never make a match, however high they add up.

The router indexes the skills in use: the bundled skills and the user's applied local
copies (`tabkyra skill apply`). The index is built once per process and rebuilt only when
`~/.config/tabkyra/skills-local` changes: each file's inode, change time, modification time
and size, plus a hash of `index.json`, so two same-size edits within one timestamp tick
still rebuild it.

### Using it

- `tabkyra skill match "<task>" [--json] [--top N]` prints the best skills with their scores
  and one-line descriptions, or `none`.
- MCP `skill_match {"task": "..."}` returns the same in a few lines, ending with the
  `skill_read` call to make. `skill_read {"name": "..."}` returns one SKILL.md: the user's
  applied edit if there is one, otherwise the bundled text. The server instructions give one
  order: first `skill_match` with the user's task (it needs no browser), then `skill_read`
  only for the chosen skill, so only one skill enters the context; `status` comes before any
  browser tool, and a missing browser stops browser work only.
- Remote sessions (`tabkyra serve`) see both tools only with the `skills.read` token scope.
  They match and read the bundled skills only, never the user's local skills or edits: a
  remote session can be a cloud agent off the user's devices, and personal skills stay on
  them (D6). Any session created with a tool scope (`allowedTools`) gets the same, whether
  or not it is marked remote.

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
| baseline | every bundled skill and `none` has a value from 0 to 1 in `skills-eval/baseline.json`, and none claims more than the router measures (no tolerance), so every later comparison is like with like |
| held-out top-1 | 80% or more of held-out positive cases |
| held-out none | 10% or fewer of held-out `none` cases route to a skill |

Cases that name a skill the catalog doesn't have are skipped and listed, so cases can land
before or after their skill. `tabkyra skill eval --update-baseline` rewrites `baseline.json`
from the current results. Commit it in the same pull request as the change that moved the
numbers.

The baseline only ratchets up. A pull request may raise any value. A value lower than the
base branch's fails CI unless the pull request adds an entry for that skill and its new value
to `skills-eval/accepted-drops.json`, which a maintainer reviews (CODEOWNERS):

```json
{"drops": [{"skill": "news-research", "value": 0.7059, "reason": "the new skills share its words"}]}
```

An entry the base branch already had doesn't count again, so every drop is accepted once,
by name, with a reason. An added entry must name a skill that exists, carry exactly that
skill's new value in `baseline.json`, and sit below the base branch's value. The accepted value
then becomes the skill's floor with no tolerance, in `skill eval` and in the base-code eval:
it means "at least this", not "anything".

Measured on 2026-10-25 (13 skills): on the tuned set of 273 cases, top-1 91.6% (207 of 226)
and false invokes 0% (0 of 47); on the 49 held-out cases, top-1 94.9% (37 of 39) and false
invokes 10% (1 of 10). The top-1 gate needs 204 of 226, so the margin is three cases. Matching takes about 0.2 ms at p95 and the index build about 20 ms on
the CI runner (about 0.1 ms and under 10 ms on an Apple-silicon Mac).

## CI gates

The `skill-regression` job in `.github/workflows/ci.yml` builds the CLI without install
scripts and runs:

1. `tabkyra skill lint skills`, which includes the `budget` rule: every SKILL.md is 150
   lines and 8,000 characters or fewer. `tabkyra skill apply` runs the same lint, so a local
   edit can't grow a skill past the budget either.
2. `tabkyra skill eval`, the seven gates above.
3. `cli/test/skill-router.test.mjs` and `cli/test/skill-platform.test.mjs`.
4. On a pull request, CI builds a judge from both branches and runs
   `tabkyra skill eval --base <base checkout>` from the pull request's checkout.

   | From the pull request (what is judged) | From the base branch (the judge) |
   | --- | --- |
   | `skills/`, with the catalog regenerated from it by `cli/scripts/skills-catalog.mjs` | `cli/src/skill-eval.ts`: every gate's logic and threshold |
   | `skills-eval/`: case files, `baseline.json`, `accepted-drops.json` | the rest of the CLI (`skill.ts`, `index.ts`) |
   | `cli/src/skill-router.ts` | the base branch's own `skills-eval/` files, for the comparisons |

   A pull request therefore can't loosen a gate, in its constants or its logic, because its
   `skill-eval.ts` never runs here. A router improvement can still merge: the base gates
   judge the pull request's router. If the pull request's `skill-router.ts` doesn't
   type-check against the base's `skill-eval.ts` and CLI, the router and the eval API
   changed together; CI fails with that message, with no fallback, and a maintainer reviews
   it. The regenerated catalog means new skills are indexed and removed ones don't break the
   build, and CI checks the judge indexed as many skills as `skills/` holds. It fails when
   the pull request:
   - removed or relabeled a case from either case file;
   - lowered a skill's value in `baseline.json` below the base branch's, or dropped it,
     without an accepted drop;
   - loosened a threshold in `cli/src/skill-eval.ts` (each may only move the strict way);
   - has an accepted-drops entry that isn't valid (see above);
   - has skills that, under the base code, route the base cases worse than the base
     baseline (no tolerance; an accepted drop's value is the floor instead) or fail the base
     gates;
   - deletes a skill the base measures without listing it under `removed` in
     `accepted-drops.json`, with a reason: `{"removed": [{"skill": "old-skill", "reason":
     "merged into osint"}]}`;
   - fails the base gates and thresholds (top-1, false invokes, cases per skill, latency,
     held-out floors, and the baseline for every skill and `none`, accepted floors
     included) over all of its own case files and its own baseline, judged with its own
     router. Skills it adds need no base cases, but they are held to these gates.

   The scorer's own constants in `skill-router.ts` may change in a pull request; that is how
   routing improves, and the base gates measure the result. The threshold check compares
   the constants' declarations, so a stricter threshold can merge; the gate logic itself
   comes from the base, and a change to it takes effect only after it merges, which is why
   `.github/CODEOWNERS` requires a maintainer for `skills-eval/` (`accepted-drops.json` included),
   `skill-eval.ts`, `skill-router.ts` and the catalog script.

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
changes nothing and exits 3. An unknown or ambiguous version is refused. A target that is
the bundled text removes the local edit, as `tabkyra skill revert <name>` does, instead of
pinning a local copy that would stop bundled updates.

## Editor

`tabkyra skill edit <name> [--yes]` copies the exact source in use (`print --raw`) to
`~/.config/tabkyra/skill-drafts/<name>/SKILL.md` and records the version it was taken from
in `skill-drafts/.bases/<name>`. An unfinished draft taken from the current version is
resumed. A draft taken from an older version (an apply or rollback happened since) would
undo those changes, so it is moved to `skill-drafts/.backups/<name>/`, with a warning, and a
fresh draft is started. A draft that differs from the version it was taken from is always
moved there before a fresh one replaces it, even when its text matches the current source;
only an untouched draft is refreshed in place.

- In a terminal with `$VISUAL` or `$EDITOR` set, it opens the draft, then shows the diff
  through the same checks as `skill apply`, asks `Apply? [y/N]`, and applies with a backup
  only on yes, or straight away with `--yes`.
- If the skill changes while the editor is open, or before the yes (another apply, revert or
  rollback), it refuses to apply, keeps the draft, and says to start again from the new
  version, so the other change isn't undone.
- Outside a terminal, or with `--draft-only`, it prints the draft path and the `skill apply`
  command, and exits 0 without opening an editor, asking or applying. Agents use
  `--draft-only`: their shell can be a terminal with the user's `$EDITOR` set.
- `--draft-only` never touches a draft with unapplied changes, current or stale: it leaves
  the file as it is, says so and exits 1, and the agent stops and asks the user (the rsi
  skill says to). An agent never overwrites, moves or discards the user's draft.

The protected skills can't be edited this way; they change only through a reviewed pull
request.
