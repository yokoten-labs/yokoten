// The checks that prove doctor catches known-bad input. They run first, so a check
// that passes everything cannot look like a healthy project.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { checkCommand, checkEdit } from '../../rules/guards/index.ts';
import { DEFAULTS } from '../../rules/config.ts';
import { checkBuildOutput, checkCodeOwners, checkLayout } from '../../rules/layout.ts';
import { notUtc, POSITIVE_CONTROL, scanText } from '../../rules/privacy.ts';
import { SECRET_CONTROL } from '../../rules/privacy/secrets.ts';
import { judge } from '../../run/hook.ts';
import { isPathInside } from '../../platform/paths.ts';
import { readToolCall, sandboxProblem as claudeSandboxProblem, addUserHooks } from '../../agents/runtimes/claude-code.ts';
import { projectPluginPath, projectPluginSource } from '../../agents/runtimes/small/opencode.ts';
import { machineChecks, openCodePluginNote, type Practice } from './checks.ts';
import * as codex from '../../agents/runtimes/codex.ts';
import * as gemini from '../../agents/runtimes/gemini.ts';
import * as grok from '../../agents/runtimes/grok.ts';
import { hostGuardMisses } from '../../host/gh-commands.ts';
import { UNSAVED_CONTROL, unsavedNotes } from '../advice/unsaved.ts';
import { HOME_DIR, isNewerKitCopy, sealManaged, writeManaged } from '../files.ts';
import { USER_CLI, USER_MISSING } from '../install.ts';
import { compareCoreRules } from '../init.ts';
import { coreRulesControl, roadControl } from './lessons.ts';
import { leftoverControl, machineControl } from './machine.ts';

/** Makes a temp folder for a control from a name prefix: a parameter, so a test can hand in one that throws (#1108). */
export type MakeTemp = (prefix: string) => string;
export const makeTempDir: MakeTemp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

/**
 * What a control returns when it could not make its temp folder. Its check did not run,
 * which is not a check that let bad input through, so doctor says so in one line (#1108).
 */
export const NO_TEMP = 'no temp folder';

/**
 * The one line doctor prints for controls that found no temp folder (#1108): their checks
 * did not run, which is not a broken yokoten. The home folder in the path shows as `~`.
 */
export function noTempLine(unset: string[], temp: string, home: string | null, platform: NodeJS.Platform): string {
  // A trailing separator on the home folder is not part of its name; paths on Windows ignore letter case.
  const base = home?.replace(/[\\/]+$/, '');
  const shown = base && isPathInside(temp, base, platform) ? `~${temp.slice(base.length)}` : temp;
  return `yokoten: the self-test could not set up a temp folder, so the ${unset.join(' and ')} did not run; free space in the temp folder (${shown}), then run \`yokoten doctor\` again.`;
}

/** The checks that must catch a known-bad input. Returns the names of any that did not. */
export function selfTest(): string[] {
  return selfTestRun().failed;
}

/**
 * The self-test, with the controls that could not set up kept apart from the checks that
 * failed (#1108): `unset` names each control that found no temp folder to test in.
 */
export function selfTestRun(makeTemp: MakeTemp = makeTempDir): { failed: string[]; unset: string[] } {
  const failed: string[] = [];
  const unset: string[] = [];
  const control = (name: string, found: string[]): void => {
    if (found.includes(NO_TEMP)) unset.push(name);
    else failed.push(...found);
  };
  if (!checkCommand('git push origin --tags', { env: {}, cwd: null })) failed.push('release guard');
  failed.push(...hostGuardMisses((command) => checkCommand(command, { env: {}, cwd: null })));
  if (!checkCommand('git commit --no-verify -m x', { env: {}, cwd: null })) failed.push('skip-check guard');
  if (!checkEdit('test/a.test.ts', { config: DEFAULTS, env: { YOKOTEN_FIX_TASK: '1' } })) failed.push('test guard');
  if (!checkEdit('AGENTS.md', { config: DEFAULTS, env: { YOKOTEN_ROLE: 'worker' } })) failed.push('lead-only guard');
  if (!isShellControlCaught()) failed.push('lead-only shell guard');
  if (scanText(POSITIVE_CONTROL, { file: 'control' }).length < 2) failed.push('privacy check');
  if (scanText(SECRET_CONTROL, { file: 'control' }).length < 2) failed.push('secret check');
  if (!notUtc('A <a@example.com> 1760745600 +0700') || notUtc('A <a@example.com> 1760745600 +0000')) failed.push('time zone check');
  if (checkLayout(Array.from({ length: 8 }, (_, i) => `d/${i}`), DEFAULTS).length !== 1) failed.push('layout check');
  if (checkCodeOwners(['src/a.ts'], 'src/gone.ts @lead\n').length !== 1) failed.push('CODEOWNERS check');
  if (checkBuildOutput([{ path: 'dist/a.js', binary: false }, { path: 'a.bin', binary: true }], DEFAULTS).length !== 2) failed.push('build output check');
  if (!isUnsavedControlCaught()) failed.push('unsaved work check');
  failed.push(...roadControl());
  const kit = '# rules\n\n## This project\n';
  if (compareCoreRules('# old rules\n\n## This project\n', kit).state !== 'behind' || compareCoreRules('# rules\n', kit).state !== "can't compare") failed.push('core rules check');
  // A note must catch an edited file behind an older kit copy, and stay quiet on the same copy.
  const kitMark = '<!-- managed by yokoten; a test mark -->\n';
  const olderCopy = sealManaged(`${kitMark}old body\n`);
  if (!isNewerKitCopy(olderCopy, `${kitMark}new body\n`) || isNewerKitCopy(olderCopy, `${kitMark}old body\n`)) failed.push('edited kit note');
  failed.push(...coreRulesControl());
  failed.push(...machineControl());
  control('user guard check', guardControl(makeTemp));
  failed.push(...leftoverControl());
  failed.push(...sandboxControl());
  control('OpenCode plugin note', openCodeControl(makeTemp));
  return { failed, unset };
}

/**
 * A project with `opencode.json` and no plugin must be noted, and a project with the
 * plugin `init` writes must be quiet. A folder with no OpenCode file must be quiet too.
 */
export function openCodeControl(makeTemp: MakeTemp = makeTempDir, note: typeof openCodePluginNote = openCodePluginNote): string[] {
  let quiet = '';
  let marked = '';
  try {
    quiet = makeTemp('yokoten-opencode-quiet-');
    marked = makeTemp('yokoten-opencode-marked-');
  } catch {
    if (quiet) rmSync(quiet, { recursive: true, force: true });
    return [NO_TEMP];
  }
  try {
    const cli = '.yokoten/bin/yokoten.mjs';
    if (note(quiet, cli) !== null) return ['OpenCode plugin note'];
    writeFileSync(join(marked, 'opencode.json'), '{}\n');
    const found = note(marked, cli);
    if (!found || found.ok || found.finding.id !== 'opencode-hook') return ['OpenCode plugin note'];
    writeManaged(projectPluginPath(marked), projectPluginSource(cli));
    if (note(marked, cli) !== null) return ['OpenCode plugin note'];
    return [];
  } catch {
    return ['OpenCode plugin note'];
  } finally {
    if (quiet) rmSync(quiet, { recursive: true, force: true });
    if (marked) rmSync(marked, { recursive: true, force: true });
  }
}

/**
 * A machine whose Claude Code settings hold no guard, and whose plugin is off, must fail
 * the guard check. Install's own hook must pass it, and so must the plugin, which brings
 * the same guard (#904).
 */
export function guardControl(makeTemp: MakeTemp = makeTempDir, checks: typeof machineChecks = machineChecks): string[] {
  let dir = '';
  try {
    dir = makeTemp('yokoten-guard-');
  } catch {
    return [NO_TEMP];
  }
  try {
    const env = { HOME: dir };
    const file = join(dir, '.claude', 'settings.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{}\n');
    const guard = (): Practice | undefined => checks(env).find((check) => check.name === 'user-guard');
    if (guard()?.ok !== false || guard()?.finding.id !== 'user-guard') return ['user guard check'];
    addUserHooks(env, USER_CLI, USER_MISSING);
    if (guard()?.ok !== true) return ['user guard check (install\'s own hook passes)'];
    writeFileSync(file, JSON.stringify({ enabledPlugins: { 'yokoten@yokoten': true } }));
    if (guard()?.ok !== true) return ['user guard check (the plugin passes)'];
    return [];
  } catch {
    return ['user guard check'];
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * In a temp project with a too-wide sandbox per agent, each sandbox check must catch its
 * own, and a good set must pass, so the control can't go green by always complaining. The
 * checks are parameters so a test can hand in broken ones.
 */
export function sandboxControl(
  claudeProblem: typeof claudeSandboxProblem = claudeSandboxProblem,
  codexProblem: typeof codex.sandboxProblem = codex.sandboxProblem,
  geminiProblem: typeof gemini.sandboxProblem = gemini.sandboxProblem,
  grokProblem: typeof grok.sandboxProblem = grok.sandboxProblem,
): string[] {
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'yokoten-control-'));
    const failed: string[] = [];
    const env = { HOME: dir };
    const write = (rel: string, text: string) => {
      const path = join(dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    };
    write('.claude/settings.json', '{"sandbox": {"enabled": true, "network": {"allowedDomains": ["*"]}}}');
    write('.codex/config.toml', 'sandbox_mode = "danger-full-access"\napproval_policy = "on-request"\n\n[sandbox_workspace_write]\nnetwork_access = false\n');
    write('.gemini/settings.json', '{"security": {"disableYoloMode": false}}');
    write('.grok/sandbox.toml', '[profiles.yokoten]\nextends = "devbox"\n');
    if (!claudeProblem(dir)) failed.push('Claude Code sandbox check');
    if (!codexProblem(dir, env)) failed.push('Codex sandbox check');
    if (!geminiProblem(dir)) failed.push('Gemini CLI sandbox check');
    if (!grokProblem(dir, env)) failed.push('Grok sandbox check');
    write('.claude/settings.json', '{"sandbox": {"enabled": true}}');
    write('.codex/config.toml', 'sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n\n[sandbox_workspace_write]\nnetwork_access = false\n');
    write('.gemini/settings.json', '{"security": {"disableYoloMode": true}}');
    write('.grok/sandbox.toml', '[profiles.yokoten]\nextends = "workspace"\n');
    if (claudeProblem(dir) ?? codexProblem(dir, env) ?? geminiProblem(dir) ?? grokProblem(dir, env)) failed.push('sandbox check (a good set passes)');
    return failed;
  } catch {
    return []; // no temp folder to test in; the other checks still run
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A shell write to AGENTS.md from Claude Code's plugin worker, `yokoten:worker`, with no
 * YOKOTEN_ROLE (#402): the call must read as a worker's and be stopped, and the same call
 * from the lead must pass. The repo is the root of the file system yokoten runs from, taken
 * as given, and nothing is written.
 */
export function isShellControlCaught(): boolean {
  const root = parse(HOME_DIR).root;
  const call = (agentType?: string) => ({ agent_type: agentType, cwd: root, tool_input: { command: 'sed -i s/a/b/ AGENTS.md' } });
  const options = { root, config: DEFAULTS, env: {}, cwd: root };
  return judge(readToolCall(call('yokoten:worker')), options) !== null && judge(readToolCall(call()), options) === null;
}

/**
 * A clone with one of each kind of work only on this machine (#365), as facts: the notes
 * must name every kind, and say to delete no lock while doctor can't tell.
 */
export function isUnsavedControlCaught(notes: typeof unsavedNotes = unsavedNotes): boolean {
  const found = new Set(notes(UNSAVED_CONTROL, { home: undefined, now: 1 }).map((f) => f.id));
  const kinds = ['uncommitted-changes', 'unpushed-commits', 'stashes', 'stale-index-lock', 'repo-on-tmpfs', 'repo-in-temp-folder', 'finished-worktree', 'missing-worktree'];
  const unsure = notes({ ...UNSAVED_CONTROL, isGitRunning: null }, { home: undefined, now: 1 }).find((f) => f.id === 'stale-index-lock');
  return kinds.every((kind) => found.has(kind)) && !!unsure && !/\b(rm|del|delete)\b/.test(unsure.fix);
}
