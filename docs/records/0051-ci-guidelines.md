# 0051 Our CI follows six rules, each with its source

Status: proposed
Date: 2026-10-27 (UTC)

## Context

Record 0049 took the Command Line Interface Guidelines ([clig.dev](https://clig.dev)) for
what a person reads on the screen. CI has no single guide like it. On 2026-10-27 the owner
asked for one of our own, after PR #1118's CI:

- The Windows job printed nothing for 480 s while `init.test.ts` ran, so it looked stuck,
  and most of its lines were files that passed ("字很多没重点，没有progress").
- `init.test.ts` took 240 s on the laptop and passed its cap on the GitHub runner, so one
  shard waited about 8 minutes (issue #1109).
- Main went red with no test failing (issue #1114), and a run cancelled by a newer push
  showed a red `ci`.
- v0.1.1's pull requests were often found broken by CI, not on the laptop first.

The sources we take from, each for one part:

- Martin Fowler's practices of continuous integration, and the CI certification test he
  wrote up with Jez Humble: keep the build fast; a red build is fixed or reverted within
  about ten minutes.
- GitHub's security hardening guide for Actions, and the OpenSSF Scorecard checks
  (Token-Permissions, Pinned-Dependencies, Dangerous-Workflow): pin actions to a full
  commit, give each job the least permissions, treat `pull_request_target` and outside
  input with care.
- clig.dev's output rules (record 0049), for the log a person reads.

## Decision

1. **Fast.** A pull request's CI has a goal of 5 minutes. A slow test file is an issue,
   not a longer cap. (Fowler.) The limits are one table, `TEST_LIMITS` in
   `scripts/time/suite.ts`. Each row says what is measured, the limit, why, and where it
   was decided:
   - `file-seconds`: one test file takes at most 60 s on a Linux CI shard. A file over
     it fails the shard and is named.
   - `full-runs`: a test file writes at most 4 whole doctor or init runs. A file above
     that is on an allowance at its count, which may only go down.

   Rules are data, so a new limit is one more row. If rules outgrow plain numbers, the P4
   review decides on an `expression` field: a borrowed language such as CEL, never one of
   our own (issue #899).
2. **Red means broken, or says why not.** CI is red when a check failed. A cancelled run
   (a newer push) stays red, because GitHub counts a skipped required check as passed, but
   it says it was cancelled; a job that never got a runner says so too. (Fowler; issue #1114.)
3. **The log is readable.** The verdict comes first; a slow step shows progress; passing
   items are folded; the run page has a summary table. (clig.dev; issue #1119.)
4. **Safe.** Actions are pinned to a full commit; each job has the least permissions it
   needs; outside input never builds a shell command; `pull_request_target` runs only code
   from main. (GitHub hardening guide; Scorecard.)
5. **Laptop first.** CI is the final check (FAT), not where a problem is first found: the
   suite and the Windows check run on the laptop before a push.
6. **Waivers expire.** A known failure on the list has a reason, an issue and a removal
   date. (Our waiver list, `scripts/time/windows-known.txt`.)

What a program can check, a test or a linter checks; the rest is read in review.

## Options not taken

- **Copy one outside style guide whole** (such as a team's GitHub Actions style guide):
  each covers naming and layout only, not speed, red-means-broken or waivers.
- **No written rules, fix each case**: the same problems came back across v0.1.0 to v0.1.2.

## Consequences

- Each new CI change names the rule it serves; a reviewer can refuse one that breaks a rule.
- Rule 1 is checked per file, not yet per job: the 5-minute goal is still read by a person.
  Rule 4 has actionlint; Scorecard is still to add.
- The owner decides the six before this record is accepted.
