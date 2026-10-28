// A captured screen as HTML: the text line for line, in the colours the package's own styleText
// gives it (lib/terminal/ansi.ts). Nothing is retyped or cut, and no colour rule lives here.
import { screenRuns } from './ansi';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls: string, s: string) => `<span class="${cls}">${esc(s)}</span>`;
/** A mark's glyph (✔ ✘ ● ⚠ and the like) fills one cell in a terminal; a web font may draw it wider or narrower, so it gets one cell here too. */
const GLYPH = /([\u2000-\u2bff])/;
const cells = (cls: string, text: string) =>
  text.split(GLYPH).filter(Boolean).map((part) => (GLYPH.test(part) ? `<span class="${[cls, 'g'].filter(Boolean).join(' ')}">${esc(part)}</span>` : cls ? span(cls, part) : esc(part))).join('');
/** Where a row's text starts: after a two-space indent, a mark or label, and its gap. A line the browser must wrap carries on there, as yokoten wraps its own rows. */
const textColumn = (plain: string): number => /^( {2}\S.*? {2,})\S/.exec(plain)?.[1].length ?? /^( +)\S/.exec(plain)?.[1].length ?? 0;
const MAX_INDENT = 24;

export function screenHtml(typed: string, ansi: string): string {
  const lines = screenRuns(ansi).map((line) => {
    const plain = line.map((r) => r.text).join('');
    const body = line.map((r) => cells(r.styles.map((s) => `t-${s}`).join(' '), r.text)).join('');
    const at = Math.min(textColumn(plain), MAX_INDENT);
    return `<span class="l i${at}">${body || ' '}</span>`;
  });
  return [`<span class="l i0">${span('t-dim', '$ ')}${esc(typed)}</span>`, '<span class="l i0"> </span>', ...lines].join('');
}

/**
 * The two lines a short card shows from a refusal: the `yokoten stopped this:` line and the Why,
 * its wrapped lines joined. Taken from the captured text, never retyped.
 */
export function stopLines(text: string): { stopped: string; why: string } {
  const lines = text.split('\n');
  const stopped = lines.find((l) => l.startsWith('yokoten stopped this:'));
  const at = lines.findIndex((l) => /^ {2}Why\s/.test(l));
  if (!stopped || at < 0) throw new Error('a refusal screen without its "yokoten stopped this:" line or its Why');
  const why: string[] = [];
  for (let i = at; i < lines.length && lines[i].trim(); i++) why.push(lines[i].replace(/^ {2}Why\s+/, '').trim());
  return { stopped, why: why.join(' ') };
}
