// The facts the pages show, as tools/steps/from-package.mjs read them from the yokoten package.
// A static import: when a file is missing, the build fails here.
import agents from '../../content/generated/facts/agents.json';
import commands from '../../content/generated/facts/commands.json';
import rules from '../../content/generated/facts/rules.json';
import screens from '../../content/generated/facts/screens.json';
import stages from '../../content/generated/facts/stages.json';
import version from '../../content/generated/facts/version.json';

export type ScreenKey = keyof typeof screens;
export { agents, commands, rules, screens, stages, version };

/** The commands `yokoten help` shows, in its order. */
export const shownCommands = commands.commands.filter((c) => c.shown === 'always');
/** The rules the tool-call guard holds. */
export const guardRules = rules.filter((r) => r.guard);

export const LINKS = {
  github: 'https://github.com/yokoten-labs/yokoten',
  npm: 'https://www.npmjs.com/package/yokoten',
  guide: 'https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md',
  changelog: 'https://github.com/yokoten-labs/yokoten/blob/main/CHANGELOG.md',
  nodeAdvisory: 'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases',
};

/** The promo's files under their hashed names, written by tools/promo/scripts/publish.mjs. */
export { default as PROMO } from '../../content/promo.json';
