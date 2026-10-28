# Set up yokoten in this project

You are an AI coding agent. The user asked you to set up yokoten in the project you are
working in. yokoten is a free command-line tool: it guards AI coding agents (a hook stops
risky commands before they run, a commit check catches personal data and secrets) and
walks the user along the road good software teams use, one stage at a time.

Source: https://github.com/yokoten-labs/yokoten. Full guide: https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md

Follow these steps in order. Explain each step to the user in plain words, in their language,
before you run it. Stop and ask when something fails or looks unexpected.

## 1. Check Node

Run:

```sh
node --version
```

yokoten needs Node 22.23.4, 24.22.1 or 26.12.1 (or a newer 22, 24 or 26 release). Older releases have security holes that Node fixed on October 21, 2026, so don’t use them. It has no other dependencies and no build step.
If Node is missing or older, stop. Tell the user, and point them to https://nodejs.org/.
Do not install or upgrade Node without asking.

## 2. Set it up (one command)

From the root of this project:

```sh
npx yokoten
```

`npx` comes with Node and downloads yokoten from npm. The command does only what is
still missing, so it is safe to run again:

- If yokoten is not on this computer yet, it installs it once. With the yokoten Claude Code
  plugin on, the plugin brings the skills and hooks, so install adds no second copy, and it
  takes back the copies an older install put in the home folder.
- If this project has no yokoten rules yet, it adds them. It only adds files: a file that is
  already there stays, and the report says so. It copies the runtime into `.yokoten/` and
  adds rules (`AGENTS.md`), the commit check, the tool-call hook, CI, issue and pull request
  templates, Dependabot and a security policy.
- It ends with the road: five stages (safety net, issues and pull requests, release, a team
  of agents, going public), each step marked done, next, to do, not now, or can't check.

Read the report and summarise it for the user. To see the road again later, run
`npx yokoten doctor`.

## 3. Tell the user the next step

In plain words, in the user's language, tell them:

- which stage the project is at,
- the one next step `doctor` names, and why it matters,
- that you can do it as-is, do a lighter version, or leave it for now (with a reason).

One step at a time. Do not list everything at once.

## 4. Ask before committing

The setup added new files. Do not commit them yourself. Show the user what changed
(`git status`) and ask whether to commit. The `.yokoten/` folder should be committed, so
the hooks and CI run with no network and no global install. If the user agrees, commit
with a clear message, for example `chore: set up yokoten`.

## Rules while you do this

- Never push, force-push, create tags or releases. Only the user does that.
- Never skip the commit check (`--no-verify`).
- Never print personal data or secrets that a check finds. Name the file and line only.
- If a guard stops a command, read the reason and tell the user. Do not try to get around it.
