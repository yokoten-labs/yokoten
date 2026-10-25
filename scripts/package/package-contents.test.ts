// The package guard for the docs site (#631): website/ reaches no user.
// The real guard runs in scripts/check-package.ts, which needs `npm ci` first;
// this file holds the allow list itself, with a known-bad positive control.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PACKAGE_PATHS, packageViolations, readPackageFiles } from './package-contents.ts';

test('package contents: the allow list holds every path, and nothing more', () => {
  assert.deepEqual([...PACKAGE_PATHS].sort(), ['LICENSE', 'README.md', 'bin', 'dist', 'kit', 'package.json', 'src'].sort());
});

// A positive control: a known-bad input gets caught.
test('package contents: a file under website/ would fail the guard (#631)', () => {
  const violations = packageViolations(['bin/main.ts', 'src/run/check.ts', 'website/src/content/docs/start.mdx']);
  assert.ok(violations.includes('website/src/content/docs/start.mdx'), 'the guard missed the website/ file');
  assert.equal(violations.length, 1, 'the guard blamed allowed paths too');
});

test('package contents: every path the allow list names is clean', () => {
  assert.deepEqual(packageViolations([...PACKAGE_PATHS.map((top) => `${top}/x`), 'README.md', 'LICENSE', 'package.json']), []);
});

test('package contents: the JSON report of a pack is read past the npm banner', () => {
  const stdout = '> yokoten@0.1.1 prepack\n> node scripts/build.ts\n\n[\n  {\n    "files": [ { "path": "website/index.html" } ]\n  }\n]\n';
  assert.deepEqual(readPackageFiles(stdout), ['website/index.html']);
});

test('package contents: stdout without JSON fails with a clear name', () => {
  assert.throws(() => readPackageFiles('npm error code EPERM\n'), /no JSON/);
});
