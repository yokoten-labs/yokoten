---
title: "The yokoten road"
doc: road
lang: en
source: "https://github.com/yokoten-labs/yokoten/blob/v0.1.2/src/setup/road.ts"
ref: "v0.1.2"
---

Day one is the safety net. After that, yokoten walks a project through how good teams work, one step at a time: 5 stages, 26 steps. Each step is a check yokoten can run. `yokoten` shows the first one that isn't done, and you can say "not now" to any step.

## Stage 1: safety net

- **Write the rules for your agents (AGENTS.md)**: an agent follows the rules it can read, and only those.
- **Turn on the guard for your agents' commands**: the guard stops a risky command, like a force push, before the agent runs it.
- **Check each commit before it is made**: a secret or a personal email is hard to take back once a commit is pushed.
- **Add the yokoten runtime to the project**: the hooks and CI run this copy, so they work with no network and no global install.
- **Run your tests on every push**: tests that run on every push catch a broken change before it reaches main.

## Stage 2: issues and pull requests

- **Put the project on GitHub or Gitea**: the code host keeps a copy, so a lost machine does not lose the work.
- **Run the checks on every pull request**: a commit made with the hook off would reach main unchecked.
- **Turn on issues**: an issue has an owner, a state and a history; a todo file has none.
- **Add issue and pull request templates**: a template asks for what a reviewer needs, so nothing is forgotten.
- **Add the standard labels**: a label says what kind of change a pull request is, and the pull request check asks for one.
- **Add a first milestone**: a milestone says when a change ships, and the pull request check asks for one.
- **Keep build output out of git**: a build makes these files again from the source, and a reviewer can't read a binary.

## Stage 3: release

- **Keep a changelog**: each pull request adds its entry as it goes, so a release needs no digging.
- **Check pull request titles**: a pull request title becomes the commit on main, so it must say what changed and why.

## Stage 4: a team of agents

- **Name the owner (CODEOWNERS)**: the host then asks you to review a pull request that changes those paths, and `check --pr` makes it tier A.
- **Set up the bot account**: when the bot opens pull requests, you review work you did not write, as a team does.
- **Install the yokoten skills**: the skills show an agent how to hand off work, review it and find the cause of a failure.
- **Keep your agents in a sandbox**: a worker writes only where the sandbox allows, so it must cover the worktree.
- **Ask for a review before a merge**: the bot opens the pull requests, so you approve work you did not write, and nothing merges unread.

## Stage 5: going public

- **Add a license and a security policy**: people can then report a hole in private, old dependencies get updates, and others know how they may use the code.
- **Protect the main branch**: the guards catch an agent's mistakes, but only the server stops a push that gets past them.
- **Set the merge settings**: one pull request becomes one commit on main, and no merged branch is left behind.
- **Turn on the security settings**: the host then stops a pushed secret, and people can report a hole in private.
- **Let only you create release tags**: a tag that nobody can push blocks a release, and a bot on the list can push one.
- **Approve each release yourself**: without it, a publish job that a tag starts runs without anyone approving it.
- **Limit releases to version tags**: a branch rule named v* matches no tag, and with both rules a branch named v* can still publish.
