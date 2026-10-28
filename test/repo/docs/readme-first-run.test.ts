// The first-run screen shown in the README and its three translations is the screen the
// first run prints (#1145). A change to the screen fails here until the four blocks are
// regenerated; the version is normalized on both sides so a release bump never breaks it.
import '../home.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox, ROOT } from '../helpers.ts';

const READMES = ['README.md', 'docs/i18n/zh-CN/README.md', 'docs/i18n/zh-TW/README.md', 'docs/i18n/ja/README.md'];

const withoutVersion = (text: string): string => text.replace(/^yokoten \d+\.\d+\.\d+/, 'yokoten VERSION').trimEnd();

/** The text block after the "The first run" comment. */
function firstRunBlock(readme: string): string {
  const found = /<!-- The first run[^\n]*-->\n```text\n([\s\S]*?)\n```/.exec(readme);
  assert.ok(found, 'the README has the first-run block under its comment');
  return found[1];
}

test('readme: the first-run block of every README is the screen the first run prints (#1145)', async () => {
  const result = await makeSandbox().call([]);
  const screen = withoutVersion(result.output);
  assert.match(screen, /^yokoten VERSION · /, `the first run prints its header: ${screen}`);
  for (const file of READMES) {
    const block = withoutVersion(firstRunBlock(readFileSync(join(ROOT, file), 'utf8')));
    assert.equal(block, screen, `${file}: regenerate the first-run block from the first run`);
  }
});
