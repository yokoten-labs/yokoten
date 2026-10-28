// Reads the facts the site shows from the yokoten package, so the site never retypes them
// (site-content-refactor.md, "One source for facts"). Writes site/src/content/generated/facts/:
//   commands.json  the command table (COMMANDS in src/run/cli.ts): name, summary, group
//   rules.json     every rule (RULES in src/rules/text/message.ts): id, rule, why, check, guard
//   stages.json    the road (STAGES and ROAD in src/setup/road.ts, titles from STEP_TITLES)
//   agents.json    the agent table under "## Works with" in the README
//   screens.json   the screens, generated here by test/repo/docs/screens.test.ts with SCREENS_OUT=<tmp>;
//                  `ansi` is each one as a terminal shows it, coloured by the package's styleText
//   version.json   the version, and counts read from the repo (records, merged PRs, test files)
// and site/src/content/generated/docs/<doc>/<lang>.md:
//   docs/          the docs pages as Markdown: the README (start), docs/guide.md (guide) in each language
//                  the repo has, and road/en.md, the stages and their steps written out from stages.json
//
//   [YOKOTEN_SRC=<path to a yokoten repo>] [YOKOTEN_REF=<tag>] node tools/steps/from-package.mjs
//
// The package defaults to the yokoten repo this site lives in (web/site, record 0055). The facts are read from the
// newest release tag (v*) of that checkout, not from main, so the site never describes commands
// that npm does not have yet. YOKOTEN_REF names another tag; YOKOTEN_REF=working reads the
// checkout as it is (for a preview before a release). Screens: unless YOKOTEN_SCREENS names a capture,
// the script runs the package's screen test with SCREENS_OUT=<tmp> and reads the dump. A package whose test cannot dump (yokoten 0.1.1 and main today) falls back to YOKOTEN_SCREENS or the files kept, with a warning;
// the capture is in the same format (an array of { key, command, exit, text }). With no package at all, the files
// already here are kept. Either way the script fails when one of the six files is missing, and
// the site build runs it first, so the build fails too.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = join(root, 'site/src/content/generated');
/** The facts as JSON: generated/facts/<name>.json. */
const factsDir = join(out, 'facts');
const checkout = resolve(process.env.YOKOTEN_SRC || join(root, '../..'));
const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
/** The ref the facts come from: the newest release tag, unless YOKOTEN_REF says otherwise. */
const ref = process.env.YOKOTEN_REF === 'working' ? null : process.env.YOKOTEN_REF || (existsSync(join(checkout, '.git')) ? git('tag', '--list', 'v*', '--sort=-v:refname').split('\n')[0] || null : null);
const exported = ref ? mkdtempSync(join(tmpdir(), 'yokoten-release-')) : null;
if (ref) execFileSync('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', checkout, ref, exported]);
const src = exported ?? checkout;
const FILES = ['commands', 'rules', 'stages', 'agents', 'screens', 'version'];
/** The screens the pages show, by their key in the capture. */
const SCREEN_KEYS = ['first run', 'guard, force push', 'guard, wipe home', 'guard, tag push', 'session start'];

const write = (name, data) => writeFileSync(join(factsDir, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
const say = (line) => console.log(`from-package: ${line}`);
/** The first of these files that exists in the package: a file moved between releases. */
const load = (...rels) => {
  const rel = rels.find((r) => existsSync(join(src, r)));
  if (!rel) throw new Error(`the package has none of ${rels.join(', ')}`);
  return import(pathToFileURL(join(src, rel)).href);
};

/** A release before the shown/ALL_GROUPS split lists every command in COMMAND_GROUPS; its first three Start commands are the ones the home page shows. */
function commandsOfOldRelease(cli, start) {
  const key = (title) => title.toLowerCase();
  const first = cli.COMMAND_GROUPS[0];
  const home = new Set(first.names.slice(0, 3));
  const groupOf = (name) => cli.COMMAND_GROUPS.find((g) => g.names.includes(name));
  return {
    start,
    groups: [{ shown: 'always', title: 'Commands' }, ...cli.COMMAND_GROUPS.map((g) => ({ shown: key(g.title), title: g.title }))],
    commands: cli.COMMANDS.map((c) => {
      const group = groupOf(c.name);
      return { name: c.name, summary: c.summary, shown: home.has(c.name) ? 'always' : key(group?.title ?? 'other'), group: home.has(c.name) ? 'Commands' : group?.title ?? 'Other' };
    }),
  };
}

/** A release from 0.1.2 on: COMMAND_GROUPS names the jobs, and each command has its `group` and `shown` ('always' or 'all'). */
function commandsByJob(cli, start) {
  const key = (title) => title.toLowerCase();
  return {
    start,
    groups: [{ shown: 'always', title: 'Commands' }, ...cli.COMMAND_GROUPS.map((title) => ({ shown: key(title), title }))],
    commands: cli.COMMANDS.map((c) => {
      const always = c.shown === 'always';
      return { name: c.name, summary: c.summary, shown: always ? 'always' : key(c.group), group: always ? 'Commands' : c.group };
    }),
  };
}

function commands(cli) {
  const main = readFileSync(join(src, 'bin/main.ts'), 'utf8');
  const start = /'(Start here: [^']+)'/.exec(main)?.[1];
  if (!start) throw new Error('bin/main.ts has no "Start here" line');
  if (typeof cli.COMMAND_GROUPS?.[0] === 'string') return commandsByJob(cli, start);
  if (!cli.ALL_GROUPS) return commandsOfOldRelease(cli, start);
  const groups = { always: 'Commands' };
  for (const { title, shown } of cli.ALL_GROUPS) groups[shown] = title.replace(/\s*\(.*\)$/, '');
  return {
    start,
    groups: Object.entries(groups).map(([shown, title]) => ({ shown, title })),
    commands: cli.COMMANDS.map((c) => ({ name: c.name, summary: c.summary, shown: c.shown, group: groups[c.shown], ...(c.into ? { into: c.into } : {}) })),
  };
}

function rules(message) {
  return Object.entries(message.RULES).map(([id, r]) => ({ id, rule: r.rule, why: r.why, check: r.check, guard: /tool-call guard/.test(r.check) }));
}

async function stages() {
  const road = await load('src/setup/road.ts');
  const { STEP_TITLES } = await load('src/commands/more/advice/doctor.ts', 'src/commands/advice/doctor.ts');
  return road.STAGES.map((name, i) => ({
    number: i + 1,
    name,
    steps: road.ROAD.filter((s) => s.stage === i + 1).map((s) => ({ key: s.key, title: STEP_TITLES[s.key] ?? s.key, why: s.why })),
  }));
}

function agents() {
  const readme = readFileSync(join(src, 'README.md'), 'utf8');
  const section = readme.split(/^## /m).find((s) => s.startsWith('Works with'));
  if (!section) throw new Error('README.md has no "## Works with" section');
  const rows = section.split('\n').filter((l) => l.startsWith('|')).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  const [head, , ...body] = rows;
  if (!head || head[0] !== 'Agent') throw new Error('the "Works with" table no longer starts with an Agent column');
  return body.map(([agent, verified, trust]) => ({ agent: agent.replace(/`/g, ''), verified: /yes/.test(verified), trustFirst: /^yes/.test(trust) }));
}

/** What the agent typed for each guard screen: GUARD_CALLS in the screen test. */
function guardCalls(test) {
  const block = /const GUARD_CALLS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(test)?.[1] ?? '';
  return Object.fromEntries([...block.matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map(([, name, command]) => [`guard, ${name}`, command]));
}

function screens() {
  const testFile = join(src, 'test/repo/docs/screens.test.ts');
  const test = existsSync(testFile) ? readFileSync(testFile, 'utf8') : '';
  let captured = null;
  // YOKOTEN_SCREENS (a capture someone made) wins; unset, the screens are generated here from the package's own screen test.
  if (!process.env.YOKOTEN_SCREENS && test.includes('SCREENS_OUT')) {
    const dir = mkdtempSync(join(tmpdir(), 'yokoten-screens-'));
    const file = join(dir, 'screens.json');
    // The dump is written before the test's own checks run, so a check that fails on this machine
    // (a screen's width, say) still leaves the screens; the build warns and goes on. No dump at all
    // keeps the screens from an earlier run, as for a package that cannot dump.
    let failed = false;
    try {
      execFileSync('nice', ['node', '--test', 'test/repo/docs/screens.test.ts'], { cwd: src, env: { ...process.env, SCREENS_OUT: file }, stdio: 'ignore', timeout: 300_000 });
    } catch {
      failed = true;
    }
    try {
      if (existsSync(file)) captured = JSON.parse(readFileSync(file, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (!captured) {
      say(`WARNING: test/repo/docs/screens.test.ts of yokoten ${ref ?? 'the working tree'} wrote no screens: screens.json is kept from an earlier run, and may not match this version`);
      return null;
    }
    say(`screens generated by test/repo/docs/screens.test.ts (SCREENS_OUT=<tmp> node --test) in yokoten ${ref ?? 'working tree'}${failed ? '; WARNING: the test failed on this machine, so check the screens' : ''}`);
  } else if (process.env.YOKOTEN_SCREENS) {
    captured = JSON.parse(readFileSync(process.env.YOKOTEN_SCREENS, 'utf8'));
    say('screens from YOKOTEN_SCREENS (this package\'s screen test cannot dump them yet)');
  } else {
    say(`WARNING: test/repo/docs/screens.test.ts of yokoten ${ref ?? 'the working tree'} has no SCREENS_OUT dump and YOKOTEN_SCREENS is not set: screens.json is kept from an earlier run, and may not match this version`);
    return null;
  }
  // The machine's own notes (its disk, say) are about the computer that ran the test, not about
  // yokoten: a screen on the site never shows them. The package's test should leave them out itself.
  const MACHINE = /\n\n(?:\x1b\[[0-9;]*m)*yokoten: the disk that holds this repo[\s\S]*?#machine-notes(?:\x1b\[[0-9;]*m)*/g;
  const raw = Array.isArray(captured) ? captured : captured.screens;
  const list = raw.map((s) => (s && typeof s === 'object' ? Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'string' ? v.replace(MACHINE, '') : v])) : s));
  const typed = { ...guardCalls(test), 'first run': 'npx yokoten', 'session start': 'yokoten doctor --session' };
  const picked = {};
  for (const key of SCREEN_KEYS) {
    const one = list.find((s) => s.key === key);
    if (!one) throw new Error(`the capture has no screen "${key}"`);
    picked[key] = { typed: typed[key] ?? one.command, exit: one.exit, text: one.text.replace(/\s+$/, '') };
  }
  return picked;
}

function version(pkg) {
  const records = readdirSync(join(src, 'docs/records')).filter((f) => /^\d{4}-.*\.md$/.test(f)).length;
  const subjects = git('log', '--format=%s', ref ?? 'HEAD').split('\n');
  const mergedPrs = subjects.filter((s) => /\(#\d+\)$/.test(s)).length;
  const testFiles = (function count(dir) {
    return readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(dir, e.name)) : e.name.endsWith('.test.ts') ? 1 : 0), 0);
  })(join(src, 'test'));
  return { version: pkg.version, node: pkg.engines?.node ?? null, license: pkg.license, records, mergedPrs, testFiles };
}

/**
 * The docs, from the same tree as the facts (the release tag on GitHub), so yokoten.app/docs and the
 * repo's docs never differ. Each doc in each language it has; a language without a translation gets
 * none, and the page shows the English one with a note. Writes generated/docs/<doc>.<lang>.md with the
 * source path and ref in the front matter; relative links point at the same file on GitHub.
 */
const DOCS = {
  start: { en: 'README.md', zh: 'docs/i18n/zh-CN/README.md', tw: 'docs/i18n/zh-TW/README.md', ja: 'docs/i18n/ja/README.md' },
  guide: { en: 'docs/guide.md', zh: 'docs/i18n/zh-CN/guide.md', tw: 'docs/i18n/zh-TW/guide.md', ja: 'docs/i18n/ja/guide.md' },
};
function docs() {
  const dir = join(out, 'docs');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const at = ref ?? 'main';
  const blob = (rel) => `https://github.com/yokoten-labs/yokoten/blob/${at}/${rel}`;
  const raw = (rel) => `https://raw.githubusercontent.com/yokoten-labs/yokoten/${at}/${rel}`;
  let n = 0;
  for (const [doc, langs] of Object.entries(DOCS)) {
    for (const [lang, rel] of Object.entries(langs)) {
      const file = join(src, rel);
      if (!existsSync(file)) continue;
      const base = dirname(rel);
      /** A link inside the doc: an anchor stays, a full URL stays, a path becomes the file on GitHub. */
      const fix = (target, image) => {
        if (/^(#|[a-z][a-z0-9+.-]*:)/i.test(target)) return target;
        const [path, hash = ''] = target.split('#');
        const full = join(base, path).replace(/\\/g, '/');
        return (image ? raw(full) : blob(full)) + (hash ? `#${hash}` : '');
      };
      let text = readFileSync(file, 'utf8').replace(/^<!--[\s\S]*?-->\s*/, '');
      text = text.replace(/(!?)\[([^\]\n]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (_, bang, label, target, title) => `${bang}[${label}](${fix(target, bang === '!')}${title})`);
      text = text.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/g, (_, a, target, b) => `${a}${fix(target, true)}${b}`);
      const title = /^#\s+(.+)$/m.exec(text)?.[1].trim() ?? doc;
      text = text.replace(/^#\s+.+\n+/m, '');
      const front = `---\ntitle: ${JSON.stringify(title)}\ndoc: ${doc}\nlang: ${lang}\nsource: ${JSON.stringify(blob(rel))}\nref: ${JSON.stringify(at)}\n---\n\n`;
      mkdirSync(join(dir, doc), { recursive: true });
      writeFileSync(join(dir, doc, `${lang}.md`), front + text);
      n++;
    }
  }
  return n;
}

/**
 * The road as a doc (generated/docs/road.en.md): every stage and every step, as the CLI words them, so
 * yokoten.app/docs/road lists them all while the /road page only counts them. English only: the step
 * names are what the CLI prints. The source is the file that holds the stages, at the same tag.
 */
function roadDoc(list) {
  const at = ref ?? 'main';
  const lines = [
    '---',
    `title: ${JSON.stringify('The yokoten road')}`,
    'doc: road',
    'lang: en',
    `source: ${JSON.stringify(`https://github.com/yokoten-labs/yokoten/blob/${at}/src/setup/road.ts`)}`,
    `ref: ${JSON.stringify(at)}`,
    '---',
    '',
    `Day one is the safety net. After that, yokoten walks a project through how good teams work, one step at a time: ${list.length} stages, ${list.reduce((n, st) => n + st.steps.length, 0)} steps. Each step is a check yokoten can run. \`yokoten\` shows the first one that isn't done, and you can say "not now" to any step.`,
    '',
  ];
  for (const st of list) {
    lines.push(`## Stage ${st.number}: ${st.name}`, '');
    for (const step of st.steps) lines.push(`- **${step.title}**: ${step.why}.`);
    lines.push('');
  }
  mkdirSync(join(out, 'docs', 'road'), { recursive: true });
  writeFileSync(join(out, 'docs', 'road', 'en.md'), lines.join('\n'));
}

mkdirSync(factsDir, { recursive: true });
if (existsSync(join(src, 'package.json'))) {
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  if (pkg.name !== 'yokoten') throw new Error('YOKOTEN_SRC is not the yokoten package');
  write('commands', commands(await load('src/run/cli.ts')));
  write('rules', rules(await load('src/rules/text/message.ts', 'src/rules/message.ts')));
  const roadStages = await stages();
  write('stages', roadStages);
  write('agents', agents());
  const picked = screens();
  if (picked) {
    // The colours a terminal shows, from the package's own styleText: the site and the video never retype them.
    const { styleText } = await load('src/commands/shared.ts');
    for (const one of Object.values(picked)) one.ansi = styleText(one.text, true, true);
    write('screens', picked);
  }
  write('version', version(pkg));
  const docCount = docs() + 1;
  roadDoc(roadStages);
  say(`facts of yokoten ${pkg.version} written (from ${ref ?? 'the working tree'}); screens ${picked ? 'written too' : 'kept'}; ${docCount} docs`);
} else {
  say('no yokoten package at YOKOTEN_SRC: the files already here are kept');
}
if (exported) rmSync(exported, { recursive: true, force: true });
const missing = FILES.filter((f) => !existsSync(join(factsDir, `${f}.json`)));
if (missing.length) {
  console.error(`from-package: missing ${missing.map((f) => `${f}.json`).join(', ')}; set YOKOTEN_SRC to the yokoten repo`);
  process.exit(1);
}
