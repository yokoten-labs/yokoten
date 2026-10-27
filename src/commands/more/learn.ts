// `yokoten learn` and `yokoten changelog`: what the project learned, and what it changed.

import { ghIn, readIncident, readLocalLogins, repoOf, repoPageOf } from '../../host/github/index.ts';
import { changelogProblemsScreen, changelogScreen, readChanges, releaseNotes, writeChanges } from '../../run/changelog.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { loadConfig } from '../../rules/config.ts';
import { loadMarks, NO_HOME } from '../../rules/privacy.ts';
import { draftLesson, draftScreen, draftWrittenScreen, exportedScreen, exportLesson, importedScreen, importLesson, importScreen, problemsScreen, shipScreen, upstreamDoneScreen, upstreamKeptScreen, upstreamListScreen, listNotes, makeNoteCleaner, NOTE_ID, type NotePlace, originParts, redactNote, removeNote, shipLesson, upstreamDir, writeDraft, writeLessonFiles, writeNote } from '../../run/learn.ts';
import { HOME_DIR, VERSION } from '../../setup/files.ts';
import { isSelf } from '../../setup/init.ts';
import { machineMarks, machineUserNames } from '../../setup/install.ts';
import { readOriginUrl } from '../../setup/plan.ts';
import { nextLine, screen, title } from '../../rules/text/screen.ts';
import { count, fail, field, type Invocation, parse, type Parsed, print, rootOf, usage } from '../shared.ts';

/**
 * A usage error for --upstream that repeats nothing typed (#392): a stray word or a note
 * that starts with `-` may be the very detail the note must not show.
 */
const upstreamUsage = (error: string): string =>
  error.startsWith('unexpected argument') ? 'give what happened as one argument, in quotes' : error.startsWith('unknown option') && !/^unknown option --[a-z][a-z-]*(?:\. Did you mean --[a-z-]+\?)?$/.test(error) ? 'a note cannot start with -' : error;

/** The project's GitHub page from its origin remote, or null off GitHub. */
const githubPage = (remote: string): string | null => {
  const repo = repoOf(remote);
  return repo === null ? null : repoPageOf(repo);
};

export function runChangelog(invocation: Invocation): number {
  const { cwd } = invocation;
  const options = parse('changelog', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const root = rootOf(cwd, invocation.env) ?? cwd;
  const notesFor = options.values['--notes'];
  if (notesFor !== undefined) {
    if (options.flags.has('--write')) return usage(invocation, '--notes only prints; it does not go with --write');
    const path = join(root, 'CHANGELOG.md');
    const notes = existsSync(path) ? releaseNotes(readFileSync(path, 'utf8'), notesFor.replace(/^v/, ''), githubPage(readOriginUrl(root, invocation.env))) : null;
    if (notes === null) {
      return fail(invocation, `CHANGELOG.md has no section for ${notesFor}`, 'run `yokoten changelog --write`, add its heading, then ask again');
    }
    invocation.stdout.write(notes);
    return 0;
  }
  const isWrite = options.flags.has('--write');
  const { changes, problems } = isWrite ? writeChanges(root) : readChanges(root);
  if (problems.length) {
    print(invocation, changelogProblemsScreen(problems), invocation.stderr);
    return 1;
  }
  print(invocation, changelogScreen(changes, isWrite));
  return 0;
}

export function runLearn(invocation: Invocation): number {
  const { args, cwd } = invocation;
  // A draft for review (#77), never a shipped check: it writes only with --write, and adds only.
  const options = parse('learn', args);
  if (typeof options === 'string') return usage(invocation, args.includes('--upstream') ? upstreamUsage(options) : options);
  const [reference] = options.positional;
  const exportId = options.values['--export'];
  const importFile = options.values['--import'];
  // A lesson leaves and enters as a small file, reviewed before it applies (#757).
  if (exportId !== undefined || importFile !== undefined) {
    if (exportId !== undefined && importFile !== undefined) return usage(invocation, '--export and --import do different things: give one');
    for (const option of ['--upstream', '--ship', '--list', '--done', '--area', '--fix']) {
      if (options.flags.has(option) || option in options.values) return usage(invocation, `${option} does not go with ${exportId !== undefined ? '--export' : '--import'}`);
    }
    if (reference !== undefined) return usage(invocation, `${exportId !== undefined ? '--export' : '--import'} takes the lesson by name, not as a second argument`);
    const root = rootOf(cwd, invocation.env) ?? cwd;
    if (exportId !== undefined) {
      if (options.flags.has('--write')) return usage(invocation, '--export writes only with --out <file>, never with --write');
      return runExport(invocation, root, exportId, options.values['--out']);
    }
    if ('--out' in options.values) return usage(invocation, '--out goes with --export, not with --import');
    return runImport(invocation, root, importFile, options.flags.has('--write'));
  }
  if ('--out' in options.values) return usage(invocation, '--out goes with --export');
  if (options.flags.has('--upstream')) return runUpstream(invocation, options);
  for (const option of ['--list', '--done', '--area', '--fix']) {
    if (options.flags.has(option) || option in options.values) return usage(invocation, `${option} goes with --upstream`);
  }
  const root = rootOf(cwd, invocation.env) ?? cwd;
  // A reviewed lesson ships in the kit (#147): doctor then runs it in every project.
  if (options.flags.has('--ship')) {
    if (options.flags.has('--write')) return usage(invocation, '--ship and --write are two steps: write the draft, review it, then ship it');
    if (reference === undefined) return usage(invocation, 'name the lesson to ship, by its id or its issue number');
    const shipped = shipLesson(root, reference, VERSION, invocation.env);
    if ('problems' in shipped) {
      print(invocation, problemsScreen('learn --ship', shipped.problems, 'nothing was moved', 'fix them, then run `yokoten learn --ship` again'), invocation.stderr);
      return 1;
    }
    print(invocation, shipScreen(shipped.lesson, VERSION));
    return 0;
  }
  if (reference === undefined) return usage(invocation, 'name an incident issue, by its number or its URL');
  const incident = readIncident(ghIn(root, invocation.env), reference);
  if (typeof incident === 'string') {
    return fail(invocation, incident, 'check the issue number and that gh is signed in, then run `yokoten learn <issue>` again');
  }
  const draft = draftLesson(incident);
  if (!options.flags.has('--write')) {
    // One screen by default; `--all` keeps every field and the files' text (issue #1027).
    print(invocation, options.flags.has('--all') ? draftScreen(incident, draft, reference) : learnScreen(incident, draft, reference));
    return 0;
  }
  print(invocation, draftWrittenScreen(incident, draft, writeDraft(root, draft)));
  return 0;
}

/**
 * The default screen of `yokoten learn` (issue #1027): the rule the check will hold, where
 * its files go, and the command that writes them. `--all` shows every field and the files.
 */
export function learnScreen(incident: { number: number }, draft: ReturnType<typeof draftLesson>, reference: string): string[] {
  return screen(
    title('learn', `a check draft from issue #${incident.number}`),
    [
      ...field('rule', draft.finding.what),
      ...draft.files.slice(0, 2).flatMap((file) => field('file', `${file.path} (not written yet)`)),
      ...(draft.files.length > 2 ? field('files', count(draft.files.length - 2, 'more file')) : []),
      ...(draft.todos.length ? field('open', `${count(draft.todos.length, 'field')} still to fill in, listed by \`--all\``) : []),
    ],
    nextLine(`yokoten learn ${reference} --write`),
  );
}

/** `learn --export`: a lesson as one small file, for another project. It writes only with --out. */
function runExport(invocation: Invocation, root: string, reference: string, out: string | undefined): number {
  const exported = exportLesson(root, reference, invocation.env);
  if ('problems' in exported) {
    print(invocation, problemsScreen('learn --export', exported.problems, 'nothing was written', 'fix them, then run `yokoten learn --export` again'), invocation.stderr);
    return 1;
  }
  const { pack, text } = exported;
  if (out === undefined) {
    // The file itself on stdout, so a person or a script can review it before it leaves.
    print(invocation, [text.trimEnd()]);
    return 0;
  }
  const path = isAbsolute(out) ? out : join(invocation.cwd, out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  print(invocation, exportedScreen(pack, out));
  return 0;
}

/** `learn --import`: a lesson file from another project, shown for review; --write adds it to lessons/. */
function runImport(invocation: Invocation, root: string, file: string, isWrite: boolean): number {
  const path = isAbsolute(file) ? file : join(invocation.cwd, file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return fail(invocation, `${file} could not be read: ${((err as Error).message ?? String(err)).split('\n')[0]}`, 'check the path, then run `yokoten learn --import <file>` again');
  }
  const imported = importLesson(text, invocation.env);
  if ('problems' in imported) {
    print(invocation, problemsScreen('learn --import', imported.problems, 'nothing was written', 'ask the lesson\'s author for a new file, then run `yokoten learn --import <file>` again'), invocation.stderr);
    return 1;
  }
  const { pack, files } = imported;
  if (!isWrite) {
    print(invocation, importScreen(pack, files, file));
    return 0;
  }
  print(invocation, importedScreen(pack, writeLessonFiles(root, files)));
  return 0;
}

/** What a note must not carry out of the project at hand (#392). Local git and files only, no network. */
function notePlace({ env, cwd }: Invocation, root: string | null, { withProject = true }: { withProject?: boolean } = {}): NotePlace {
  const found = machineMarks(env, { cwd: root ?? cwd });
  const owners = [
    ...found.filter((mark) => mark.kind === 'git name' || mark.kind === 'git email').map((mark) => mark.value),
    // The login gh keeps on this machine, read from its config file: gh's own lookup would call the network.
    ...readLocalLogins(env),
    // The Linux and Windows user names, which git and gh may not know (#404).
    ...machineUserNames(env),
  ];
  const hosts = found.filter((mark) => mark.kind === 'private remote host').map((mark) => mark.value);
  const projects: string[] = [];
  // In yokoten's own repo, "yokoten" is the subject of the note, not a detail to hide.
  if (withProject && root && !isSelf(root)) {
    projects.push(basename(root));
    try {
      const name: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
      if (typeof name === 'string') projects.push(name, name.replace(/^@[^/]+\//, ''));
    } catch {}
    const origin = originParts(readOriginUrl(root, env));
    owners.push(...origin.owners);
    if (origin.project) projects.push(origin.project);
  }
  return { root, projects, owners, hosts, marks: loadMarks(env), cwd };
}

/** The areas a note may name: yokoten's own, when this copy has its yokoten.json; else any lowercase word. */
function knownAreas(): string[] {
  return existsSync(join(HOME_DIR, 'yokoten.json')) ? loadConfig(HOME_DIR).areas : [];
}

/** `learn --upstream`: keep, list or remove a note for the yokoten repo (#392). It never calls the network. */
function runUpstream(invocation: Invocation, options: Parsed): number {
  const { env, cwd } = invocation;
  const [text] = options.positional;
  const inbox = upstreamDir(env);
  for (const option of ['--write', '--ship']) if (options.flags.has(option)) return usage(invocation, `--upstream and ${option} don't go together`);
  const isList = options.flags.has('--list');
  const isDone = options.flags.has('--done');
  if (isList || isDone) {
    for (const option of ['--area', '--fix']) if (option in options.values) return usage(invocation, `${option} goes with a new note, not with ${isList ? '--list' : '--done'}`);
  }
  if (isList) {
    if (text !== undefined || isDone) return usage(invocation, '--list takes nothing more');
    const notes = listNotes(env);
    // Cleaned again as they are shown: a file in the inbox may have been edited by hand.
    const clean = makeNoteCleaner(notePlace(invocation, rootOf(cwd, invocation.env), { withProject: false }), env);
    print(invocation, upstreamListScreen(notes.map((note) => ({ ...note, when: clean(note.when), part: clean(note.part), what: clean(note.what), ...(note.fix ? { fix: clean(note.fix) } : {}) }))));
    return 0;
  }
  if (isDone) {
    if (text === undefined) return usage(invocation, 'name the note to remove, by its id from --list');
    // The argument is never repeated back: it may be anything that was typed.
    if (!NOTE_ID.test(text)) return usage(invocation, 'that is not a note id; see the ids with `yokoten learn --upstream --list`');
    if (!removeNote(env, text)) {
      return fail(invocation, 'there is no note with that id', 'yokoten learn --upstream --list');
    }
    print(invocation, upstreamDoneScreen(text));
    return 0;
  }
  if (text === undefined || !text.trim()) return usage(invocation, 'say what happened, in a few words: yokoten learn --upstream "<what happened>"');
  if (!inbox) {
    return fail(invocation, `the note was not kept, because ${NO_HOME}`, 'set HOME to your home folder, then run `yokoten learn --upstream` again');
  }
  const area = options.values['--area'];
  if (area !== undefined) {
    const areas = knownAreas();
    if (areas.length ? !areas.includes(area) : !/^[a-z][a-z0-9-]*$/.test(area)) return usage(invocation, areas.length ? `--area is one of: ${areas.join(', ')}` : '--area is one lowercase word, such as hook');
  }
  const place = notePlace(invocation, rootOf(cwd, invocation.env));
  const what = redactNote(text, place, env);
  const fixIdea = options.values['--fix'] === undefined ? undefined : redactNote(options.values['--fix'], place, env);
  const part = area === undefined ? undefined : redactNote(area, place, env);
  const problems = [what, fixIdea, part].flatMap((field) => (field && 'problems' in field ? field.problems : []));
  if (problems.length || !('text' in what)) {
    // The kind of detail only: the value itself is never printed (core rule 11).
    const kinds = [...new Set(problems.map((problem) => (problem.id === 'private-mark' ? 'a line of your private-marks file' : problem.what)))];
    return fail(invocation, `the note was not kept, because it holds ${kinds.join(' and ')}`, 'say what happened without it, and run `yokoten learn --upstream "<what happened>"` again');
  }
  const fix = fixIdea && 'text' in fixIdea && fixIdea.text ? fixIdea.text : undefined;
  const note = writeNote(env, { part: part && 'text' in part ? part.text : 'unknown', what: what.text, ...(fix ? { fix } : {}) });
  print(invocation, upstreamKeptScreen(note, inbox));
  return 0;
}
