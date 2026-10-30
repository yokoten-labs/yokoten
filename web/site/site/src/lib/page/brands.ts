// The icon, and for an agent its repository, of each name in the home page's "Works with" and "Runs on" rows,
// in the order of hero.works.items and hero.platforms.items (the names are the same in every
// language; the platforms are translated, so they match by place). The marks come from LobeHub's
// icon set (MIT), drawn in the text colour; Linux and Apple, which it lacks, from Simple Icons (CC0).
// Each agent links to where its maker publishes and installs it: the official repository, or for
// an agent with no source repository worth reading (Antigravity, Muse Code, Grok Build), its
// maker's own docs. It names
// what yokoten runs with, not a claim of partnership. The platforms are not links: everyone
// knows them, and their home pages say nothing about running yokoten.
import { siApple, siLinux } from 'simple-icons';
import claudecode from '@lobehub/icons-static-svg/icons/claudecode.svg?raw';
import antigravity from '@lobehub/icons-static-svg/icons/antigravity.svg?raw';
import codex from '@lobehub/icons-static-svg/icons/codex.svg?raw';
import deepseek from '@lobehub/icons-static-svg/icons/deepseek.svg?raw';
import githubcopilot from '@lobehub/icons-static-svg/icons/githubcopilot.svg?raw';
import grok from '@lobehub/icons-static-svg/icons/grok.svg?raw';
import microsoft from '@lobehub/icons-static-svg/icons/microsoft.svg?raw';
import muse from '@lobehub/icons-static-svg/icons/muse.svg?raw';
import opencode from '@lobehub/icons-static-svg/icons/opencode.svg?raw';
import { agents } from '../content/facts';

export interface Brand {
  /** The marks inside an SVG on a 24-unit grid, filled with the text colour. */
  body: string;
  /** The fill rule the mark was drawn with. */
  rule: 'evenodd' | 'nonzero';
  /** The agent's official repository; a platform has none. */
  url?: string;
}

/** A LobeHub file's paths, without its outer tag and title. */
function mark(svg: string): Pick<Brand, 'body' | 'rule'> {
  const open = svg.match(/^<svg[^>]*>/)?.[0] ?? '';
  const body = svg.slice(open.length).replace(/<\/svg>\s*$/, '').replace(/<title>[^<]*<\/title>/, '');
  if (!open || !body.includes('<path')) throw new Error('lib/page/brands.ts: an icon file is not a plain SVG of paths');
  return { body, rule: open.includes('fill-rule="evenodd"') ? 'evenodd' : 'nonzero' };
}
const path = (d: string): Pick<Brand, 'body' | 'rule'> => ({ body: `<path d="${d}"/>`, rule: 'nonzero' });

/**
 * Each home-page name, the README's name for the same agent (the "Works with" table, read into
 * agents.json), its mark and its page. The home page may list an agent only when that table says
 * it is verified end to end, so the site never promises more than the README.
 */
const WORKS: Record<string, Brand & { readme: string }> = {
  'Claude Code': { readme: 'Claude Code', ...mark(claudecode), url: 'https://github.com/anthropics/claude-code' },
  Codex: { readme: 'Codex CLI', ...mark(codex), url: 'https://github.com/openai/codex' },
  Copilot: { readme: 'GitHub Copilot CLI', ...mark(githubcopilot), url: 'https://github.com/github/copilot-cli' },
  Antigravity: { readme: 'Antigravity CLI', ...mark(antigravity), url: 'https://antigravity.google/docs/cli' },
  'Muse Code': { readme: 'Muse Code', ...mark(muse), url: 'https://dev.meta.ai/docs/muse-code' },
  OpenCode: { readme: 'OpenCode', ...mark(opencode), url: 'https://github.com/anomalyco/opencode' },
  Grok: { readme: 'Grok CLI', ...mark(grok), url: 'https://docs.x.ai/build/overview' },
  DeepSeek: { readme: 'DeepSeek Harness', ...mark(deepseek), url: 'https://github.com/deepseek-ai/deepseek-harness' },
};

const PLATFORMS: Brand[] = [
  path(siLinux.path),
  path(siApple.path),
  mark(microsoft),
  mark(microsoft),
];

/** The brands of a row, one per name. A name with no icon, or an agent the README does not verify, fails the build. */
export function brandsFor(row: 'works' | 'platforms', names: readonly string[]): Brand[] {
  if (row === 'platforms') {
    if (names.length !== PLATFORMS.length) throw new Error(`the home page lists ${names.length} platforms, lib/page/brands.ts has ${PLATFORMS.length}: give each one its icon`);
    return PLATFORMS;
  }
  return names.map((name) => {
    const brand = WORKS[name];
    if (!brand) throw new Error(`the home page lists "${name}" under works, which has no icon in lib/page/brands.ts`);
    const entry = agents.find((a) => a.agent === brand.readme);
    if (!entry?.verified) throw new Error(`the home page lists "${name}", but the README's Works with table does not mark ${brand.readme} verified: take it off the home page or verify it first`);
    return brand;
  });
}
