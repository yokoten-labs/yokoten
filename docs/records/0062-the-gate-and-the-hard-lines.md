# 0062 Record 0061, made clear: the merge gate, and the hard lines

Status: accepted
Date: 2026-11-11 (UTC)

## Context

Record [0061](0061-safety-net-only.md) was merged with a review that asked for changes
(issue #1349). The lead had not read the review. Two of its findings are right:

- Point 7 says "yokoten keeps the gate". Point 8 says the merge gate leaves the core. A
  reader can't tell where the gate is.
- Point 3 says the guard "stops reading shell" and "keeps a short list of hard lines". It
  does not say what a hard line is, so the two can read as one thing.

The third finding called the date of record 0061 a future date. It is wrong: the date is
the day the record was written.

Record 0061 stays as it is. This record says how to read it. The owner agreed to the
reading of the gate on 2026-11-11.

## Decision

1. **The merge gate, in two stages.**
   - Now: `train` and the conflict map are removed. The merge gate stays where it is, in
     the core: the checks the bot runs before it merges.
   - Later, with point 8 of record 0061: the merge gate moves out of the core, together
     with the bot. It is not deleted.
   - So "yokoten keeps the gate" in point 7 means "until the bot moves".
2. **A hard line is a fixed rule on one action.** The guard finds it by the program and
   its own words, as they are written. It does not follow shell grammar to find one: no
   quotes, variables, substitutions or heredocs are worked out.
3. **The list of hard lines is not in this record.** The plan that removes the guard's
   shell reading names each one, and the owner accepts that plan first.

## Options not taken

- **Edit record 0061.** An accepted decision is not rewritten; a reader of the history
  would not see that the text changed after a review.
- **Name the hard lines here.** The list needs the measurements of that plan. A list
  written now would be a guess.

## Consequences

- Point 2 means some dangerous commands will pass the guard when they are written in an
  unusual way. The sandbox is what stops those (record 0061, point 2).
- The plan for the guard must show, for each hard line, a known-bad input that it stops.
- Issue #1349 holds the other half: a pull request must not merge with an unread review
  that asks for changes.
