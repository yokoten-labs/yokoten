# 0053 A step that runs on a rare event also runs on a pull request

Status: proposed
Date: 2026-10-28 (UTC)

## Context

On 2026-10-28 the owner tagged v0.1.2, and the release workflow's `verify` job failed. No
test failed. The test step sent a reporter to `/dev/null`. Node syncs a reporter's file when
it closes it, and a sync of `/dev/null` fails with `EINVAL`, on Node 22 and Node 24. The
line came in with PR #1133. No pull request ran it, because `release.yml` runs only on a
`v*` tag. So the tag was its first run (issue #1149).

The docs-only test step in `yokoten.yml` carried the same line. That path runs only when a
pull request changes docs alone, so it had the same blind spot.

The cause is general. A step that only a rare event runs (a tag, a schedule, a manual run,
a path taken by some pull requests only) is never tried before that event. It fails for the
first time when it counts the most, and the owner is the one who finds it.

Google's release engineering says the same thing another way. A release is built and tested
by the same automated steps as every change, so releasing is routine, not an event
([Site Reliability Engineering, chapter 8](https://sre.google/sre-book/release-engineering/)).
The release that reaches users is the one that already passed the tests.

## Decision

1. **The release's checks are one file.** `.github/workflows/release-checks.yml` holds every
   step that can fail a release. `release.yml` calls it on a tag. `yokoten.yml` calls it on
   every pull request, and `ci` waits for it. Only two steps wait for a tag: the check that
   the tag matches `package.json`, and keeping the package for `publish`.
2. **A test keeps it so.** The architecture test fails when `release.yml` runs its own
   checks again, when no pull request job calls the file, when `ci` does not wait for it, or
   when another step waits for a tag.
3. **No test reporter writes to a device.** The workflow standard test catches
   `--test-reporter-destination=/dev/...` in every workflow, the kit's included.
4. **The rule for new workflows.** A step that runs on a rare event either also runs on a
   pull request, or its workflow says why it can't. The scheduled workflows
   (`actions-health`, `borrowed`, `outside-prs`, `board`, `anchor`) are the next to check.

## Options not taken

- **Change the one line and tag again.** It fixes this tag. The next step that only a tag
  runs would fail the next tag the same way.
- **Run the release checks in the merge queue.** It also tries them before the merge. But
  the queue group takes about 1.5 minutes now, and the checks take about 4. Every merge
  would wait longer. A pull request already waits for Windows, which takes longer.
- **Rerun the failed release.** The failure comes back every time, so a rerun can't pass.

## Consequences

- A pull request runs one more job, about 4 minutes, beside Windows. Its wait does not grow.
- The release runs the same file it ran on the pull request, so a tag finds no new step.
- A merge queue group does not run the release checks, as it does not run Windows. A push to
  main and the daily run do.
- The scheduled workflows still have steps that no pull request runs. That is the next
  piece of work under this rule.
