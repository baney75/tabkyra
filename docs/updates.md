# Updates

Tabkyra updates from the side panel. The native host checks once a day; the panel shows
"Update available" with an **Update now** button; the update runs, and Tabkyra reloads
itself once no agent is running. Settings > Updates shows what runs and offers Check now,
Update now and Roll back. `tabkyra update` does the release install from a terminal.

What "update" does depends on how Tabkyra runs (the install mode):

| Mode | When | Update now does | Roll back does |
| --- | --- | --- | --- |
| **Release** | the native host runs from `~/.local/share/tabkyra/app` | downloads the newest signed GitHub release, verifies it ([checks](#what-an-update-checks-before-it-touches-a-file)) and unpacks it to `staged/`; once idle, swaps it in | swaps back to the release before it |
| **Checkout** | the native host runs from a git checkout of Tabkyra (how Donovan runs it) | `git fetch`, `git pull --ff-only` on main, `./scripts/setup-siblings.sh`, builds the extension and the CLI into `.tabkyra-update/next/`; once idle, swaps them in | swaps back to the build before it (the git checkout stays where it is) |
| Unmanaged | anything else (an npm install, a copied folder) | refuses: run `tabkyra update` in a terminal | |

## The side panel

- **Update now** (under the header, and in Settings > Updates) sends the native host one
  of a fixed set of action names. The host runs the matching fixed command
  (`tabkyra update --host`, `--host --activate`, `--host --rollback` or `--host --reinstall`)
  as a child process of the CLI it runs from, and streams each step to the panel: checking,
  downloading, verifying, pulling, installing, building, skills, then done or failed with
  the reason.
- **Two steps.** The first step (`--host`) downloads and verifies a release, or pulls and
  builds a checkout, aside; nothing the browser loads changes, so you can keep working. The
  panel then shows "Update ready". The second step (`--host --activate`) swaps the new files
  in, refreshes skills and records What's new. The service worker sends it only when no
  agent is running, and reloads Tabkyra right after, so the browser never runs a mix of old
  and new files for more than that moment. Roll back also runs only when idle. **Install
  now** in the panel asks for the second step (it still waits for idle).
- **The reload.** The extension reloads itself with `chrome.runtime.reload()`, never while an
  agent run is going in any side panel or bridge session; until then the panel says what it
  waits for. "Idle" means: no side panel run is going (a running panel beats every 15
  seconds, so a flag a crashed panel left stops counting after 45), no bridge request is in
  flight, and no harness made a browser call in the last 30 seconds (a harness between two
  calls looks idle after that). An automatic update also waits 3 quiet minutes before each
  step.
- **The install gate.** Before the worker checks idle for an install, a rollback or the
  reload, it takes a gate (`tabkyra.updateInstalling` in `chrome.storage.session`). While it
  holds the gate, a side panel send is refused with "Tabkyra is installing an update and
  reloads in a moment" (the text goes back into the editor) and a bridge request gets an
  error saying to repeat it after the bridge reconnects. So nothing new starts between the
  idle check, the swap and the reload. The remaining window is a send that passed its check
  just before the gate and hasn't marked its panel busy yet. Sessions are kept in IndexedDB
  and `chrome.storage.local`, so chats and agent tab groups come back after the reload;
  reopen the side panel to continue.
- **The updater outlives the host.** It runs in its own process group and writes each step
  to `~/.config/tabkyra/update-progress.json`. If the browser closes the native host
  mid-update, the update finishes, and the next host reports it (or reports that it stopped,
  if its process died). A host also repairs an interrupted swap when it starts.
- **What's new.** After the reload a card shows the release notes (the GitHub release
  body) or, in a checkout, the commits pulled in (first-parent, a pull request shown by its
  title, at most 20, with a link to compare on GitHub). The ✕ hides it.
- **Bundled skills.** After an update the new CLI refreshes the skills installed in Claude
  Code, Codex and OpenCode that you haven't edited (`tabkyra skill refresh`). A copy is
  refreshed only when it is exactly what Tabkyra wrote (`~/.config/tabkyra/skills-installed.json`
  records the hash of every file install writes, and the updater records the unedited copies
  right before it swaps). Edited copies are left alone and listed in What's new.
- **Version mismatch.** Each build writes `build-info.json` (a build id, the commit and the
  version) and compiles the same record in. If the installed extension and CLI come from
  different commits (an update stopped partway), the panel offers **Re-run install**. If the
  browser or the native host still runs an older build than the one installed, it offers
  **Reload Tabkyra**.
- **Settings > Updates** shows the running build, the installed one, the mode, the folder,
  the channel (`main` in a checkout), the last and next check, why an update would refuse,
  and the updates choice:
  - **Off**: no checks at all.
  - **Tell me** (the default): check daily and show "Update available".
  - **Install automatically when idle**: also install on its own once no agent has run in
    any side panel or bridge session for 3 minutes; the idle check runs again right before
    the reload. It never reinstalls a release you rolled back from, never rebuilds a
    checkout you rolled back (only new commits), and doesn't retry a failed attempt for the
    same version.

### Checkout mode

The checkout is the folder the native host runs from (its `cli/dist/index.js`). The host
compares the `build-info.json` the browser serves from the extension folder with the one in
that checkout's `dist-chrome`, so it knows the browser loads the extension from there. If it
loads it from somewhere else, Update now refuses and says so.

An update refuses, changing nothing, when:

- the checkout has local changes to tracked files (untracked files don't count);
- it isn't on main (another branch or a detached HEAD);
- main and origin/main have diverged, so the pull wouldn't be a fast-forward.

The builds go to `.tabkyra-update/next/` (ignored by git) with `TABKYRA_NO_BUMP=1`, so the
build never edits the manifest. Only when both the extension and the CLI built is the build
staged (`next/staged.json`); activation refuses it if HEAD moved since. The extension folder
is swapped by renames; the CLI is replaced file by file in place (a rename over each file),
so `cli/dist/index.js`, which the native host's launcher runs, is never missing. Install
and Roll back write a journal (`.tabkyra-update/journal.json`) and keep every source whole
until they commit, so a crash at any point is finished or undone by the next updater or the
next native host start. The builds they replace go to `.tabkyra-update/previous/` for Roll
back. If `npm install` in `setup-siblings.sh` rewrote a `package-lock.json`, the updater puts
it back as committed (any other changed tracked file stops the update), so the next update
isn't refused for local changes. `setup-siblings.sh` fetches a pinned sibling revision the
clone doesn't have yet, and moves pi-mono to a new pin when a pull changed it. A failed build leaves the old
build live and says why; the pulled commits stay, and the next Update now builds them, with
What's new counting from the live build. One updater runs at a time
(`.tabkyra-update/update.lock`).

**Trust.** A release is checked against the minisign key in the CLI. A checkout is trusted
the way `git pull` and `npm run build` by hand are: the updater runs `setup-siblings.sh` and
the build scripts of whatever origin/main holds. Point origin only at a repository you
trust. "Install automatically when idle" in a checkout runs those scripts without a click;
use "Tell me" if you want to look at new commits first.

### What the host runs

The extension's request is `{ "type": "update_action", "action": <name> }` and nothing
else; a frame with any other field, or an unknown name, is refused before anything runs
(`parseUpdateRequest` in `src/update/logic.ts`). The names:

| Action | The host |
| --- | --- |
| `check` | checks now (a GitHub API GET, or `git fetch origin main` in a checkout) |
| `update` | runs `tabkyra update --host` (download or pull, verify or build, stage) |
| `activate` | runs `tabkyra update --host --activate` (swap the staged build in); the service worker sends it only when idle |
| `rollback` | runs `tabkyra update --host --rollback` |
| `reinstall` | runs `tabkyra update --host --reinstall` (the mismatch fix: register the host again, or rebuild a checkout from HEAD) |
| `policy-off`, `policy-notify`, `policy-auto` | writes the updates choice to `~/.config/tabkyra/update.json` |

The command lines are constants (`UPDATE_COMMANDS` in `cli/src/update-host.ts`) passed as
argv without a shell, and the updater's own commands (`git`, `npm run build`,
`scripts/setup-siblings.sh`) are fixed too. Only Tabkyra's own pages can ask the service
worker for an action; a content script can't.

## Commands

| Command | What it does | Exit code |
| --- | --- | --- |
| `tabkyra update --check` | Asks GitHub for the newest release on your channel | 0 up to date (or nothing published), **100** update available, 1 error, 2 usage |
| `tabkyra update --check --json` | The same, as JSON (`current`, `latest`, `available`, `channel`, `url`, `error`) | as above |
| `tabkyra update` | Downloads, verifies and installs the newest release | 0 done or up to date, 1 refused or failed |
| `tabkyra update --yes` | Also answers yes to "install the release" when you run from a git checkout | |
| `tabkyra update --rollback` | Swaps back to the release before this one (run it again to undo). From a git checkout it asks first (`--yes` skips the question) | 0, 1 when there is none or you said no |
| `--channel stable\|nightly` | Picks the channel. An update (not `--check`) remembers it in `~/.config/tabkyra/update.json` | |
| `tabkyra update --auto-check off` | Turns the daily check off, the same as Settings > Updates > Off (`on` turns it back on). `TABKYRA_NO_UPDATE_CHECK=1` also turns it off | |
| `tabkyra skill refresh [--json]` | Refreshes the installed skills you haven't edited (the update runs it) | 0 |

Stable takes releases tagged `vX.Y.Z`. Nightly also takes prereleases such as
`vX.Y.Z-nightly.20261025`.

Script example:

```sh
tabkyra update --check; case $? in 0) echo current ;; 100) tabkyra update ;; *) echo "check failed" ;; esac
```

## Where it installs

```
~/.local/share/tabkyra/app/        the installed release: dist-chrome/, cli/dist/index.js, release.json
~/.local/share/tabkyra/previous/   the release before it, for --rollback
~/.config/tabkyra/update-status.json   the last check (the native host reads it)
~/.config/tabkyra/update.json      the channel and the updates choice
~/.config/tabkyra/last-update.json the last update, rollback or reinstall ("What's new")
<checkout>/.tabkyra-update/        checkout mode: next/ (a build in progress), previous/ (for Roll back)
```

The browser loads `~/.local/share/tabkyra/app/dist-chrome`, and the agent launcher
(`~/.config/tabkyra/tabkyra`) and native host run `app/cli/dist/index.js`. Both paths stay
the same across updates, so harness configs never change.

**From a git checkout** (how Tabkyra is developed), `tabkyra update` in a terminal doesn't
touch the checkout; Update now in the side panel updates the checkout itself (see Checkout
mode above). It offers to install the release into `~/.local/share/tabkyra/app` and points the
native host and launcher there. After that first install, remove the old Tabkyra on
`chrome://extensions` and load the new folder once. To keep running from the checkout,
answer no and use `git pull`, `./scripts/setup-siblings.sh`, `npm run build` and
`cd cli && npm run build`.

## What an update checks before it touches a file

1. **The release list.** It reads the newest non-draft release on the channel. It needs
   `tabkyra-<version>.zip`, `SHA256SUMS` and `SHA256SUMS.minisig`, and refuses a release
   without all three. Downloads use https (loopback http is allowed only for the test server),
   with size limits (64 KB for the checksum files, 200 MB for the zip).
2. **The signature.** `SHA256SUMS.minisig` must verify against the minisign public key
   built into the CLI (`keys/tabkyra-release.pub`). The verifier is `cli/src/minisign.ts`.
   It accepts only prehashed Ed25519 signatures (minisign's default), checks the key id,
   and checks the signed trusted comment.
3. **The version.** The trusted comment must say `tabkyra <version>`, the version being
   installed. An old, validly signed `SHA256SUMS` can't be passed off as a newer release.
4. **The checksum.** The zip's SHA-256 must match its line in `SHA256SUMS`.
5. **The contents.** The zip is unpacked into a staging folder. It refuses absolute paths,
   `..`, symlinks, encrypted entries, CRC mismatches and anything over 512 MB unpacked.
   `release.json` must name the version, the extension's `manifest.json` must match it, and
   every file the extension and CLI need must be there.

Any failure stops the update, and the installed release stays as it was.

## How the swap works

The update holds a lock: a directory, `update.lock`, holding the owner's pid. It is taken
over only when that pid is dead, or when no pid was written and the lock is over 10 minutes
old. Under the lock it does two renames: `app/` becomes `previous/`, and the staged folder
becomes `app/`. If the second rename fails, the first is undone. Rollback is three renames
through a `.swap-*` folder.

Every `tabkyra update` run, including `--check` and `--rollback`, first repairs whatever a
crash left, without deleting a release:

- if `app/` is missing, a `.swap-*` folder or `previous/` becomes `app/`;
- if `previous/` is missing, an orphaned `.swap-*` becomes `previous/`;
- unused staging folders are removed.

After the swap, the new CLI runs `install`, which rewrites the launcher and every browser's
native host manifest if they changed. Then it tells you to reload Tabkyra
(`tabkyra reload`, or the reload button on `chrome://extensions`). The browser keeps
running the old files until you reload.

## The daily check

When the extension connects, and every hour while the host runs, the native host reads
`update-status.json` and refreshes it if it's more than a day old. In release mode that is
one GET to the GitHub releases API; in a checkout it is `git fetch origin main`. A check
never downloads or installs anything. The host sends the result to the extension
(`update_status` in `src/bridge/protocol.ts`). The ✕ on "Update available" hides it until
the next version.

## Releasing

1. Add entries under `## [Unreleased]` in `CHANGELOG.md`.
2. Stable: `./release.sh patch` (or `minor`, `major`). It bumps
   `static/manifest.chrome.json`, finalizes the changelog, commits, tags `vX.Y.Z` and
   pushes.
   Nightly: tag the commit `vX.Y.Z-nightly.<yyyymmdd>`, where `X.Y.Z` equals the manifest
   version, then push the tag.
3. `.github/workflows/release.yml` runs on the tag in two jobs.
   - **build** has a read-only token, no secrets and no persisted git credentials. It
     checks the tag against the manifest, checks out the pinned siblings (pi-mono and
     mini-lit, by commit, in `scripts/setup-siblings.sh`), builds, runs the checks and the
     CLI tests, packages (`scripts/release/package.mjs`), and uploads the files.
   - **publish** runs no npm and no repo code. It downloads those files, installs minisign,
     signs `SHA256SUMS`, verifies the signature against the public key at the tagged commit,
     and creates the release. It is the only job that holds the secret or a write token,
     so install scripts in the build can't read the key.

   A tag with a `-` becomes a prerelease.

### Is the release workflow ready?

Checked 2026-10-27, before the first release:

- **Runner.** Both jobs run on `ubuntu-24.04`, GitHub-hosted. The repository is public, Actions
  are enabled for all actions, and the CI workflow already runs on the same runner and passes
  (for example run 40445740971 on main). Public repositories don't use paid minutes.
- **minisign on the runner.** The publish job installs it with apt; Ubuntu 24.04 (noble) has
  `minisign` 0.11-1 in universe, which GitHub's images enable.
- **What still blocks a release:** `keys/tabkyra-release.pub` holds no key (the build job
  stops at "Check the tag") and the repository has no secrets, so `MINISIGN_SECRET_KEY` is
  missing (the publish job would stop at "Sign"). The workflow has never run. The `v1.0.0`
  tag predates it and has no release; `tabkyra update` reads releases, not tags, so it is
  ignored.
- **The version.** `static/manifest.chrome.json` says 1.1.8, so `./release.sh patch` makes
  `v1.1.9`. Build with `TABKYRA_NO_BUMP=1` (the workflow does): a plain `npm run build` bumps
  the manifest in the checkout.
- **The notes** are the `CHANGELOG.md` section for the version (`scripts/release/notes.mjs`);
  the side panel shows them in "What's new".

## One-time setup (Donovan)

Checkout mode needs none of this: Update now works from a git checkout without a release.
These steps are for signed releases (release mode and `tabkyra update`). Each step that
creates the key or the secret is yours to decide and do; an agent can do the PR and the
release command once you say so.

There is no signing key yet. `keys/tabkyra-release.pub` holds only a comment, so every
`tabkyra update` refuses ("no release signing key") and the release workflow fails at "Check
the tag". To turn updates on:

1. **Make the key on your Mac**, outside any repo. `minisign` is a Homebrew formula.
   ```sh
   minisign -G -W -p tabkyra-release.pub -s tabkyra-release.key
   ```
   `-W` makes a key without a password, because CI signs unattended. The secret key file is
   the whole trust root, so treat it like a password.
2. **Store the secret key** in Proton Pass as a secure note ("Tabkyra release signing key"),
   with the full contents of `tabkyra-release.key`.
3. **Add it as a repository secret** named `MINISIGN_SECRET_KEY` on baney75/tabkyra
   (Settings > Secrets and variables > Actions), with the same contents. Or:
   `gh secret set MINISIGN_SECRET_KEY --repo baney75/tabkyra < tabkyra-release.key`
4. **Commit the public key**: replace `keys/tabkyra-release.pub` with `tabkyra-release.pub`,
   open a PR, merge it.
5. **Delete the local secret key file** (`rm tabkyra-release.key`). Proton Pass and the
   repository secret are the only copies.
6. **Cut the first release** with `./release.sh patch` on an up-to-date, clean main (it
   pushes the release commit to main and the tag `v1.1.9`). Watch the Release workflow on
   the Actions tab; it should end with a release that has `tabkyra-1.1.9.zip`, `SHA256SUMS`
   and `SHA256SUMS.minisig`. Then on a machine with the CLI, run `tabkyra update --check`
   (it exits 100), then `tabkyra update`.

If the key ever leaks, make a new pair and replace the public key in a release signed
by the old key. Users on older CLIs pick up the new key when they install that release.
Revoke by deleting the secret and publishing nothing more under the old key.

## Starting with an older build

A build from before the update system has no Update now button, and its native host can't
run updates. Update a checkout once by hand, then reload Tabkyra:

```sh
git pull --ff-only && ./scripts/setup-siblings.sh
TABKYRA_NO_BUMP=1 npm run build && (cd cli && npm run build)
tabkyra reload    # or the reload button on chrome://extensions
```

`TABKYRA_NO_BUMP=1` keeps the build from editing the manifest; a checkout with local changes
can't update itself.

## Tests

`cli/test/update.test.mjs` runs the flow against a fake GitHub server on 127.0.0.1 with a
throwaway key (`cli/test/helpers/minisign-sign.mjs`):

- check with nothing published;
- check that exits 100 with JSON;
- a declined install from a checkout;
- a first install from a checkout;
- the installed CLI updating itself;
- a tampered zip, a release signed by another key, a signature made for another version,
  an archive that escapes its folder, and a build with no key, all refused with nothing
  changed;
- rollback and roll forward;
- the nightly channel (a `--check` doesn't save it);
- recovery from a crash in each window of an update and a rollback;
- rollback from a checkout asking first;
- a held lock and a dead one;
- usage errors;
- the native host sending `update_status` to the extension;
- release mode from the side panel (`--host`): the steps, the notes, a tampered archive
  refused, rollback both ways, and the host's command lines accepting nothing else.

`cli/test/checkout-update.test.mjs` runs checkout mode against a throwaway checkout with its
own origin: a fast-forward, local changes, another branch and a diverged main refused, a
failed build leaving the old build, rollback, a copy that is neither mode, skill refresh, and
the native host's update action (the no-parameters rule, the settings actions, the mismatch
report, a browser that loads the extension from another folder).

`test/update-logic.test.mjs` covers the request parser, the idle gate, the extension
location, version mismatches, automatic updates and What's new; `test/update-worker.test.mjs`
covers the service worker relaying only bare actions from Tabkyra's own pages and holding the
reload while a side panel run is going.

The verifier also runs against the upstream minisign test vectors.
