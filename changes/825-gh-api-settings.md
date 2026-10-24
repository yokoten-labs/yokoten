Security

An agent can read with `gh api` but cannot change repository or organization settings with it.
That covers the repo's visibility and default branch, branch protection and rulesets, who reaches the code, CI secrets and runners, an environment, and an organization. Actions, Dependabot and Codespaces secrets count as CI secrets. A `gh api graphql` mutation is refused too, wherever it sits in the document. The release check refuses any document with the word `mutation`, so post a comment with `gh pr comment` or the REST route. A document the guard cannot read is refused as well, and so is any `$` in it. The owner makes the change (#825).
