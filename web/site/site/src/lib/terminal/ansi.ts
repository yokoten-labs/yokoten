// A screen as a terminal shows it: the `ansi` text from-package.mjs makes with the package's own
// styleText, read back into runs of text and their style. The site (screen.ts) and the promo video
// both draw from these runs, so neither keeps a colour rule of its own.

/** The styles yokoten's styleText writes: bold, and four colours (src/commands/shared.ts). */
export type Style = 'bold' | 'red' | 'green' | 'yellow' | 'cyan';
export interface Run {
  text: string;
  styles: Style[];
}

const CODES: Record<string, Style> = { '1': 'bold', '31': 'red', '32': 'green', '33': 'yellow', '36': 'cyan' };
const SGR = /\u001b\[([0-9;]*)m/g;

/** One line of the coloured text as runs. A code it does not know fails, so a new style is never dropped silently. */
export function runs(line: string): Run[] {
  const out: Run[] = [];
  let styles: Style[] = [];
  let at = 0;
  const push = (text: string) => {
    if (text) out.push({ text, styles: [...styles] });
  };
  for (const m of line.matchAll(SGR)) {
    push(line.slice(at, m.index));
    at = (m.index ?? 0) + m[0].length;
    for (const code of (m[1] || '0').split(';')) {
      if (code === '0' || code === '') styles = [];
      else if (CODES[code]) styles = [...styles.filter((s) => s !== CODES[code]), CODES[code]];
      else throw new Error(`a screen uses the terminal code ${code}, which the site does not draw yet: add it to lib/terminal/ansi.ts`);
    }
  }
  push(line.slice(at));
  return out;
}

/** Every line of the coloured text as runs. */
export const screenRuns = (ansi: string): Run[][] => ansi.split('\n').map(runs);
