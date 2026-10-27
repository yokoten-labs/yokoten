// `yokoten trust` and `update`: keep what init wrote, and bring the core rules up to date.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { trust, undoTrust, updateCoreRules } from '../../../setup/init.ts';
import { count, type Invocation, nextLine, parse, print, requireRoot, row, title, usage, wrap } from '../../shared.ts';
import { isAtTerminal } from './ask.ts';

export function runTrust(invocation: Invocation): number {
  const options = parse('trust', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  // A person turns the guard on (#661): a pipe, a hook or CI has nobody to decide, and an
  // agent that ran the command would change the trust in its user's own settings.
  if (!isAtTerminal(invocation)) {
    print(invocation, [...title('trust', 'a person runs this at a terminal; nothing was written'), '', ...row('note', 'it changes the trust in your own agent settings, so a person decides'), '', ...nextLine('yokoten trust')], invocation.stderr);
    return 1;
  }
  const dir = resolve(invocation.cwd, options.positional[0] ?? '.');
  if (!existsSync(dir)) {
    print(invocation, [`yokoten trust: ${options.positional[0]} does not exist; nothing was written.`], invocation.stderr);
    return 1;
  }
  const root = requireRoot(invocation, dir);
  if (!root) return 1;
  const isUndo = options.flags.has('--undo');
  const done = isUndo ? undoTrust(root, invocation.env) : trust(root, invocation.env);
  print(invocation, trustScreen(done.lines, isUndo));
  return done.ok ? 0 : 1;
}

/** The one screen `yokoten trust` shows: each agent, then the way back (#1027). */
function trustScreen(lines: string[], isUndo: boolean): string[] {
  const names = lines.map((line) => /^(?:turned on yokoten's guard in|removed the trust yokoten added in) (.+?)(?: \(|$)/.exec(line)?.[1]).filter((name): name is string => name !== undefined);
  const already = lines.flatMap((line) => /^yokoten's guard is already on in (.+)$/.exec(line)?.[1]?.split(/, | and /) ?? []);
  const problems = lines.filter((line) => !/^(turned on yokoten's guard in|removed the trust yokoten added in|yokoten's guard is already on in|undo: |no agent installed here|nothing to undo)/.test(line));
  const counted = names.length + already.length;
  if (!counted && !problems.length) return title('trust', 'no agent here needs a change');
  const summary = isUndo ? 'the guard is off again in the agents here' : `the guard now runs in ${counted} ${counted === 1 ? 'agent' : 'agents'} here`;
  const out = title('trust', counted ? summary : 'no agent here needs a change');
  out.push('');
  for (const name of names) out.push(...row('ok', isUndo ? 'this folder is no longer trusted' : 'this folder is trusted', name));
  for (const name of already) out.push(...row('ok', 'this folder is already trusted', name));
  // R5: a refusal or a problem is never folded away.
  if (problems.length) {
    if (counted) out.push('');
    for (const line of problems) out.push(...row(/^(left the trust|kept your choice)/.test(line) ? 'note' : 'MISSING', line));
  }
  out.push('');
  out.push(isUndo ? 'To turn it on again: `yokoten trust`' : 'Undo: `yokoten trust --undo`');
  return out;
}

export function runUpdate(invocation: Invocation): number {
  // Its own command, not an init flag: init promises to add only, never to overwrite (#120).
  const options = parse('update', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const dir = resolve(invocation.cwd, options.positional[0] ?? '.');
  if (!existsSync(dir)) {
    print(invocation, [`yokoten update: ${options.positional[0]} does not exist; nothing to update.`], invocation.stderr);
    return 1;
  }
  const root = requireRoot(invocation, dir);
  if (!root) return 1;
  const isWrite = options.flags.has('--write');
  const { ok, lines } = updateCoreRules(root, { write: isWrite }, invocation.env);
  // --all keeps the whole preview, line by line, for the person who reads it before --write.
  const screen = options.flags.has('--all') ? [`yokoten update: ${lines[0]}`, ...lines.slice(1)] : updateScreen({ ok, lines, isWrite });
  print(invocation, screen, ok ? invocation.stdout : invocation.stderr);
  return ok ? 0 : 1;
}

/** The core rule a diff line belongs to, from the rules table; null for any other line. */
const ruleOf = (line: string): string | null => /^\| (\d+) \|/.exec(line.trim())?.[1] ?? null;

/**
 * The default screen of `yokoten update` (issue #1027): how many core rules changed, one row
 * per rule, and the note that the project's own part stays. A problem is never folded (R5).
 */
export function updateScreen({ ok, lines, isWrite }: { ok: boolean; lines: string[]; isWrite: boolean }): string[] {
  const [first = '', ...rest] = lines;
  // Nothing to do: one line (R8).
  if (/are up to date/.test(first)) return title('update', 'the core rules are up to date, nothing changed');
  // A refusal says why, then its fix on a last line of its own (R5, rule fix-line of #1115).
  if (!ok) {
    const fix = /^(.*?)\.?\s+Run (`[^`]+`)/.exec(first);
    if (fix === null) return [...title('update', 'nothing changed'), '', ...row('MISSING', first)];
    return [...title('update', 'nothing changed'), '', ...row('MISSING', fix[1] ?? first), ...wrap(' '.repeat(14), `Fix: ${fix[2]}`)];
  }
  if (isWrite) {
    const kept = /kept as (\S+?);/.exec(first)?.[1];
    return [
      ...title('update', "the core rules in AGENTS.md are this version's now"),
      '',
      ...row('ok', 'AGENTS.md, the core rules', 'rules'),
      ...(kept === undefined ? [] : row('note', `the file before it is kept as ${kept}`, 'backup')),
    ];
  }
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const line of rest) {
    const change = /^([+-]) (.*)$/.exec(line);
    const rule = change?.[2] === undefined ? null : ruleOf(change[2]);
    if (!change || rule === null) continue;
    (change[1] === '+' ? added : removed).add(rule);
  }
  const rules = [...new Set([...added, ...removed])].sort((a, b) => Number(a) - Number(b));
  if (!rules.length) {
    return [...title('update', 'the core rules changed upstream'), '', ...row('note', 'the change is outside the rules table; `yokoten update --write` writes it'), '', ...nextLine('yokoten update --write')];
  }
  const rows = rules.flatMap((rule) => row('next', added.has(rule) && removed.has(rule) ? 'wording changed' : added.has(rule) ? 'new' : 'removed', `rule ${rule}`));
  return [
    ...title('update', `${count(rules.length, 'core rule')} changed upstream`),
    '',
    ...rows,
    '  Your "This project" part stays as it is.',
    '',
    ...nextLine('yokoten update --write'),
  ];
}

