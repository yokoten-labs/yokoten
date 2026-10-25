import { finding, type Finding } from '../../message.ts';
import { ASSIGNERS, base, programName, quotedWords } from './read/words.ts';
import { arithmeticCommands } from './read/read.ts';

// ---- Code the reader cannot see (#457) ----
//
// bash ran code the guard never read: a command substitution carried inside single quotes
// reaches it through PS4, an arithmetic expression, an indirect expansion, a loop variable
// or a `printf -v` name; a program name comes from a variable or a glob. Each of these is
// refused, not guessed, the way record 0014 asks. The differential test beside this file
// compares the guard with what bash really does.

const HIDDEN_FIX = 'write the program as a plain name and the value as plain text; if the task needs more, stop and ask the lead';
const hiddenCode = (what: string) => finding('hidden-code', what, HIDDEN_FIX);
const hasShellCode = (text: string) => text.includes('$(') || text.includes('`');
const hasExpansion = (text: string) => /[$`[]/.test(text);

/** A name the command sets, and whether its value is plain text the guard can read. */
function commandVariables(commands: string[][]): Map<string, boolean> {
  // `a[1]` is a plain subscript; a `$`, a backtick or a name in the subscript is not.
  const isPlainValue = (value: string) =>
    !/[$`]/.test(value) && [...value.matchAll(/\[([^\]]*)\]/g)].every(([, subscript]) => PLAIN_SUBSCRIPT.test(subscript));
  const variables = new Map<string, boolean>();
  for (const words of commands) {
    for (const [index, word] of words.entries()) {
      const assignment = /^([A-Za-z_]\w*)\+?=(.*)$/s.exec(word);
      // An assignment on its own, or after export, declare, local and the like.
      if (assignment && (index === 0 || ASSIGNERS.has(base(words[index - 1])))) variables.set(assignment[1], isPlainValue(assignment[2]));
    }
    // A loop variable holds each word of its list; a word bash would expand reaches the
    // arithmetic here too: `for X in 'a[$(…)]'; do echo $((X)); done` (#457).
    if ((words[0] === 'for' || words[0] === 'select') && /^[A-Za-z_]\w*$/.test(words[1] ?? '')) {
      const inAt = words.indexOf('in');
      variables.set(words[1], inAt !== -1 && words.slice(inAt + 1).every(isPlainValue));
    }
  }
  return variables;
}

/** The name after `printf -v`, `test -v`, `[ -v` or `[[ -v`, when the command has one. */
function verifiedName(words: string[]): string | undefined {
  for (const [index, word] of words.entries()) {
    if (word === 'printf' && words[index + 1] === '-v') return words[index + 2];
    if (word === 'printf' && /^-v./.test(words[index + 1] ?? '')) return words[index + 1].slice(2);
    if ((word === 'test' || word === '[' || word === '[[') && words[index + 1] === '-v') return words[index + 2];
  }
  return undefined;
}

const PLAIN_NAME = /^[A-Za-z_]\w*(?:\[\d+\])?$/;
const PLAIN_SUBSCRIPT = /^[\d+\-*/% ]+$/;
const NAME_IN_EXPRESSION = /[A-Za-z_]\w*/g;
const GLOB_OPTION_PROGRAMS = new Set(['git', 'sort', 'less', 'curl', 'wget']);

/** Whether every glob character in the word was quoted, so bash expands no file there (#457). */
function isQuotedGlob(words: string[], index: number): boolean {
  const word = words[index];
  const spans = quotedWords.get(words)?.get(index) ?? [];
  for (let position = 0; position < word.length; position++) {
    if (!/[*?[]/.test(word[position])) continue;
    if (!spans.some(([start, end]) => position >= start && position < end)) return false;
  }
  return true;
}

/** The first value bash would run code from, or the first program name the guard cannot read. */
export function checkHiddenCode(commands: string[][]): Finding | null {
  const variables = commandVariables(commands);
  const isHidden = (name: string) => variables.get(name) === false;
  const anyHidden = (text: string) => [...text.matchAll(NAME_IN_EXPRESSION)].some(([name]) => isHidden(name));
  // `((…))` is one arithmetic expression to bash, and a name in it may hold a subscript.
  for (const expression of arithmeticCommands.get(commands) ?? []) {
    if (hasExpansion(expression) || anyHidden(expression)) return hiddenCode(`does arithmetic on \`${expression.trim()}\`, and bash runs the code it may hold`);
  }
  for (const words of commands) {
    const verified = verifiedName(words);
    if (verified !== undefined && !PLAIN_NAME.test(verified)) {
      return hiddenCode(`gives \`${verified}\` to bash as a name, and bash evaluates a subscript there`);
    }
    // `let` reads every word after it as an arithmetic expression, subscripts and all.
    // Read the words here rather than through findProgramPlaces, which spends the reader's
    // budget again for every command (#226).
    const letAt = words.findIndex((word) => programName(word) === 'let');
    if (letAt !== -1) {
      for (const expression of words.slice(letAt + 1)) {
        if (hasExpansion(expression) || anyHidden(expression)) return hiddenCode(`gives \`${expression}\` to let, and bash runs the code it may hold`);
      }
    }
    for (const word of words) {
      // A shell setting whose value bash runs again later, such as PS4 at the next `set -x`.
      // The value may be plain text or a name that holds the substitution (#457).
      const assignment = /^([A-Za-z_]\w*)\+?=(.*)$/s.exec(word);
      if (assignment && /^(?:PS\d|PROMPT_COMMAND)$/.test(assignment[1]) && (hasShellCode(assignment[2]) || anyHidden(assignment[2]))) {
        return hiddenCode(`sets ${assignment[1]} to a substitution, and bash runs it when it traces the next command`);
      }
      // A name with a subscript: bash evaluates the subscript as arithmetic, code and all.
      const subscript = /^([A-Za-z_]\w*)\[([^\]]*)\](?:\+?=)/.exec(word);
      if (subscript && !PLAIN_SUBSCRIPT.test(subscript[2])) {
        return hiddenCode(`assigns to ${subscript[1]}[${subscript[2]}], and bash evaluates that subscript`);
      }
      // An indirect name or a subscript in an expansion.
      for (const [, name] of word.matchAll(/\$\{!([A-Za-z_]\w*)\}/g)) {
        if (variables.get(name) !== true) return hiddenCode(`expands \${!${name}}, so bash reads the name in ${name} instead of the one written`);
      }
      for (const [, name, sub] of word.matchAll(/\$\{([A-Za-z_]\w*)\[([^\]]*)\]\}/g)) {
        if (!PLAIN_SUBSCRIPT.test(sub) && (anyHidden(sub) || hasExpansion(sub))) {
          return hiddenCode(`expands ${name}[${sub}], and bash evaluates that subscript`);
        }
      }
      // `${name:expression}` is arithmetic: an offset from a name bash cannot see, as in
      // `X='a[$(…)]'; echo ${HOME:X}`, runs the substitution.
      for (const [, body] of word.matchAll(/\$\{[A-Za-z_]\w*:([^}]*)\}/g)) {
        if (!/^[-+=?]/.test(body) && (hasExpansion(body) || anyHidden(body))) {
          return hiddenCode('expands a value with an arithmetic offset the guard cannot see');
        }
      }
      for (const [, parens, brackets] of word.matchAll(/\$\(\(([^)]*)\)\)|\$\[([^\]]*)\]/g)) {
        const body = parens ?? brackets ?? '';
        if (hasExpansion(body) || anyHidden(body)) return hiddenCode(`does arithmetic on \`${body}\`, and bash runs the code it may hold`);
      }
    }
    // A program word from a variable is left to the pipe-to-shell rule, which refuses it
    // when a download feeds it (#560); a plain `$sh` is allowed, as before.
    // A glob may expand to a file whose name is an option that writes a file (#413). That
    // includes a glob that already looks like an option: `git log --out*` (#457).
    const at = words.findIndex((word) => GLOB_OPTION_PROGRAMS.has(programName(word)));
    if (at !== -1) {
      const program = programName(words[at]);
      let needsSubcommand = program === 'git';
      for (let index = at + 1; index < words.length; index++) {
        const word = words[index];
        if (word === '--') break;
        if (needsSubcommand) {
          if (!word.startsWith('-')) needsSubcommand = false;
          continue;
        }
        if (!/\s/.test(word) && !word.includes('://') && /[*?[]/.test(word) && !isQuotedGlob(words, index)) {
          return hiddenCode(`gives \`${word}\` to ${program}, and a file may expand to an option that writes one`);
        }
      }
    }
  }
  return null;
}
