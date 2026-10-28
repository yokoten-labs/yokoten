// The planning setup on the code host (#10, record 0004 stage 2): the standard labels and
// a first milestone, which the pull request check asks for, the project's own area labels,
// and, only when asked, a board (#156).
//
// It changes a remote, so `init` only says what it would do. `init --github --yes` does
// it. A standard label that is there gets the standard colour and description, so a
// second run changes nothing. A label outside the set is deleted only with
// --remove-default-labels: deleting is the owner's call. Without gh, a sign-in or a
// GitHub remote, it says what it skipped. Plain init still succeeds; `init --github --yes`
// fails, because the user asked for changes on GitHub and none were made (#208). An area
// label is never deleted or changed.

import type { Env } from '../rules/config.ts';
import { gitConfig } from '../run/check.ts';
import {
  type Board,
  createBoard,
  createLabel,
  createMilestone,
  deleteLabel,
  editLabel,
  type Gh,
  isScopeMissing,
  type Label,
  linkBoard,
  PROJECT_SCOPE_FIX,
  readLinkedBoards,
  readOwnerBoards,
  readPlanning,
  readStatusField,
  repoOf,
  setFieldOptions,
} from '../host/github/index.ts';

/**
 * The standard set, as agreed for yokoten (#10): a type, the same words as commit types,
 * the flow labels, and the tier labels the pull request check asks for (#225). No status
 * or priority labels: the board holds status, milestones hold timing. Area labels are each
 * project's own, so they are not here.
 */
export const LABELS: Label[] = [
  { name: 'bug', color: 'd73a4a', description: 'Something does not work as it should' },
  { name: 'feat', color: 'a2eeef', description: 'A new feature or a change in behaviour' },
  { name: 'docs', color: '0075ca', description: 'Documentation only' },
  { name: 'refactor', color: 'cfd3d7', description: 'A code change that keeps the behaviour' },
  { name: 'ci', color: 'fbca04', description: 'CI workflows and checks' },
  { name: 'owner', color: '5319e7', description: 'Needs the owner: a decision, a setting or an approval' },
  { name: 'incident', color: 'b60205', description: 'Something went wrong; the fix adds a check' },
  { name: 'good first issue', color: '7057ff', description: 'A small, clear task for a new contributor' },
  { name: 'hotfix', color: 'e11d21', description: 'Urgent: fix and release soon' },
  { name: 'security', color: 'b60205', description: 'A hole in the guard, the privacy checks or the supply chain' },
  { name: 'tier A', color: 'b60205', description: 'Hard to take back: secrets, data, install/update path, releases, going public. The owner approves.' },
  { name: 'tier B', color: 'fbca04', description: 'Other code. Tests for the change; another vendor approves, then the bot merges when CI is green.' },
  { name: 'tier C', color: '0e8a16', description: 'Docs, wording, styles. Merges when CI is green.' },
];

/** The milestone made when the repo has no open one. */
export const FIRST_MILESTONE = 'First release';

/** The milestone made instead when a closed one already holds the first title. */
export const NEXT_MILESTONE = 'Next release';

/**
 * The one milestone rule for `init --github` and the road (#178): the repo needs an open
 * milestone. Returns null when one is open, or else the title `init` makes. A closed
 * milestone is the owner's decision, so it is never reopened. The host refuses a title a
 * closed one holds, so the title is the first one that is free: "First release", then
 * "Next release", then "Next release 2" and on.
 */
export function pickNewMilestone(milestones: { title: string; open: boolean }[]): string | null {
  if (milestones.some((m) => m.open)) return null;
  const taken = new Set(milestones.map((m) => m.title.toLowerCase()));
  if (!taken.has(FIRST_MILESTONE.toLowerCase())) return FIRST_MILESTONE;
  let title = NEXT_MILESTONE;
  for (let count = 2; taken.has(title.toLowerCase()); count++) title = `${NEXT_MILESTONE} ${count}`;
  return title;
}

/** GitHub's default labels that the standard set replaces. Deleted only with --remove-default-labels. */
export const HOST_DEFAULTS = ['documentation', 'duplicate', 'enhancement', 'help wanted', 'invalid', 'question', 'wontfix'];

/**
 * At most this many area labels (#156). Next to the standard labels, 8 more still fit
 * in the label menu at a glance. A longer list is noise: nobody filters by 20 areas, and
 * the issue title already names the area. A project with more makes the few it uses by hand.
 */
export const MAX_AREA_LABELS = 8;

/** One neutral colour for every area label, so the type and flow labels stand out. GitHub's own default grey. */
export const AREA_COLOR = 'ededed';

/** The Status options of a board yokoten makes (#156). */
export const BOARD_STATUSES = ['Todo', 'In progress', 'In review', 'Done'];

/** The standard labels not in `names`, compared without case. */
export const lackingLabels = (names: string[]): Label[] => {
  const have = new Set(names.map((name) => name.toLowerCase()));
  return LABELS.filter((label) => !have.has(label.name.toLowerCase()));
};

/** The origin remote's URL, or '' when there is none. */
export function readOriginUrl(root: string, env: Env): string {
  return gitConfig(root, 'remote.origin.url', env);
}

export interface PlanningOptions {
  /** Change the host. When false, only say what would change. */
  apply: boolean;
  /** Also delete GitHub's default labels that are not in the standard set. */
  removeDefaults: boolean;
  /** The project's areas, from yokoten.json. Each becomes a label when the list is short. */
  areas?: string[];
  /** Also make a board, link it to the repo, and give it the Status options (--board). */
  board?: boolean;
}

/** One change to the host: what it is, in words, and the gh call that makes it. */
interface HostChange {
  what: string;
  run: () => void;
}

/**
 * One line of the GitHub plan: `done` and `failed` after --yes, `kept` for what is there,
 * `to do` for what --yes would do, and `note` for what yokoten leaves to the owner.
 */
export interface PlanItem {
  state: 'done' | 'failed' | 'kept' | 'to do' | 'note';
  what: string;
}

/**
 * What `init --github` found and did on GitHub, as data (#1115): the screen reads this, never
 * prose. `skip` says why GitHub was not read, and `command` is the one that does the `to do` items.
 */
export interface PlanResult {
  ok: boolean;
  skipped: boolean;
  /** `owner/name` on GitHub, or null when it was skipped before it was known. */
  repo: string | null;
  /** Why GitHub was skipped, and the command or step that lets it run. */
  skip?: { why: string; fix: string };
  items: PlanItem[];
  /** The command that does the `to do` items; set only when the plan was a preview. */
  command?: string;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The area labels to make, and the items about the areas. */
function planAreaLabels(gh: Gh, repo: string, areas: string[], labels: Label[]): { items: PlanItem[]; changes: HostChange[] } {
  // An area with a standard label's name (`docs`, `ci`) keeps the standard label.
  const standard = areas.filter((area) => LABELS.some((l) => sameName(l.name, area)));
  const wanted = areas.filter((area) => !standard.includes(area));
  const items: PlanItem[] = standard.length ? [{ state: 'kept', what: `areas that are also standard labels keep the standard label: ${standard.join(', ')}` }] : [];
  if (wanted.length > MAX_AREA_LABELS) {
    return { items: [...items, { state: 'note', what: `no area labels: yokoten.json has ${wanted.length} areas, and more than ${MAX_AREA_LABELS} labels is noise; make the few you filter by yourself` }], changes: [] };
  }
  const changes: HostChange[] = [];
  let kept = 0;
  for (const area of wanted) {
    // A label that is there is the owner's, whatever its colour: it is kept as it is.
    if (labels.some((l) => sameName(l.name, area))) kept++;
    else {
      const label = { name: area, color: AREA_COLOR, description: `area: ${area}` };
      changes.push({ what: `make label "${area}" (area: ${area})`, run: () => createLabel(gh, repo, label) });
    }
  }
  if (kept) items.push({ state: 'kept', what: `${kept} of the ${wanted.length} area labels are there` });
  return { items, changes };
}

/** Makes the board, links it, and sets its Status options. Only for a board made just now. */
function makeBoard(gh: Gh, repo: string, title: string): void {
  const owner = repo.split('/')[0];
  const number = createBoard(gh, owner, title);
  linkBoard(gh, repo, number);
  const status = readStatusField(gh, owner, number);
  if (!status) throw new Error(`board "${title}" has no Status field; add one with ${BOARD_STATUSES.join(', ')}`);
  setFieldOptions(gh, status.id, BOARD_STATUSES);
}

/** What the Status field of a board that is there says, as one item. */
function describeStatus(gh: Gh, repo: string, board: Board): PlanItem {
  const owner = repo.split('/')[0];
  let options: string[] | null = null;
  try {
    options = readStatusField(gh, owner, board.number)?.options ?? null;
  } catch {
    return { state: 'note', what: `board "${board.title}": could not read its Status field; check it has ${BOARD_STATUSES.join(', ')}` };
  }
  if (options && options.length === BOARD_STATUSES.length && options.every((o, i) => sameName(o, BOARD_STATUSES[i]))) return { state: 'kept', what: `board "${board.title}" has the Status options` };
  // Changing the options would clear the status of every item on it, so the owner does it.
  return { state: 'note', what: `board "${board.title}": its Status options are ${options?.join(', ') || 'missing'}; yokoten never changes a board that is there, so set ${BOARD_STATUSES.join(', ')} by hand` };
}

/** The board: found by title among the linked ones, then among the owner's, or made. */
function planBoard(gh: Gh, repo: string): { items: PlanItem[]; changes: HostChange[] } {
  const title = repo.split('/')[1];
  const skip = (err: { unread: string; fix: string }): { items: PlanItem[]; changes: HostChange[] } => ({
    items: [{ state: 'note', what: `no board: ${err.unread}; to make one, ${err.fix}, then run \`yokoten init --github --board --yes\` again` }],
    changes: [],
  });
  const linked = readLinkedBoards(gh, repo);
  if ('unread' in linked) return skip(linked);
  const there = linked.find((b) => sameName(b.title, title));
  if (there) return { items: [{ state: 'kept', what: `board "${there.title}" is linked` }, describeStatus(gh, repo, there)], changes: [] };
  // Made by an earlier run that stopped before the link: link it, never make a second one.
  const owned = readOwnerBoards(gh, repo.split('/')[0]);
  if ('unread' in owned) return skip(owned);
  const unlinked = owned.find((b) => sameName(b.title, title));
  if (unlinked) {
    return { items: [describeStatus(gh, repo, unlinked)], changes: [{ what: `link board "${unlinked.title}" to ${repo}`, run: () => linkBoard(gh, repo, unlinked.number) }] };
  }
  return { items: [], changes: [{ what: `make board "${title}", link it to ${repo}, and give its Status field ${BOARD_STATUSES.join(', ')}`, run: () => makeBoard(gh, repo, title) }] };
}

/** gh's first line about a failure, and the fix when the token lacks the project scope. */
function describeFailure(err: unknown): string {
  const said = String((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n')[0];
  return isScopeMissing(err) ? `${said}; ${PROJECT_SCOPE_FIX}` : said;
}

/** The command that sets up labels and a milestone once GitHub can be reached. */
export const SET_UP = 'yokoten init --github --yes';

/**
 * What GitHub has and what `init --github` would change, or changed with `apply`, as data. `remote`
 * is the origin URL. A skip (no GitHub remote, no gh, no sign-in) is ok here: the caller decides,
 * because only `init --github --yes` asked for a change. A board that can't be made for lack of the
 * project scope is a failed item, not a skip: the rest still happens.
 */
export function setUpPlanning(gh: Gh, remote: string, { apply, removeDefaults, areas = [], board = false }: PlanningOptions): PlanResult {
  const skip = (why: string, fix: string): PlanResult => ({ ok: true, skipped: true, repo: null, skip: { why, fix }, items: [] });
  if (!remote.trim()) return skip('there is no origin remote yet; make the repo on GitHub, add it as origin and push, then set up labels and a milestone', SET_UP);
  const repo = repoOf(remote);
  if (!repo) return skip('the origin remote is not on GitHub; labels and a milestone need a GitHub repo', '');
  const found = readPlanning(gh, repo);
  if ('unread' in found) return skip(`${found.unread}; to set up labels and a milestone, ${found.fix}`, SET_UP);

  const items: PlanItem[] = [];
  const changes: HostChange[] = [];
  let kept = 0;
  for (const label of LABELS) {
    const there = found.labels.find((l) => sameName(l.name, label.name));
    if (!there) changes.push({ what: `make label "${label.name}" (${label.description})`, run: () => createLabel(gh, repo, label) });
    else if (there.color.toLowerCase() !== label.color || there.description !== label.description) {
      changes.push({ what: `update label "${there.name}" to the standard colour and description`, run: () => editLabel(gh, repo, there.name, label) });
    } else kept++;
  }
  if (kept) items.push({ state: 'kept', what: `${kept} of the ${LABELS.length} standard labels are there` });
  const milestone = pickNewMilestone(found.milestones);
  if (milestone === null) items.push({ state: 'kept', what: 'a milestone is open' });
  else changes.push({ what: `make milestone "${milestone}"`, run: () => createMilestone(gh, repo, milestone) });
  const areaPlan = planAreaLabels(gh, repo, areas, found.labels);
  items.push(...areaPlan.items);
  changes.push(...areaPlan.changes);
  // A project's own area is never deleted, even when GitHub has a default label of that name.
  const extra = found.labels.filter((l) => HOST_DEFAULTS.includes(l.name.toLowerCase()) && !areas.some((area) => sameName(area, l.name))).map((l) => l.name);
  if (extra.length && removeDefaults) {
    for (const name of extra) changes.push({ what: `delete label "${name}" (the host also takes it off every issue)`, run: () => deleteLabel(gh, repo, name) });
  } else if (extra.length) {
    items.push({ state: 'note', what: `not in the standard set: ${extra.join(', ')}; yokoten deletes them only with --remove-default-labels` });
  }
  if (board) {
    const boardPlan = planBoard(gh, repo);
    items.push(...boardPlan.items);
    changes.push(...boardPlan.changes);
  }

  const result: PlanResult = { ok: true, skipped: false, repo: found.repo, items };
  if (!changes.length) return result;
  if (!apply) {
    const command = `${SET_UP}${removeDefaults ? ' --remove-default-labels' : ''}${board ? ' --board' : ''}`;
    return { ...result, items: [...items, ...changes.map((change): PlanItem => ({ state: 'to do', what: change.what }))], command };
  }
  // Each one on its own: one refusal does not stop the rest, and the result says which.
  for (const change of changes) {
    try {
      change.run();
      items.push({ state: 'done', what: change.what });
    } catch (err) {
      result.ok = false;
      items.push({ state: 'failed', what: `could not ${change.what}: ${describeFailure(err)}` });
    }
  }
  return result;
}
