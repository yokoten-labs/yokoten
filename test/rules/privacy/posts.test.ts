// Tests for src/rules/privacy/posts.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPosting, postKind, unreadPost } from '../../../src/rules/privacy/posts.ts';

test('unreadPost: each form outside the allowlist is named, and a known form is not (#1104)', () => {
  // [the words after gh, what the reason says, or null for a known form]
  const cases: [string[], RegExp | null][] = [
    [['pr', 'create', '-dt', 'a title'], /joins short options/],
    [['pr', 'close', '3', '-dc', 'a note'], /joins short options/],
    [['release', 'create', 'v1', '-dn', 'notes'], /joins short options/],
    [['pr', 'create', '-dF', 'n.md'], /joins short options/],
    [['pr', 'review', '3', '-cb', 'a note'], /joins short options/],
    [['gist', 'create', 'n.md'], /gh gist create/],
    [['gist', 'new', 'n.md'], /gh gist new/],
    [['release', 'upload', 'v1', 'a.zip'], /gh release upload/],
    [['release', 'create', 'v1', 'a.zip'], /uploads files/],
    [['release', 'create', 'v1', '--notes-file', 'n.md', 'a.zip'], /uploads files/],
    [['release', 'create', 'v1', '--asset-dir', 'x'], /does not know the option --asset-dir/],
    // gh reads each word after `--` as a file to upload.
    [['release', 'create', 'v1', '-F', 'n.md', '--', 'secret.txt'], /uploads files/],
    [['release', 'new', 'v1', '--', '--draft'], /uploads files/],
    [['issue', 'create', '--recover', 'n.md'], /--recover/],
    [['pr', 'create', '--recover=n.md'], /--recover/],
    // Known forms: spelled out, joined to its own value, after `--`, or a value that starts with -R.
    [['pr', 'create', '-d', '-t', 'a title', '-F', 'n.md'], null],
    [['pr', 'create', '-tTitle', '-Fn.md'], null],
    [['pr', 'close', '3', '-c', 'a note', '-d'], null],
    [['pr', 'close', '3', '-cnote'], null],
    [['issue', 'comment', '3', '-Rme/repo', '-F', 'n.md'], null],
    [['issue', 'comment', '3', '--body-file', 'n.md', '--', '-dt'], null],
    [['release', 'create', 'v1', '--notes-file', 'n.md', '--draft', '--latest=false', '-t', 'v1'], null],
    [['release', 'create', 'v1', '-Fn.md', '--help'], null],
    [['release', 'create', '-F', 'n.md', '--', 'v1'], null],
    [['api', 'repos/me/repo/issues', '-dt'], null],
    [['pr', 'list', '-dt'], null],
  ];
  for (const [args, reason] of cases) {
    const unread = unreadPost(args);
    if (reason === null) assert.equal(unread, null, args.join(' '));
    else {
      assert.match(unread?.what ?? '', reason, args.join(' '));
      assert.ok(unread?.fix, `a fix: ${args.join(' ')}`);
    }
  }
});

test('postKind and isPosting: the forms the checks read, and the posts they refuse (#1104)', () => {
  assert.deepEqual(postKind(['-R', 'me/repo', 'issue', 'comment', '3']), { group: 'issue', sub: 'comment', isApi: false });
  assert.equal(postKind(['api', 'graphql'])?.isApi, true);
  assert.equal(postKind(['gist', 'create', 'n.md']), null);
  assert.equal(postKind(['pr', 'list']), null);
  assert.equal(isPosting(['gist', 'create', 'n.md']), true);
  assert.equal(isPosting(['issue', 'comment', '3']), true);
  assert.equal(isPosting(['pr', 'list']), false);
  assert.equal(isPosting([]), false);
});
