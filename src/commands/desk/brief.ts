// A desk's brief (issue #1054): the task, and how to work in the desk. The task is an issue,
// read with the person's own `gh` login, or a task given in quotes. The brief is the AI's
// first prompt, and is kept next to the desk, outside it, so a stopped desk goes on from it.

import type { Run } from './clone.ts';

/** What a desk works on. `name` names its folder and branch. */
export type DeskTask = { kind: 'issue'; number: number; title: string; body: string; name: string } | { kind: 'text'; title: string; body: string; name: string };

/** The word after `desk`: an issue number, or a task in words. Null when it is neither. */
export function readTaskWord(word: string): { number: number } | { text: string } | null {
  if (/^#?\d{1,9}$/.test(word)) return { number: Number(word.replace('#', '')) };
  return /[a-z]/i.test(word) ? { text: word.trim() } : null;
}

/** A folder name from a task in words: lower case, a few words joined by dashes. */
export const taskName = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'task';

/** The issue, read through gh, or one line that says what to do. */
export function readIssue(number: number, run: Run, cwd: string): DeskTask | { problem: string } {
  const read = run('gh', ['issue', 'view', String(number), '--json', 'number,title,body'], cwd);
  if (read.status !== 0) return { problem: `can't read issue #${number} with gh. Run \`gh auth login\`, or give the task in quotes: yokoten desk "fix the typo".` };
  try {
    const issue = JSON.parse(read.stdout) as { title?: unknown; body?: unknown };
    if (typeof issue.title !== 'string') throw new Error('no title');
    return { kind: 'issue', number, title: issue.title, body: typeof issue.body === 'string' ? issue.body : '', name: String(number) };
  } catch {
    return { problem: `gh gave no issue #${number}.` };
  }
}

/** The task in words, as a desk task. */
export const textTask = (text: string): DeskTask => ({ kind: 'text', title: text, body: '', name: taskName(text) });

/** The brief: the task first, then how to work here. On a resume, what the desk did so far. */
export function briefText(task: DeskTask, branch: string, done: string[] = []): string {
  const heading = task.kind === 'issue' ? `Issue #${task.number}: ${task.title}` : `Task: ${task.title}`;
  return [
    heading,
    '',
    ...(task.body.trim() ? [task.body.trim(), ''] : []),
    '## How to work in this desk',
    '',
    `- This folder is your own clone, on the branch ${branch}. Work only here.`,
    '- Commit each small step that works, with a plain message. A stop then loses minutes, not the task.',
    '- Never push and never open a pull request: the person does that after you exit.',
    '- Run the project\'s tests before you say it is done. Then exit.',
    ...(done.length ? ['', '## Done so far (you stopped; go on from here)', '', ...done.map((line) => `- ${line}`)] : []),
    '',
  ].join('\n');
}
