// The "How it works" picture: the delete next door, in 8 steps. You turn on your agent's own
// sandbox with npx yokoten. The agent edits a file in the project; the sandbox refuses rm -rf on
// the folder next door; the guard stops a force push; the commit check and then CI look for
// secrets; only you tag. Each step lights its nodes and its arrow: green when allowed or passed,
// red when stopped. Writes site/src/content/generated/how/flow.svg (the picture, each step's light
// as SMIL on one clock, colours from the page's tokens) and flow.json (where each step starts and
// stops on that clock). The step texts are page data, one list per language.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const c = { bg: 'var(--bg)', fg: 'var(--fg)', muted: 'var(--muted)', line: 'var(--line)', band: 'var(--band)', andon: 'var(--andon)', running: 'var(--running)' };
const SANS = 'IBM Plex Sans', MONO = 'IBM Plex Mono';
const t = (x, y, s, colour, txt, o = {}) => `<text x="${x}" y="${y}" font-family="${o.mono ? MONO : SANS}" font-size="${s}" font-weight="${o.w ?? 400}" fill="${colour}"${o.a ? ` text-anchor="${o.a}"` : ''}${o.ls ? ` letter-spacing="${o.ls}"` : ''}>${txt}</text>`;
const cap = (x, y, colour, txt) => t(x, y, 11.5, colour, txt, { a: 'middle', mono: true, w: 600, ls: 1.2 });
const sub = (x, y, txt) => t(x, y, 11.5, c.muted, txt, { a: 'middle', mono: true });

const robot = (x, y, k, colour) => `<g transform="translate(${x} ${y}) scale(${k})" fill="none" stroke="${colour}" stroke-width="${2 / k}" stroke-linecap="round" stroke-linejoin="round">
  <line x1="24" y1="22" x2="24" y2="15"/><circle cx="24" cy="13" r="2.5" fill="${colour}" stroke="none"/><rect x="8" y="22" width="32" height="28" rx="8"/>
  <circle cx="19" cy="36" r="2.5" fill="${colour}" stroke="none"/><circle cx="29" cy="36" r="2.5" fill="${colour}" stroke="none"/></g>`;
const octagon = (cx, cy, r, colour) => {
  const a = r * 0.414;
  return `<polygon points="${cx - a},${cy - r} ${cx + a},${cy - r} ${cx + r},${cy - a} ${cx + r},${cy + a} ${cx + a},${cy + r} ${cx - a},${cy + r} ${cx - r},${cy + a} ${cx - r},${cy - a}" fill="${colour}"/>
  <rect x="${cx - r * 0.55}" y="${cy - r * 0.16}" width="${r * 1.1}" height="${r * 0.32}" rx="2" fill="#ffffff"/>`;
};
const folder = (x, y, colour) => `<path d="M${x} ${y} h18 l5 6 h33 v30 h-56 z" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round"/>`;
const person = (x, y, colour) => `<g fill="none" stroke="${colour}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="${x}" cy="${y}" r="11"/><path d="M${x - 22} ${y + 40} a22 22 0 0 1 44 0"/></g>`;
const box = (x, y, w, h, title, text) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${c.bg}" stroke="${c.fg}" stroke-width="2"/>`
  + cap(x + w / 2, y + h / 2 - 2, c.fg, title) + sub(x + w / 2, y + h / 2 + 16, text);
/** A name on a filled tag, so it reads over the lines; centred on x. */
const pill = (x, y, label, colour) => {
  const w = label.length * 7.2 + 18;
  return `<rect x="${x - w / 2}" y="${y}" width="${w}" height="20" rx="10" fill="${colour}"/>` + t(x, y + 14, 11.5, c.bg, label, { a: 'middle', mono: true, w: 600 });
};

const W = 1200, H = 640;

/** The outline each node gets when its step lights it. */
const NODE = {
  you: { x: 50, y: 32, w: 100, h: 112 },
  sandbox: { x: 240, y: 30, w: 520, h: 350 },
  agent: { x: 280, y: 160, w: 110, h: 122 },
  project: { x: 588, y: 176, w: 120, h: 100 },
  nextDoor: { x: 898, y: 176, w: 160, h: 120 },
  guard: { x: 255, y: 458, w: 160, h: 126 },
  commit: { x: 534, y: 464, w: 222, h: 76 },
  github: { x: 894, y: 464, w: 232, h: 76 },
};

/** The arrows: where each action goes, and its short name on the picture. */
const ARROW = {
  setup: { d: 'M152 70 L236 70', label: [194, 60, 'npx yokoten'] },
  task: { d: 'M150 112 L292 186', label: [232, 140, 'task', 'start'] },
  edit: { d: 'M386 214 L610 214', label: [498, 204, 'edit a file'] },
  // lit, it stops at the sandbox's wall: the delete never reaches next door
  rm: { d: 'M335 162 L335 118 L978 118 L978 188', lit: 'M335 162 L335 118 L752 118', label: [548, 108, 'rm -rf ../next-door'] },
  push: { d: 'M335 290 L335 464', label: [347, 420, 'git push --force', 'start'] },
  commit: { d: 'M386 282 L556 462', label: [484, 372, 'git commit', 'start'] },
  pr: { d: 'M756 502 L890 502', label: [823, 492, 'pull request'] },
  tag: { d: 'M62 150 L62 614 L1010 614 L1010 544', label: [540, 606, 'git tag v1.0.0 · you only'], colour: c.andon },
};

/**
 * The 8 steps: the nodes each lights, its arrow, and its result: ok (allowed or passed),
 * no (stopped), or none. A result tag says it in one word, at the place that decided.
 */
const STEPS = [
  { nodes: ['you', 'sandbox', 'agent'], arrow: 'setup', result: 'none' },
  { nodes: ['you', 'agent'], arrow: 'task', result: 'none' },
  { nodes: ['agent', 'project'], arrow: 'edit', result: 'ok', tag: [648, 286, 'allowed'] },
  { nodes: ['agent', 'nextDoor', 'sandbox'], arrow: 'rm', result: 'no', tag: [868, 132, 'refused: read-only'] },
  { nodes: ['agent', 'guard'], arrow: 'push', result: 'no', tag: [454, 490, 'stopped'] },
  { nodes: ['agent', 'commit'], arrow: 'commit', result: 'ok', tag: [645, 548, 'passed'] },
  { nodes: ['commit', 'guard', 'github'], arrow: 'pr', result: 'ok', tag: [1010, 548, 'CI passed'] },
  { nodes: ['you', 'github'], arrow: 'tag', result: 'ok', tag: [1010, 440, 'v1.0.0'] },
];

// ---- The clock: each step gets the same length, one after the other ----
const STEP_SECONDS = 3.2, GAP = 0.3;
let clock = 0.6;
const PLAN = STEPS.map((step, i) => {
  const at = clock;
  clock += STEP_SECONDS + GAP;
  return { ...step, n: i + 1, at, end: at + STEP_SECONDS };
});
const DUR = clock + 0.7;
const f = (n) => n.toFixed(3);
const sec = (n) => n / DUR;
/** A highlight that shows between t0 and t1 seconds on the clock. */
function glow(shape, t0, t1) {
  const a = sec(t0), b = sec(Math.min(t1, DUR - 0.01)), fade = 0.15 / DUR;
  return `<g class="pkt" opacity="0">${shape}<animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;${f(a)};${f(a + fade)};${f(b - fade)};${f(b)};1" dur="${f(DUR)}s" repeatCount="indefinite"/></g>`;
}
const COLOUR = { ok: c.running, no: c.andon, none: c.fg };

function lights() {
  let s = '';
  for (const step of PLAN) {
    const colour = COLOUR[step.result];
    const arrow = ARROW[step.arrow];
    // first the arrow, then the nodes it reaches, then the result
    const end = arrow.lit ? '' : ' marker-end="url(#arrow)"';
    s += glow(`<path d="${arrow.lit ?? arrow.d}" fill="none" stroke="${colour}" stroke-width="4" stroke-linejoin="round"${end}/>`, step.at, step.end);
    for (const name of step.nodes) {
      const n = NODE[name];
      s += glow(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="14" fill="none" stroke="${colour}" stroke-width="3"/>`, step.at + 0.5, step.end);
    }
    if (step.tag) s += glow(pill(step.tag[0], step.tag[1], step.tag[2], colour), step.at + 1.1, step.end);
  }
  return s;
}

function draw() {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${c.bg}"/>`;
  s += `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.6"/></marker></defs>`;
  // the agent's own sandbox, around the agent and the project only
  s += `<rect x="240" y="30" width="520" height="350" rx="20" fill="${c.band}" stroke="${c.fg}" stroke-width="2" stroke-dasharray="8 7"/>`
    + t(262, 60, 12, c.fg, 'SANDBOX', { mono: true, w: 600, ls: 1.2 }) + t(262, 78, 11.5, c.muted, "your agent's own, turned on", { mono: true });
  // the arrows, quiet until a step lights one
  for (const arrow of Object.values(ARROW)) {
    const colour = arrow.colour ?? c.muted;
    const [x, y, label, anchor = 'middle'] = arrow.label;
    s += `<path d="${arrow.d}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round"${arrow.colour ? ' stroke-dasharray="5 5"' : ''} marker-end="url(#arrow)"/>`
      + t(x, y, 12.5, arrow.colour ?? c.fg, label, { a: anchor, mono: true });
  }
  // where rm -rf meets the sandbox's wall: it can't write past it
  s += `<path d="M752 110 L768 126 M768 110 L752 126" stroke="${c.andon}" stroke-width="3" stroke-linecap="round"/>`;
  // the nodes
  s += person(100, 62, c.fg) + cap(100, 132, c.fg, 'YOU');
  s += `<rect x="296" y="168" width="78" height="80" fill="${c.band}"/>` + robot(300, 170, 1.45, c.fg) + cap(335, 268, c.fg, 'YOUR AGENT');
  s += `<rect x="616" y="190" width="64" height="46" fill="${c.band}"/>` + folder(620, 196, c.fg) + cap(648, 262, c.fg, 'your-project/');
  s += `<rect x="946" y="190" width="64" height="46" fill="${c.bg}"/>` + folder(950, 196, c.fg) + cap(978, 262, c.fg, 'next-door/') + sub(978, 280, 'your other project');
  s += octagon(335, 500, 28, c.andon) + cap(335, 550, c.fg, 'GUARD') + sub(335, 568, 'before each action');
  s += box(540, 470, 210, 64, 'COMMIT CHECK', 'secrets · privacy');
  s += box(900, 470, 220, 64, 'GITHUB', 'CI runs the check');
  return s + lights() + '</svg>';
}

const svg = draw().replace('<svg ', '<svg class="flow-svg" aria-hidden="true" ');
// Each step: where it starts, and where to stop so its light still shows.
const steps = PLAN.map((step) => ({ n: step.n, at: Number(step.at.toFixed(3)), stop: Number((step.end - 0.1).toFixed(3)) }));
const dir = join(dirname(fileURLToPath(import.meta.url)), '../../site/src/content/generated/how');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'flow.svg'), svg + '\n');
writeFileSync(join(dir, 'flow.json'), JSON.stringify({ total: Number(DUR.toFixed(3)), steps }, null, 2) + '\n');
console.log(`how-flow: ${steps.length} steps, ${DUR.toFixed(1)} s`);
