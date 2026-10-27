# Updates from the side panel: records

## 2026-10-27: live check, checkout mode (narrow check, not the DC-5 Check)

Script: `~/Projects/_work/2026-10-27-tabkyra-updates/live/update-e2e.mjs`, with `setup.sh`
making a throwaway workspace in `/tmp/tku-live`: APFS clones of the sibling repos, a bare
origin holding this branch, a checkout of it one commit behind (the new commit sets the
manifest to 1.1.9, subject "Live check: version 1.1.9"), built with `TABKYRA_NO_BUMP=1`.
The native host was registered from the checkout under an isolated HOME; the extension was
loaded from the checkout's `dist-chrome` into Playwright's headless Chromium (Chrome for
Testing 156). A mock model held an agent run open on demand.

Steps and results (18 of 18 passed):

- The panel shows "Update available: 1 new commit on main" with Update now.
- Settings > Updates: mode "Git checkout", "1 new commit on origin/main (0f2aaaf)", the
  updates choice on "Tell me".
- With an agent run going, Update now: progress checking, pulling, installing
  (setup-siblings.sh, about 6 s), building, skills, done, then "Waiting ... an agent run is
  going in a side panel". No reload for 6 more seconds while the run continued.
- The run ended: the extension called `chrome.runtime.reload()` (its page closed).
- After the reload: version 1.1.9, What's new lists "Live check: version 1.1.9", the panel
  says "Tabkyra reloaded and runs 1.1.9 (0f2aaaf)", the session from before is still stored,
  the checkout is at the new commit with no local changes, and its build is from that commit.
- What's new dismisses; Roll back in Settings reloads into 1.1.8, the exact build from
  before the update (same build id).

What it could have failed on: no notice, wrong mode, a reload during the run, a missing
step, a build that dirtied the checkout, a lost session, no What's new, a rollback to the
wrong build.

**Limit.** In headless Chrome for Testing, `chrome.runtime.reload()` leaves any
command-line-loaded extension blocked (`ERR_BLOCKED_BY_CLIENT`), even a two-file extension
with no Tabkyra code. So after the extension called it, the script restarted the browser on
the same profile, which loads the extension from the same folder. The in-place reload in
Helium is untested live.
