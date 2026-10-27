// Tests for src/host/gh-commands.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostGuardMisses, hostRunRemoval, isPublishingApiCall } from '../../src/host/gh-commands.ts';
import { checkCommand, commandWords } from '../../src/rules/guards/index.ts';

// The words of the `gh` command. A command substitution puts the substitution's own words
// first, so find the host command rather than take the first (#865).
const wordsOf = (command: string): string[] =>
  commandWords(command).find((words) => words[0] === 'gh') ?? commandWords(command)[0] ?? [];
const pathWhat = 'this `gh api` call takes its path from the shell, so the run is not clear';

test('host routes: cancel, delete, logs and an open variable, in any case (#650)', () => {
  const found = (command: string) => hostRunRemoval(wordsOf(command));
  assert.match(found('gh api -X POST repos/o/r/actions/runs/1/cancel')?.what ?? '', /cancels an Actions run/);
  assert.match(found('gh api -X DELETE REPOS/o/r/Actions/Runs/1')?.what ?? '', /deletes an Actions run/);
  assert.match(found('gh api -X DELETE repositories/9/actions/jobs/4/logs')?.what ?? '', /deletes an Actions log/);
  assert.equal(found('gh api -X DELETE repos/$URL')?.what, pathWhat);
  assert.equal(found('gh api -X POST repositories/$ID')?.what, pathWhat);
  assert.equal(found('gh api -X DELETE repos/$URL/actions/runs/1')?.what, 'this `gh api` call deletes an Actions run');
  assert.equal(found('gh api -X GET repos/$URL'), undefined);
  assert.equal(found('gh api -X POST repos/$OWNER/$REPO'), undefined);
  assert.equal(found('gh run list'), undefined);
});

test('host routes: a workflow turned off through the api, for the lead and the worker (#956)', () => {
  const lead = {};
  const worker = { YOKOTEN_ROLE: 'worker' };
  const off = [
    'gh workflow disable ci.yml',
    'gh api -X PUT repos/o/r/actions/workflows/ci.yml/disable',
    'gh api -X PUT repositories/9/actions/workflows/123/disable',
    'gh api -X PUT repos/$OWNER/$REPO/actions/workflows/ci.yml/disable',
    'gh api -X PUT "repos/o/r/actions/workflows/ci.yml/disable"',
    'gh api -X PUT https://api.github.com/repos/o/r/actions/workflows/ci.yml/disable',
    'gh api -XPUT Repos/o/r/Actions/Workflows/ci.yml/Disable',
    'gh api repos/o/r/actions/workflows/ci.yml/disable -f f=v',
  ];
  for (const env of [lead, worker]) {
    for (const command of off) {
      const found = checkCommand(command, { cwd: process.cwd(), env });
      assert.equal(found?.id, 'workflow-disable', command);
      assert.match(found?.what ?? '', /turns a workflow off/, command);
    }
    // A read of the workflows and turning one on pass for the lead. For a worker, a read
    // passes too: the worker's own send rule, not this one, refuses a write such as enable.
    const allowed = [
      'gh api repos/o/r/actions/workflows',
      'gh api -X GET repos/o/r/actions/workflows/ci.yml/disable',
      'gh workflow list',
    ];
    const allowedLead = [...allowed, 'gh api -X PUT repos/o/r/actions/workflows/ci.yml/enable', 'gh api -X PUT repositories/9/actions/workflows/123/enable'];
    for (const command of env === lead ? allowedLead : allowed) {
      assert.equal(checkCommand(command, { cwd: process.cwd(), env }), null, command);
    }
  }
});

test('host commands: an open variable path and extension exec or browse are refused (#650)', () => {
  const lead = {};
  const worker = { YOKOTEN_ROLE: 'worker' };
  const extensionFix = 'ask the owner to change extensions by hand';
  const open = [
    'gh api -X DELETE repos/$URL',
    'gh api -X POST repositories/$ID',
    'gh api -X DELETE "repos/$URL"',
    'gh api -X DELETE repos/$URL/',
    'gh api -X DELETE https://api.github.com/repos/$URL',
    'gh api repos/$URL -f a=b',
    'gh api -X POST repositories/${ID}',
  ];
  for (const env of [lead, worker]) {
    for (const command of open) {
      const found = checkCommand(command, { cwd: process.cwd(), env });
      assert.equal(found?.id, 'run-remove', command);
      assert.equal(found?.what, pathWhat, command);
    }
    assert.equal(checkCommand('gh api -X GET repos/$URL', { cwd: process.cwd(), env }), null);
    assert.equal(checkCommand('gh api -X GET repositories/$ID', { cwd: process.cwd(), env }), null);
    assert.equal(checkCommand('gh api repos/$URL', { cwd: process.cwd(), env }), null);
    // A `$` outside the owner/repo slot is still refused, including an issue comment.
    assert.equal(checkCommand('gh api -X POST repos/o/r/issues/$N/comments', { cwd: process.cwd(), env })?.id, 'run-remove');
    assert.equal(checkCommand('gh api -X GET repos/o/r/issues/$N/comments', { cwd: process.cwd(), env }), null);
    // A harmless short-option cluster is still refused.
    assert.equal(checkCommand('gh api -sv user', { cwd: process.cwd(), env })?.id, 'run-remove');
    assert.equal(checkCommand('gh extension list', { cwd: process.cwd(), env }), null);
    assert.equal(checkCommand('gh extension', { cwd: process.cwd(), env }), null);
    for (const command of ['gh extension exec demo', 'gh extension browse', 'gh extension --force browse']) {
      const found = checkCommand(command, { cwd: process.cwd(), env });
      assert.equal(found?.id, 'alias', command);
      assert.match(found?.what ?? '', command.includes('exec') ? /`gh extension exec`/ : /`gh extension browse`/, command);
      assert.equal(found?.fix, extensionFix, command);
    }
  }
  // A variable only in the owner/repo slot is not an open path. The lead may write. A worker may not.
  assert.equal(checkCommand('gh api -X POST repos/$OWNER/$REPO/issues', { cwd: process.cwd(), env: lead }), null);
  assert.equal(checkCommand('gh api -X POST repos/$OWNER/$REPO/issues', { cwd: process.cwd(), env: worker })?.id, 'worker-push');
});

test('repo settings: a gh api write is refused, a read passes (#825)', () => {
  const lead = {};
  const worker = { YOKOTEN_ROLE: 'worker' };
  const what = 'this `gh api` call changes repository or organization settings';
  const fix = 'ask the owner, who changes repository and organization settings in the browser';
  const refused = [
    // Visibility and the default branch are settings on the repo itself.
    'gh api -X PATCH repos/o/r -f visibility=public',
    'gh api repos/o/r -f visibility=public',
    'gh api --method PATCH repos/o/r -F default_branch=main',
    'gh api -XPATCH https://api.github.com/repos/o/r --input repo.json',
    'gh api -X PATCH /api/v3/repos/o/r -f visibility=private',
    'gh api -X DELETE repos/o/r',
    'gh api -X PATCH repositories/9 -f visibility=public',
    // Branch protection, and the settings inside it.
    'gh api -X PUT repos/o/r/branches/main/protection -f enforce_admins=true',
    'gh api -X DELETE repos/o/r/branches/main/protection',
    'gh api -X PATCH repos/o/r/branches/release/2.0/protection/required_pull_request_reviews -f dismiss_stale_reviews=true',
    // Rulesets, on the repo and on the organization.
    'gh api -X POST repos/o/r/rulesets --input rules.json',
    'gh api -X PUT repos/o/r/rulesets/1 -f enforcement=active',
    'gh api -X POST orgs/o/rulesets -f name=x',
    // The other settings groups, and an organization.
    'gh api -X PUT repos/o/r/actions/permissions -f enabled=true',
    'gh api -X PUT repos/o/r/vulnerability-alerts',
    'gh api --method PATCH orgs/o -f default_repository_permission=read',
    'gh api -X POST orgs/o/teams -f name=x',
    // Who reaches the code, and what CI runs with.
    'gh api -X PUT repos/o/r/collaborators/x -f permission=admin',
    'gh api -X PUT repos/o/r/teams/dev -f permission=push',
    'gh api -X POST repos/o/r/invitations -f invitee_id=1',
    'gh api -X POST repos/o/r/keys -f title=deploy -f key=x',
    'gh api -X POST repos/o/r/hooks -f config[url]=https://example.com/hook',
    'gh api -X PUT repos/o/r/actions/secrets/TOKEN -f encrypted_value=x',
    'gh api -X PUT repos/o/r/dependabot/secrets/TOKEN -f encrypted_value=x',
    'gh api -X PUT repos/o/r/codespaces/secrets/TOKEN -f encrypted_value=x',
    'gh api -X PATCH repos/o/r/actions/variables/DEBUG -f value=1',
    'gh api -X POST repos/o/r/actions/runners/registration-token',
    'gh api -X PATCH repos/o/r/environments/release -f wait_timer=0',
    // Behind `yokoten bot`, and for a worker too.
    'yokoten bot -- gh api -X PATCH repos/o/r -f visibility=public',
  ];
  for (const command of refused) {
    const found = checkCommand(command, { cwd: process.cwd(), env: lead });
    assert.equal(found?.id, 'repo-settings', command);
    assert.equal(found?.what, what, command);
    assert.equal(found?.fix, fix, command);
  }
  for (const command of ['gh api -X PATCH repos/o/r -f visibility=public', 'gh api -X PUT repos/o/r/branches/main/protection']) {
    assert.equal(checkCommand(command, { cwd: process.cwd(), env: worker })?.id, 'repo-settings', command);
  }
});

test('repo settings: reads and the bot writes it needs pass (#825)', () => {
  const lead = {};
  const reads = [
    'gh api repos/o/r',
    'gh api repos/o/r/branches/main/protection',
    'gh api -X GET repos/o/r/rulesets',
    'gh api --method=GET orgs/o',
    'gh api repos/o/r/actions/permissions',
    'gh api -X GET repos/o/r/issues -f creator=x',
  ];
  for (const command of reads) assert.equal(checkCommand(command, { cwd: process.cwd(), env: lead }), null, command);
  const writes = [
    'gh api -X POST repos/o/r/issues/1/comments -f body=x',
    'gh api -X POST repos/o/r/labels -f name=bug -f color=ff0000',
    'gh api -X POST repos/o/r/pulls/1/reviews -f event=APPROVE -f body=ok',
    'gh api -X POST repos/o/r/issues -f title=x',
    'gh api -X PATCH repos/o/r/issues/1 -f state=closed',
    'gh api -X PUT repos/o/r/pulls/1/merge -f merge_method=squash',
    'gh api --method POST repos/o/r/milestones -f title=v1',
  ];
  for (const command of writes) assert.equal(checkCommand(command, { cwd: process.cwd(), env: lead }), null, command);
});

test('repo settings: a graphql mutation is a settings write, a query passes (#825)', () => {
  const lead = {};
  const what = 'this `gh api graphql` call sends a mutation, which can change repository or organization settings';
  const refused = [
    'gh api graphql -f query=mutation { changeVisibility(input: {visibility: PUBLIC}) { clientMutationId } }',
    'gh api -X POST /graphql -f query=mutation{ updateRepository(input: {}) { clientMutationId } }',
    'gh api graphql -f query=mutation { x }',
    // A comment is the bot's own write, unless the same mutation does more.
    "gh api graphql -f query='mutation { addComment(input: {body: x}) { clientMutationId } changeVisibility(input: {visibility: PUBLIC}) { clientMutationId } }'",
    'gh api -X POST /api/graphql -f query=mutation { x }',
    'gh api -X POST https://api.github.com/graphql -f query=mutation { x }',
    'gh api graphql --raw-field query=mutation { changeVisibility(input: {}) { clientMutationId } }',
    // A mutation is found wherever it sits: a fragment or a read before it changes nothing.
    "gh api graphql -f query='fragment F on Repository { id } mutation { updateRepository(input: {visibility: PUBLIC}) { clientMutationId } }'",
    "gh api graphql -f query='query Q { viewer { login } } mutation M { updateRepository(input: {visibility: PUBLIC}) { clientMutationId } }'",
    // The document gh would read, which the guard cannot.
    'gh api graphql -F query=@mutation.graphql',
    'gh api graphql --input mutation.json',
    // A document the shell builds, so the guard cannot see it.
    'gh api graphql -f query=$(cat mutation.graphql)',
    'gh api graphql -f query="$DOC"',
    // A variable after other text, and a GraphQL variable: the guard cannot tell them apart.
    'gh api graphql -f query="query { viewer { login } } $DOC"',
    "gh api graphql -f query='query($id: ID!) { node(id: $id) { id } }'",
    // A method and no document at all.
    'gh api -X POST graphql',
    // Behind `yokoten bot`.
    'yokoten bot -- gh api graphql -f query=mutation { x }',
  ];
  for (const command of refused) {
    const found = checkCommand(command, { cwd: process.cwd(), env: lead });
    assert.equal(found?.id, 'repo-settings', command);
    assert.equal(found?.what, what, command);
  }
  // A worker hears the same refusal: the settings check answers before its own send rule.
  assert.equal(checkCommand(refused[0], { cwd: process.cwd(), env: { YOKOTEN_ROLE: 'worker' } })?.id, 'repo-settings');
  const reads = [
    'gh api graphql -f query=query { viewer { login } }',
    'gh api -X POST graphql -f query={ viewer { login } }',
    // The word only inside a string, in an operation that reads.
    'gh api graphql -f query=query { search(query: "mutation") { issueCount } }',
    // A fragment with a read after it.
    "gh api graphql -f query='fragment F on Repository { id } query Q { viewer { login } ...F }'",
  ];
  for (const command of reads) assert.equal(checkCommand(command, { cwd: process.cwd(), env: lead }), null, command);
  // Not a settings write: a comment that names a mutation is a read for both checks (#965).
  // A comment, the one mutation the bot needs (text with a brace is still text), is not a
  // settings write; the release check (#865) still refuses it as a mutation.
  const commented = "gh api graphql -f query='# mutation { changeVisibility }\nquery { viewer { login } }'";
  assert.equal(checkCommand(commented, { cwd: process.cwd(), env: lead }), null, commented);
  const comment = "gh api graphql -f query='mutation { addComment(input: {body: \"a } brace\"}) { clientMutationId } }'";
  assert.equal(checkCommand(comment, { cwd: process.cwd(), env: lead })?.id, 'release', comment);
});

// #965: the release check reads the GraphQL document as code, as the settings check does, so
// `mutation` inside a string or a `#` comment is not a mutation.
test('publishing routes: mutation in a string or a comment is not a mutation (#965)', () => {
  const publishes = (command: string) => isPublishingApiCall(wordsOf(command).slice(2));
  const cases: Array<[string, boolean]> = [
    ["gh api graphql -f query='query { search(query: \"mutation\") { issueCount } }'", false],
    ["gh api graphql -f query='# mutation\nquery { viewer { login } }'", false],
    ['gh api graphql -f query=\'query { search(query: "a \\" mutation") { issueCount } }\'', false],
    // Positive controls: a real mutation, one after a comment or a string, a comment that a
    // lone carriage return ends, a document the shell builds, and one the guard cannot read.
    ["gh api graphql -f query='mutation { addComment(input: {body: \"x\"}) { clientMutationId } }'", true],
    ["gh api graphql -f query='# read\nmutation { addComment(input: {body: \"x\"}) { clientMutationId } }'", true],
    ["gh api graphql -f query='query { a(x: \"mutation\") { b } } mutation { c }'", true],
    ["gh api graphql -f query='# read\rmutation { c }'", true],
    ["gh api graphql -f query='mutation($id: ID!) { addComment(input: {subjectId: $id, body: \"x\"}) { clientMutationId } }'", true],
    ["gh api graphql -f query='query { search(query: \"mutation\") { issueCount } }' -f other='mutation { c }'", true],
    ['gh api graphql -F query=@q.graphql', true],
    ['gh api graphql -f name=x', true],
  ];
  for (const [command, expected] of cases) assert.equal(publishes(command), expected, command);
  // The hook answers the same for the read from the issue.
  assert.equal(checkCommand("gh api graphql -f query='query { search(query: \"mutation\") { issueCount } }'", { cwd: process.cwd(), env: {} }), null);
});

test('host samples: doctor hears a miss, and a catch is quiet (#650)', () => {
  assert.deepEqual(hostGuardMisses(() => ({ id: 'x' })), []);
  assert.deepEqual(hostGuardMisses(() => null), ['run-remove guard', 'gh command guard', 'settings guard', 'workflow-disable guard']);
  assert.deepEqual(hostGuardMisses((command) => checkCommand(command, { env: {}, cwd: null })), []);
});

test('publishing routes: a variable repo, a repo create and a shell query are refused (#865)', () => {
  const publishes = (command: string) => isPublishingApiCall(wordsOf(command).slice(2));
  for (const command of [
    'gh api -X POST user/repos -f name=x -f private=false',
    'gh api -X POST orgs/acme/repos -f name=x -f visibility=public',
    'gh api -X PATCH repos/$OWNER/$REPO -f visibility=public',
    'gh api graphql -f query=$(cat /tmp/m.graphql)',
    'gh api graphql -f query=`cat /tmp/m.graphql`',
    'gh api graphql -f query=$QUERY',
    // The GraphQL endpoint has three spellings; a leading slash or a host must not hide
    // the query, and a query from a file may hold a mutation (#865).
    'gh api /graphql --input body.json',
    'gh api https://api.github.com/graphql --input body.json',
    'gh api /graphql -f query=$(cat /tmp/m.graphql)',
    // An option's value is not the endpoint, so `--hostname` or `--input` before it
    // cannot hide the GraphQL route (#865).
    'gh api --hostname github.com graphql --input body.json',
    'gh api --input body.json /graphql',
    // gh keeps the last value of a field given twice, so a benign query first cannot hide
    // a later query the guard cannot read (#865).
    'gh api graphql -f query=query{viewer{login}} -f query=$QUERY',
    'gh api graphql -f query=query{viewer{login}} -F query=@q.graphql',
    'gh api graphql -f "query=query{viewer{login}} $EXTRA"',
  ]) assert.equal(publishes(command), true, command);
  // Creating a repo is a write; listing one is a read. A POST to a repo's own route is not
  // a repo update, so the plain write rule still judges it (#650).
  for (const command of ['gh api orgs/acme/repos', 'gh api -X GET user/repos', 'gh api -X POST repos/$OWNER/$REPO', 'gh api graphql -f query=query{viewer{login}}', 'gh api /graphql -f query=query{viewer{login}}']) {
    assert.equal(publishes(command), false, command);
  }
});

test('publishing routes: a query string is part of the endpoint, not a body field (#865)', () => {
  const publishes = (command: string) => isPublishingApiCall(wordsOf(command).slice(2));
  for (const command of [
    'gh api -X POST repos/o/r/releases -f tag_name=v1',
    'gh api -X POST repos/o/r/releases?draft=false -f tag_name=v1',
    'gh api -X POST repos/o/r/releases?draft=false',
    'gh api -X PATCH repos/o/r?x=1 -f visibility=public',
    'gh api -X DELETE repos/o/r/git/refs/tags/rel-1?x=1',
    // GitHub reads one `%` escape, as does git's route for removing a run, so an encoded
    // route is the same route (#865).
    'gh api -X POST repos%2Fo%2Fr%2Freleases -f tag_name=v1',
    'gh api -X POST user%2Frepos -f name=x -f private=false',
    'gh api -X POST repos/o/r/%72eleases -f tag_name=v1',
    'gh api -X POST repos/%6F/r/releases -f tag_name=v1',
  ]) assert.equal(publishes(command), true, command);
  // A read with a query string is still a read, and a field is still a field.
  for (const command of ['gh api repos/o/r/releases?per_page=5', 'gh api -X GET repos/o/r/releases?per_page=5', 'gh api -X POST repos/o/r/issues -f labels=bug', 'gh api repos%2Fo%2Fr%2Freleases?per_page=5']) {
    assert.equal(publishes(command), false, command);
  }
});
