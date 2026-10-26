// Which AI a desk starts (issue #1054): only one that is installed, Claude Code first;
// `--agent` picks another. Each agent says how it starts with a brief: interactive (the
// person watches and can type) or headless (it runs alone, its output to a log).

/** One AI a desk can start. `runtime` is its name in the desk's fence (agents/desk/desk.ts). */
export interface DeskAgent {
  runtime: string;
  label: string;
  program: string;
  /** The words that start it with the brief as its first prompt, for a person to watch. */
  interactive: (brief: string) => string[];
  /** The words that start it alone, with the brief, printing as it goes. */
  headless: (brief: string) => string[];
}

/** The agents a desk starts, in the order it picks them. */
export const DESK_AGENTS: readonly DeskAgent[] = [
  { runtime: 'claude-code', label: 'Claude Code', program: 'claude', interactive: (brief) => ['claude', brief], headless: (brief) => ['claude', '-p', brief] },
  { runtime: 'codex', label: 'Codex', program: 'codex', interactive: (brief) => ['codex', brief], headless: (brief) => ['codex', 'exec', brief] },
];

/**
 * The agent to start: the one `asked` names, else the first installed. `isInstalled` tells
 * whether a program is on PATH. Else one plain line that says what to do.
 */
export function pickAgent(asked: string | undefined, isInstalled: (program: string) => boolean): DeskAgent | { problem: string } {
  if (asked !== undefined) {
    const agent = DESK_AGENTS.find((one) => one.runtime === asked);
    if (!agent) return { problem: `--agent ${asked}: a desk starts ${DESK_AGENTS.map((one) => one.runtime).join(' or ')}.` };
    return isInstalled(agent.program) ? agent : { problem: `${agent.label} is not installed here: \`${agent.program}\` is not on PATH.` };
  }
  return DESK_AGENTS.find((one) => isInstalled(one.program)) ?? { problem: `no AI to start: install Claude Code (\`npm install -g @anthropic-ai/claude-code\`), then run this again.` };
}
