Changed

The five safeguards hold in a repo with no `yokoten.json` too: the defaults stop the same
five things, so a project needs no `init` to be safe. Creating a tag, a hard reset and
making a repo public are stopped too. The guide says a worker cannot edit CI or the rules,
and the owner reviews a lead's change to them. A refusal reads in the four parts from
#707: title, why, do instead, more.

Every refusal keeps those four lines, and gains a fifth when the rule has words of its
own: `Tell the AI: "…"`, a sentence a person who reads no code can say back to the agent.
A worker says it to its lead instead, so a worker's refusal reads `Tell the lead:`. The
words fit the case. A tag, a package or a repo made public has a sentence of its own. So
does a download read before it runs, a key moved to an ignored file, and a project with no
`yokoten.json`. A rule with no words of its own gets one plain sentence, never a rule id
alone. The sentence speaks English or Simplified Chinese. It follows `YOKOTEN_LANG` or the
usual locale variables. The four lines, the board's parser and every reader of an older
refusal keep working (#816).
