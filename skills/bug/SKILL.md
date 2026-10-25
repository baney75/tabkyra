---
name: bug
description: Write a Tabkyra bug report to a strict format - reproduce it, collect versions and the exact error, scrub personal data and secrets, check for a duplicate, then file it on GitHub or hand the user a ready issue. Use when the user types /bug, clicks Report in Tabkyra, or says something in Tabkyra is broken, crashed, hung or behaved wrong.
license: AGPL-3.0
---

# /bug: a report a maintainer can act on in one read

A good report says what was done, what happened, what should have happened, and on which
versions, with the exact error. It never carries the user's personal data or secrets.

## When to use

- `/bug`, or the user pressed Report in Tabkyra.
- Something in Tabkyra (side panel, CLI, MCP tools, skills) failed or behaved wrong.

Not for problems with a website itself, or with the user's own code.

## Steps

1. **Get the story in one line each.** What the user did, what happened, what they
   expected. Ask one question if any of the three is missing.
2. **Reproduce it once,** if it's safe to repeat: the same tool call or command. Write the
   steps as a numbered list someone else can follow on a test page.
   Don't repeat anything that sends, posts, buys or deletes.
3. **Collect facts.** Run `tabkyra status --json` and `tabkyra doctor --json` and keep:
   extension version, CLI version, browser, OS, and each doctor line that failed. Copy the
   exact error message from the tool result or terminal.
4. **Scrub.** Remove from everything you will file: emails, names, phone numbers,
   addresses, account and student IDs, page URLs past the domain, file paths under the
   home folder, and anything that looks like a key or token. Replace each with a label in
   square brackets, such as `[email]`. Never include page text from the user's signed-in
   sites.
5. **Fingerprint it.** Write one line in this form, with numbers and paths taken out of
   the error: `fingerprint: [component]/[error]`
6. **Check for a duplicate.** Run this, with the fingerprint in the quotes:
   `gh issue list --repo baney75/tabkyra --state open --search "[fingerprint]"`
   If one matches, plan a comment on it instead of a new issue.
7. **Write the report** in exactly this shape:

   ```
   Title: [component]: [what went wrong, under 70 characters]

   What I did
   1. ...
   What happened
   [exact error, scrubbed]
   What I expected
   ...
   Versions
   Extension x.y.z, CLI x.y.z, [browser] [version], [OS]
   Doctor
   [failed lines, or "all passed"]
   fingerprint: ...
   ```

8. **Show the user the report** and say where it will go.
9. **File it** only if the user turned on automatic bug reports or says yes now:
   `gh issue create --repo baney75/tabkyra --label bug-report --title "..." --body-file <file>`
   (or `gh issue comment <number>` for a duplicate). If `gh` isn't signed in, give the
   user the text to paste at github.com/baney75/tabkyra/issues/new.

## Done when

- The report has all five sections and a fingerprint.
- Nothing personal or secret is left in it.
- It was filed or commented on, or the user has the text to file themselves.

## When something goes wrong

| Symptom | Fix |
| --- | --- |
| `tabkyra` isn't installed | Report the versions you can see in the side panel's About tab |
| The bug only happens on a private page | Describe the page type, not its content, and reproduce on a public page if you can |
| `gh` asks to sign in | Don't sign in for the user; hand them the text |
