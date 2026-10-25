# Updates

`tabkyra update` installs signed releases from GitHub (baney75/tabkyra). It never runs on
its own. The native host checks for a new release once a day, and the side panel shows a
quiet "Update available" line. You run the update.

## Commands

| Command | What it does | Exit code |
| --- | --- | --- |
| `tabkyra update --check` | Asks GitHub for the newest release on your channel | 0 up to date (or nothing published), **100** update available, 1 error, 2 usage |
| `tabkyra update --check --json` | The same, as JSON (`current`, `latest`, `available`, `channel`, `url`, `error`) | as above |
| `tabkyra update` | Downloads, verifies and installs the newest release | 0 done or up to date, 1 refused or failed |
| `tabkyra update --yes` | Also answers yes to "install the release" when you run from a git checkout | |
| `tabkyra update --rollback` | Swaps back to the release before this one (run it again to undo). From a git checkout it asks first (`--yes` skips the question) | 0, 1 when there is none or you said no |
| `--channel stable\|nightly` | Picks the channel. An update (not `--check`) remembers it in `~/.config/tabkyra/update.json` | |
| `tabkyra update --auto-check off` | Turns the daily check off (`on` turns it back on). `TABKYRA_NO_UPDATE_CHECK=1` also turns it off | |

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
```

The browser loads `~/.local/share/tabkyra/app/dist-chrome`, and the agent launcher
(`~/.config/tabkyra/tabkyra`) and native host run `app/cli/dist/index.js`. Both paths stay
the same across updates, so harness configs never change.

**From a git checkout** (how Tabkyra is developed), `tabkyra update` doesn't touch the
checkout. It offers to install the release into `~/.local/share/tabkyra/app` and points the
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

## The side panel notice

When the extension connects, the native host reads `update-status.json` and refreshes it if
it's more than a day old. That refresh is one GET to the GitHub releases API, and it never
downloads a release. The host sends the result to the extension (`update_status` in
`src/bridge/protocol.ts`). The side panel shows "Update available: X.Y.Z. Run tabkyra
update" under the header. The ✕ hides it until the next version. Nothing updates from the
panel.

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

## One-time setup (Donovan)

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
6. **Cut the first release** with `./release.sh patch`. Then on a machine with the CLI, run
   `tabkyra update --check` (it exits 100), then `tabkyra update`.

If the key ever leaks, make a new pair and replace the public key in a release signed
by the old key. Users on older CLIs pick up the new key when they install that release.
Revoke by deleting the secret and publishing nothing more under the old key.

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
- the native host sending `update_status` to the extension.

The verifier also runs against the upstream minisign test vectors.
