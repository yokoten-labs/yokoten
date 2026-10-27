// Tests for src/setup/plan.ts.

import '../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fakeGh,
  planningFound,
  withPlanning,
} from '../repo/helpers.ts';
import {
  type Board,
  type Gh,
  readPlanning,
} from '../../src/host/github/index.ts';
import {
  AREA_COLOR,
  BOARD_STATUSES,
  LABELS,
  MAX_AREA_LABELS,
  pickNewMilestone,
  type PlanItem,
  type PlanResult,
  setUpPlanning,
} from '../../src/setup/plan.ts';
import {
  ROAD,
  stepFinding,
} from '../../src/setup/road.ts';

// A fake gh that holds one repo's labels and milestones in memory. The real one is never run.
const REMOTE = 'https://github.com/me/repo.git';

const writes = (calls: string[][]) => calls.filter((c) => c[0] === 'label' || c.includes('POST'));

const DRY = { apply: false, removeDefaults: false };

const APPLY = { apply: true, removeDefaults: false };

/** Whether the plan holds an item in this state with these words. */
const has = (result: PlanResult, state: PlanItem['state'], what: string): boolean => result.items.some((item) => item.state === state && item.what === what);

/** Whether the plan has nothing to do: no item done, failed or to do, and no command. */
const isNothingToChange = (result: PlanResult): boolean => result.command === undefined && result.items.every((item) => item.state === 'kept' || item.state === 'note');

/** The items, one line each, for a failure message. */
const said = (result: PlanResult): string => result.items.map((item) => `${item.state}: ${item.what}`).join('\n');

// A fake gh with boards too: `project` commands and the GraphQL calls. The real gh is never run.
const SCOPE_ERROR = 'gh: Your token has not been granted the required scopes to execute this query. The \'number\' field requires one of the following scopes: [\'read:project\']';

function boardGh({ linked = [] as Board[], owned = [] as Board[], isScopeMissing = false } = {}) {
  const inner = fakeGh([...LABELS], ['open v1']);
  const statuses = new Map<number, string[]>(owned.map((b) => [b.number, ['Todo', 'In Progress', 'Done']]));
  const gh: Gh = (args) => {
    const isGraphql = args[0] === 'api' && args[1] === 'graphql';
    if (args[0] !== 'project' && !isGraphql) return inner.gh(args);
    inner.calls.push(args);
    if (isScopeMissing) throw Object.assign(new Error('exit 1'), { stderr: `${SCOPE_ERROR}\n` });
    const option = (name: string) => args[args.indexOf(name) + 1];
    if (isGraphql && args.some((a) => a.includes('updateProjectV2Field'))) {
      const names = [...args.find((a) => a.startsWith('query='))!.matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
      statuses.set(Number(args.find((a) => a.startsWith('field='))!.slice('field=field-'.length)), names);
      return '{}';
    }
    if (isGraphql) {
      assert.ok(args.includes('owner=me') && args.includes('name=repo'), 'the linked boards of this repo');
      return JSON.stringify({ data: { repository: { projectsV2: { nodes: linked } } } });
    }
    const [, verb, number] = args;
    assert.equal(option('--owner'), 'me', `every board call names the owner: ${args.join(' ')}`);
    if (verb === 'list') return JSON.stringify({ projects: owned, totalCount: owned.length });
    if (verb === 'create') {
      const board = { number: owned.length + 1, title: option('--title') };
      owned.push(board);
      statuses.set(board.number, ['Todo', 'In Progress', 'Done']);
      return JSON.stringify({ ...board, url: `https://github.com/users/me/projects/${board.number}` });
    }
    if (verb === 'link') {
      assert.equal(option('--repo'), 'repo');
      linked.push(owned.find((b) => b.number === Number(number))!);
      return '';
    }
    if (verb === 'field-list') {
      const options = statuses.get(Number(number)) ?? [];
      return JSON.stringify({ fields: [{ id: 'title-field', name: 'Title', type: 'ProjectV2Field' }, { id: `field-${number}`, name: 'Status', type: 'ProjectV2SingleSelectField', options: options.map((name) => ({ id: name, name })) }] });
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls: inner.calls, linked, owned, statuses };
}

const boardWrites = (calls: string[][]) => calls.filter((c) => (c[0] === 'project' && ['create', 'link'].includes(c[1])) || c.some((a) => a.includes('updateProjectV2Field')));

test('planning: says what it would do, and changes nothing without --yes (#10)', () => {
  const standardBug = LABELS.find((l) => l.name === 'bug')!;
  const f = fakeGh([standardBug, 'feat', 'Enhancement', 'wontfix']);
  const r = setUpPlanning(f.gh, REMOTE, DRY);
  assert.ok(r.ok);
  assert.ok(has(r, 'kept', '1 of the 13 standard labels are there'));
  assert.ok(has(r, 'note', 'not in the standard set: Enhancement, wontfix; yokoten deletes them only with --remove-default-labels'));
  assert.ok(has(r, 'to do', 'make label "hotfix" (Urgent: fix and release soon)'));
  assert.ok(has(r, 'to do', 'update label "feat" to the standard colour and description'));
  assert.ok(has(r, 'to do', 'make milestone "First release"'));
  assert.equal(r.command, 'yokoten init --github --yes');
  assert.deepEqual(writes(f.calls), [], 'nothing changed');
});

test('planning: makes what is missing, updates what differs, and a second run changes nothing (#10)', () => {
  const fake = fakeGh(['BUG', 'owner', 'question'], ['closed v0.0.1']);
  let result = setUpPlanning(fake.gh, REMOTE, APPLY);
  assert.equal(result.ok, false, 'one label was refused');
  assert.ok(has(result, 'failed', 'could not make label "docs" (Documentation only): HTTP 403: no access'));
  assert.ok(has(result, 'done', 'make label "hotfix" (Urgent: fix and release soon)'), 'the refusal did not stop the rest');
  assert.ok(has(result, 'done', 'update label "BUG" to the standard colour and description'), 'case ignored; the name is kept');
  assert.ok(has(result, 'done', 'make milestone "First release"'));
  assert.equal(fake.calls.filter((c) => c[1] === 'create').length, LABELS.length - 2);
  assert.deepEqual(fake.calls.find((c) => c.includes('docs')), ['label', 'create', 'docs', '-R', 'me/repo', '--color', '0075ca', '--description', 'Documentation only']);
  assert.ok(fake.held.some((l) => l.name === 'question'), 'a label outside the set is never deleted by default');
  fake.held.push(LABELS.find((l) => l.name === 'docs')!);
  // Run twice: no duplicate, no update, nothing made.
  const before = fake.calls.length;
  result = setUpPlanning(fake.gh, REMOTE, APPLY);
  assert.ok(result.ok);
  assert.ok(isNothingToChange(result), said(result));
  assert.deepEqual(writes(fake.calls.slice(before)), []);
  assert.equal(fake.held.filter((l) => l.name.toLowerCase() === 'bug').length, 1, 'no duplicate');
  assert.deepEqual(fake.milestones, ['closed v0.0.1', 'open First release']);
});

test('planning: makes the tier labels the pull request check asks for, once (#225)', () => {
  const fake = fakeGh([LABELS.find((l) => l.name === 'docs')!], ['open v1']);
  let result = setUpPlanning(fake.gh, REMOTE, APPLY);
  assert.ok(result.ok, said(result));
  for (const tier of ['A', 'B', 'C']) {
    assert.ok(result.items.some((item) => item.state === 'done' && item.what.startsWith(`make label "tier ${tier}"`)), `tier ${tier}: ${said(result)}`);
    assert.equal(fake.held.filter((l) => l.name === `tier ${tier}`).length, 1);
  }
  assert.match(fake.held.find((l) => l.name === 'tier A')!.description, /The owner approves/);
  assert.match(fake.held.find((l) => l.name === 'tier B')!.description, /another vendor approves/);
  assert.equal(fake.held.find((l) => l.name === 'security')!.color, 'b60205');
  const before = fake.calls.length;
  result = setUpPlanning(fake.gh, REMOTE, APPLY);
  assert.ok(isNothingToChange(result), said(result));
  assert.deepEqual(writes(fake.calls.slice(before)), [], 'a second run makes nothing new');
});

test('planning: deletes GitHub\'s default labels only with --remove-default-labels (#10)', () => {
  const fake = fakeGh([...LABELS, 'question', 'Wontfix', 'my-own'], ['open v1']);
  let result = setUpPlanning(fake.gh, REMOTE, { apply: false, removeDefaults: true });
  assert.ok(has(result, 'to do', 'delete label "question" (the host also takes it off every issue)'));
  assert.equal(result.command, 'yokoten init --github --yes --remove-default-labels');
  assert.deepEqual(writes(fake.calls), []);
  result = setUpPlanning(fake.gh, REMOTE, { apply: true, removeDefaults: true });
  assert.ok(result.ok);
  assert.deepEqual(writes(fake.calls), [['label', 'delete', 'question', '-R', 'me/repo', '--yes'], ['label', 'delete', 'Wontfix', '-R', 'me/repo', '--yes']]);
  assert.ok(fake.held.some((l) => l.name === 'my-own'), 'a label the owner made is not a GitHub default');
});

test('planning: no gh, signed out, or no GitHub remote is a skip that says why, not a failure (#10)', () => {
  const missing = setUpPlanning(() => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); }, REMOTE, APPLY);
  assert.deepEqual([missing.ok, missing.skipped], [true, true], 'the caller decides: init --github --yes fails on a skip (#208)');
  assert.match(missing.skip?.why ?? '', /^gh is not installed; to set up labels and a milestone, get it from https:\/\/cli\.github\.com/);
  assert.equal(missing.skip?.fix, 'yokoten init --github --yes');
  const out = setUpPlanning(() => { throw Object.assign(new Error('exit 4'), { stderr: 'HTTP 401: Bad credentials' }); }, REMOTE, APPLY);
  assert.deepEqual(out, { ok: true, skipped: true, repo: null, skip: { why: 'gh is not signed in; to set up labels and a milestone, run `gh auth login`', fix: 'yokoten init --github --yes' }, items: [] });
  const elsewhere = setUpPlanning(() => { throw new Error('gh was called'); }, 'https://gitea.example.com/me/repo.git', APPLY);
  assert.deepEqual(elsewhere, { ok: true, skipped: true, repo: null, skip: { why: 'the origin remote is not on GitHub; labels and a milestone need a GitHub repo', fix: '' }, items: [] });
  const none = setUpPlanning(() => { throw new Error('gh was called'); }, '', APPLY);
  assert.deepEqual(none, { ok: true, skipped: true, repo: null, skip: { why: 'there is no origin remote yet; make the repo on GitHub, add it as origin and push, then set up labels and a milestone', fix: 'yokoten init --github --yes' }, items: [] }, 'no remote at all (#208)');
});

test('planning: one neutral label per area when the list is short; kept as it is, never deleted (#156)', () => {
  const fake = fakeGh([...LABELS, { name: 'Kit', color: 'ff0000', description: 'mine' }, 'question'], ['open v1']);
  const areas = ['kit', 'agents', 'question', 'ci'];
  let result = setUpPlanning(fake.gh, REMOTE, { apply: false, removeDefaults: true, areas });
  assert.ok(has(result, 'kept', 'areas that are also standard labels keep the standard label: ci'));
  assert.ok(has(result, 'kept', '2 of the 3 area labels are there'), 'Kit and question are there');
  assert.ok(has(result, 'to do', 'make label "agents" (area: agents)'));
  assert.ok(!result.items.some((item) => item.what.includes('delete label "question"')), 'an area label is never deleted, even with --remove-default-labels');
  assert.deepEqual(writes(fake.calls), []);
  result = setUpPlanning(fake.gh, REMOTE, { apply: true, removeDefaults: true, areas });
  assert.ok(result.ok);
  assert.deepEqual(writes(fake.calls), [['label', 'create', 'agents', '-R', 'me/repo', '--color', AREA_COLOR, '--description', 'area: agents']]);
  assert.deepEqual(fake.held.find((l) => l.name === 'Kit'), { name: 'Kit', color: 'ff0000', description: 'mine' }, 'the owner\'s colour stays');
  // Positive control: a second run makes no new label.
  const before = fake.calls.length;
  result = setUpPlanning(fake.gh, REMOTE, { apply: true, removeDefaults: false, areas });
  assert.ok(isNothingToChange(result), said(result));
  assert.deepEqual(writes(fake.calls.slice(before)), []);
  // A long list is noise: no area label at all, and the report says why.
  const many = Array.from({ length: MAX_AREA_LABELS + 1 }, (_, i) => `area${i}`);
  result = setUpPlanning(fakeGh([...LABELS], ['open v1']).gh, REMOTE, { apply: false, removeDefaults: false, areas: many });
  assert.ok(has(result, 'note', `no area labels: yokoten.json has ${MAX_AREA_LABELS + 1} areas, and more than ${MAX_AREA_LABELS} labels is noise; make the few you filter by yourself`));
  assert.ok(isNothingToChange(result));
});

test('planning: --board makes one board, links it, sets Status; a second run makes none (#156)', () => {
  const fake = boardGh();
  let result = setUpPlanning(fake.gh, REMOTE, { apply: false, removeDefaults: false, board: true });
  assert.deepEqual(result.items.at(-1), { state: 'to do', what: 'make board "repo", link it to me/repo, and give its Status field Todo, In progress, In review, Done' });
  assert.equal(result.command, 'yokoten init --github --yes --board');
  assert.deepEqual(boardWrites(fake.calls), []);
  result = setUpPlanning(fake.gh, REMOTE, { apply: true, removeDefaults: false, board: true });
  assert.ok(result.ok, said(result));
  assert.deepEqual(boardWrites(fake.calls).map((c) => c.slice(0, 2).join(' ')), ['project create', 'project link', 'api graphql']);
  assert.deepEqual(fake.linked, [{ number: 1, title: 'repo' }]);
  assert.deepEqual(fake.statuses.get(1), BOARD_STATUSES);
  // Positive control: the second run finds the linked board by its title and makes nothing.
  const before = fake.calls.length;
  result = setUpPlanning(fake.gh, REMOTE, { apply: true, removeDefaults: false, board: true });
  assert.ok(has(result, 'kept', 'board "repo" is linked'));
  assert.ok(has(result, 'kept', 'board "repo" has the Status options'));
  assert.ok(isNothingToChange(result), said(result));
  assert.deepEqual(boardWrites(fake.calls.slice(before)), []);
  // Without --board, no board call at all.
  const plain = boardGh();
  setUpPlanning(plain.gh, REMOTE, APPLY);
  assert.ok(!plain.calls.some((c) => c[0] === 'project' || c[1] === 'graphql'));
});

test('planning: a board made but not linked is linked, and a board in use keeps its Status (#156)', () => {
  const fake = boardGh({ owned: [{ number: 4, title: 'repo' }] });
  const result = setUpPlanning(fake.gh, REMOTE, { apply: true, removeDefaults: false, board: true });
  assert.ok(result.ok);
  assert.ok(has(result, 'done', 'link board "repo" to me/repo'));
  assert.ok(has(result, 'note', 'board "repo": its Status options are Todo, In Progress, Done; yokoten never changes a board that is there, so set Todo, In progress, In review, Done by hand'));
  assert.deepEqual(boardWrites(fake.calls).map((c) => c.slice(0, 2).join(' ')), ['project link'], 'no second board, no change to its options');
  assert.equal(fake.owned.length, 1);
});

test('planning: no project scope skips the board with the fix; the labels still go on (#156)', () => {
  const fake = boardGh({ isScopeMissing: true });
  const result = setUpPlanning(fake.gh, REMOTE, { apply: true, removeDefaults: false, board: true, areas: ['kit'] });
  assert.equal(result.ok, true, 'a skip is not a failure');
  assert.ok(has(result, 'note', 'no board: the gh token has no `project` scope; to make one, run `gh auth refresh -s project`, then run `yokoten init --github --board --yes` again'), said(result));
  assert.ok(has(result, 'done', 'make label "kit" (area: kit)'));
  assert.deepEqual(boardWrites(fake.calls), []);
  // A token that reads boards but can't make one: the failure carries the same fix.
  const readOnly = boardGh();
  const failing: Gh = (args) => {
    if (args[1] === 'create' && args[0] === 'project') throw Object.assign(new Error('exit 1'), { stderr: 'error: your authentication token is missing required scopes [project]\n' });
    return readOnly.gh(args);
  };
  const made = setUpPlanning(failing, REMOTE, { apply: true, removeDefaults: false, board: true });
  assert.equal(made.ok, false);
  assert.deepEqual(made.items.at(-1)?.state, 'failed');
  assert.match(made.items.at(-1)?.what ?? '', /^could not make board "repo".*: error: your authentication token is missing required scopes \[project\]; run `gh auth refresh -s project`$/);
});

test('milestone: init and the road use one rule, an open milestone; a closed one is never kept or reopened (#178)', () => {
  const milestoneStep = ROAD.find((s) => s.key === 'milestone')!;
  // Positive control: the old init rule kept a closed "First release", and the road stayed not done.
  const fake = fakeGh([...LABELS], ['closed First release']);
  const server = () => withPlanning(readPlanning(fake.gh, 'me/repo'));
  assert.equal(planningFound(server()).milestone, false);
  assert.equal(stepFinding(milestoneStep, '.', {}, { server: server() }).fix, '`yokoten init --github --yes` makes one called "Next release"', 'doctor names what init makes');
  const planned = setUpPlanning(fake.gh, REMOTE, DRY);
  assert.ok(has(planned, 'to do', 'make milestone "Next release"'), said(planned));
  assert.ok(!has(planned, 'kept', 'a milestone is open'));
  assert.equal(planningFound(server()).milestone, false, 'not done until the milestone exists');
  const applied = setUpPlanning(fake.gh, REMOTE, APPLY);
  assert.ok(has(applied, 'done', 'make milestone "Next release"'));
  assert.deepEqual(fake.milestones, ['closed First release', 'open Next release'], 'the closed one stays closed');
  assert.equal(planningFound(server()).milestone, true);
  assert.ok(isNothingToChange(setUpPlanning(fake.gh, REMOTE, APPLY)));
  // An open milestone: init keeps it and the road is done.
  const open = fakeGh([...LABELS], ['closed First release', 'open v2']);
  assert.ok(has(setUpPlanning(open.gh, REMOTE, DRY), 'kept', 'a milestone is open'));
  assert.equal(planningFound(withPlanning(readPlanning(open.gh, 'me/repo'))).milestone, true);
  // Only other closed ones: "First release"; every name taken: the next free number.
  assert.equal(pickNewMilestone([{ title: 'v0.1', open: false }]), 'First release');
  assert.equal(pickNewMilestone([]), 'First release');
  assert.equal(pickNewMilestone(['first release', 'Next release', 'Next release 2'].map((title) => ({ title, open: false }))), 'Next release 3');
});
