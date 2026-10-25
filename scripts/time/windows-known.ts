// The Windows test job's list of known failures (record 0040, owner 2026-10-25). The whole
// suite first ran on native Windows before v0.1.1 and failed in about 170 tests, most of
// them test setup (POSIX paths, fake programs with no extension, a PATH joined with `:`).
// The job runs the suite with a TAP copy, and this compares its failures with the list:
//   - a failure that is not on the list fails the job: a new Windows bug;
//   - a list entry that passes now fails the job too, and names the line to remove, so the
//     list only gets shorter. A line that starts with `? ` may pass or fail (a flaky test).
//
//   node scripts/time/windows-known.ts <tap file>           compare with the list
//   node scripts/time/windows-known.ts <tap file> --write   write the list from this run
//
// An entry is `<test file> :: <test name>`, the file from `test/` on, with `/`.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const KNOWN_FILE = join(dirname(fileURLToPath(import.meta.url)), 'windows-known.txt');

const HEADER = [
  '# Tests known to fail on native Windows (scripts/time/windows-known.ts, record 0040).',
  '# Fix a test, then remove its line: the Windows job fails while a listed test passes.',
  '# `? ` before a line: the test may pass or fail.',
];

/** The test file from `test/` on, with `/`, from a TAP location such as `C:\a\test\x.test.ts:3:1`. */
export function testFileOf(location: string): string | null {
  const path = location.replace(/\\/g, '/').replace(/:\d+:\d+$/, '');
  const at = path.lastIndexOf('/test/');
  return at === -1 ? null : path.slice(at + 1);
}

/** Each failed top-level test in a TAP report of node --test, as `<file> :: <name>`, sorted, once each. */
export function readFailures(tap: string): string[] {
  const failures = new Set<string>();
  const lines = tap.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const failed = /^not ok \d+ - (.*?)(?: # .*)?$/.exec(lines[i]);
    if (!failed) continue;
    let file: string | null = null;
    // The YAML block under a failure holds its location, before the next test line.
    for (let j = i + 1; j < lines.length && !/^(?:not )?ok \d+ /.test(lines[j]); j++) {
      const at = /^\s+location: '(.*)'$/.exec(lines[j]);
      if (at) {
        file = testFileOf(at[1]);
        break;
      }
    }
    const name = failed[1].replace(/\\#/g, '#');
    failures.add(file === null ? name : `${file} :: ${name}`);
  }
  return [...failures].sort();
}

/** The list file's entries: required ones, and `? ` ones that may pass. */
export function readKnown(text: string): { required: string[]; flaky: string[] } {
  const required: string[] = [];
  const flaky: string[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim())) {
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('? ')) flaky.push(line.slice(2));
    else required.push(line);
  }
  return { required, flaky };
}

/** New failures (not on the list) and fixed ones (on the list, now passing). Both fail the job. */
export function judgeKnown(failures: string[], known: { required: string[]; flaky: string[] }): { added: string[]; fixed: string[] } {
  const failing = new Set(failures);
  const listed = new Set([...known.required, ...known.flaky]);
  return {
    added: failures.filter((f) => !listed.has(f)),
    fixed: known.required.filter((k) => !failing.has(k)),
  };
}

function main(): number {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { write: { type: 'boolean' } } });
  if (positionals.length !== 1) {
    process.stderr.write('usage: node scripts/time/windows-known.ts <tap file> [--write]\n');
    return 2;
  }
  const failures = readFailures(readFileSync(positionals[0], 'utf8'));
  if (values.write) {
    writeFileSync(KNOWN_FILE, `${[...HEADER, ...failures].join('\n')}\n`);
    process.stdout.write(`windows-known: wrote ${failures.length} entries to ${KNOWN_FILE}\n`);
    return 0;
  }
  const { added, fixed } = judgeKnown(failures, readKnown(readFileSync(KNOWN_FILE, 'utf8')));
  const lines = [`windows-known: ${failures.length} failing, ${added.length} new, ${fixed.length} fixed.`];
  if (added.length) lines.push('New failures on Windows. Fix them, or, for a test that cannot run there, skip it on win32 with the reason:', ...added.map((a) => `  ${a}`));
  if (fixed.length) lines.push('These pass now. Remove their lines from scripts/time/windows-known.txt:', ...fixed.map((f) => `  ${f}`));
  process.stdout.write(`${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Windows known failures\n\n${lines.join('\n')}\n`);
  return added.length || fixed.length ? 1 : 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = main();
