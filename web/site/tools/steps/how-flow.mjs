// The "How it works" picture: one task from you, through the lead and a desk worker, to the server.
// Two lanes read left to right as time: (1) the model answers (yokoten isn't there), (2) the guard
// checks each action before it runs, (3) the desk's sandbox limits what a worker reaches while it
// runs, (4) the server checks again when it lands. Writes site/src/content/generated/how/flow.svg (the
// picture, its moves as SMIL on one clock, colours from the page's tokens) and flow.json (where each
// step starts and stops on that clock). The step texts are page data, one list per language.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const T = {
  vars: { bg: 'var(--bg)', fg: 'var(--fg)', muted: 'var(--muted)', line: 'var(--line)', band: 'var(--band)', andon: 'var(--andon)', running: 'var(--running)' },
};
const SANS = 'IBM Plex Sans', MONO = 'IBM Plex Mono';
const t = (x, y, s, c, txt, o = {}) => `<text x="${x}" y="${y}" font-family="${o.mono ? MONO : SANS}" font-size="${s}" font-weight="${o.w ?? 400}" fill="${c}"${o.a ? ` text-anchor="${o.a}"` : ''}${o.ls ? ` letter-spacing="${o.ls}"` : ''}>${txt}</text>`;
const cap = (x, y, c, txt) => t(x, y, 11.5, c, txt, { a: 'middle', mono: true, w: 600, ls: 1.2 });

const robot = (x, y, k, c) => `<g transform="translate(${x} ${y}) scale(${k})" fill="none" stroke="${c}" stroke-width="${2 / k}" stroke-linecap="round" stroke-linejoin="round">
  <line x1="24" y1="22" x2="24" y2="15"/><circle cx="24" cy="13" r="2.5" fill="${c}" stroke="none"/><rect x="8" y="22" width="32" height="28" rx="8"/>
  <circle cx="19" cy="36" r="2.5" fill="${c}" stroke="none"/><circle cx="29" cy="36" r="2.5" fill="${c}" stroke="none"/></g>`;
const octagon = (cx, cy, r, c) => {
  const a = r * 0.414;
  return `<polygon points="${cx - a},${cy - r} ${cx + a},${cy - r} ${cx + r},${cy - a} ${cx + r},${cy + a} ${cx + a},${cy + r} ${cx - a},${cy + r} ${cx - r},${cy + a} ${cx - r},${cy - a}" fill="${c}"/>
  <rect x="${cx - r * 0.55}" y="${cy - r * 0.16}" width="${r * 1.1}" height="${r * 0.32}" rx="2" fill="#ffffff"/>`;
};
const folder = (x, y, c) => `<path d="M${x} ${y} h18 l5 6 h33 v30 h-56 z" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>`;
const person = (x, y, c) => `<g fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="${x}" cy="${y}" r="11"/><path d="M${x - 22} ${y + 40} a22 22 0 0 1 44 0"/></g>`;
const cloud = (x, y, c) => `<path d="M${x - 26} ${y + 14} a12 12 0 0 1 2 -23 a17 17 0 0 1 32 -5 a13 13 0 0 1 20 16 a11 11 0 0 1 -4 12 z" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>`;
const num = (x, y, n, c) => `<circle cx="${x}" cy="${y}" r="13" fill="${c.fg}"/>` + t(x, y + 5, 14, c.bg, n, { a: 'middle', w: 600 });
const badge = (x, y, n, c) => `<circle cx="${x}" cy="${y}" r="11" fill="${c.fg}" stroke="${c.bg}" stroke-width="2"/>` + t(x, y + 4.5, 12, c.bg, n, { a: 'middle', w: 600 });
const box = (x, y, w, h, c, title, sub) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${c.bg}" stroke="${c.fg}" stroke-width="2"/>`
  + cap(x + w / 2, y + h / 2 - 2, c.fg, title) + t(x + w / 2, y + h / 2 + 16, 11.5, c.muted, sub, { a: 'middle', mono: true });

// time marks: x of each step, shared by the guides and the axis
const STEP = { 1: 188, 2: 420, 3: 700, 4: 1070 };

function lane(c, mid, m, { worker }) {
  let s = '';
  if (worker) s += `<rect x="175" y="${mid - 120}" width="730" height="225" rx="20" fill="none" stroke="${c.fg}" stroke-width="2" stroke-dasharray="8 7"/>`
    + t(885, mid - 96, 12, c.fg, 'YOKOTEN SANDBOX', { a: 'end', mono: true, w: 600, ls: 1.2 }) + t(885, mid - 78, 11.5, c.muted, 'whole agent · model API only', { a: 'end', mono: true })
    + badge(742, mid - 100, '3', c);
  s += t(470, mid - 70, 18, c.fg, worker ? 'A desk worker' : 'The lead', { w: 600 })
    + t(470, mid - 48, 14, c.muted, worker ? 'One worker, one task, one yokoten sandbox.' : 'Plans, reviews, merges.');
  // ① the model answers; the harness turns the answer into an action
  s += `<path d="M152 ${mid} L218 ${mid}" fill="none" stroke="${c.fg}" stroke-width="2" marker-start="url(#a${m})" marker-end="url(#a${m})"/>`;
  const road = (d, w) => `<path d="${d}" fill="none" stroke="${c.fg}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<path d="${d}" fill="none" stroke="${c.band}" stroke-width="${w - 6}" stroke-linecap="round" stroke-linejoin="round"/>`;
  // ③ only a desk worker runs inside a yokoten sandbox; the lead gets one in issue #1163.
  // The vendor's sandbox (tested 2026-10-28): it wraps shell commands after the guard lets them
  // through, as the user set it; file edits skip it. It can't start inside a desk (Linux, macOS),
  // so there the yokoten sandbox replaces it (issue #1171).
  if (worker) s += cap(620, mid + 50, c.muted, 'VENDOR SANDBOX') + t(620, mid + 66, 11.5, c.muted, 'replaced by the yokoten sandbox', { a: 'middle', mono: true });
  s += road(`M250 ${mid} L800 ${mid}`, 24) + `<line x1="290" y1="${mid}" x2="770" y2="${mid}" stroke="${c.muted}" stroke-width="2" stroke-dasharray="10 12"/>`;
  s += `<rect x="220" y="${mid - 16}" width="62" height="42" fill="${c.bg}"/>` + robot(215, mid - 46, 1.45, c.fg)
    + cap(250, mid + 62, c.fg, 'AGENT') + (worker ? t(250, mid + 80, 11.5, c.muted, 'any vendor', { a: 'middle', mono: true }) : '');
  // ② the guard, before the action runs
  s += octagon(STEP[2], mid, 28, c.andon) + cap(STEP[2], mid + 62, c.fg, 'YOKOTEN GUARD') + cap(STEP[2], mid + 80, c.muted, worker ? 'worker rules' : 'lead rules');
  s += `<rect x="796" y="${mid - 16}" width="64" height="32" fill="${c.bg}"/>` + folder(800, mid - 18, c.fg) + cap(830, mid - 30, c.fg, worker ? 'ITS DESK FOLDER' : 'YOUR PROJECT');
  // the commit check is a git hook in the project: a commit is a command, so it runs in there too
  
  // ④ when it lands: only the lead pushes, and the server checks again out of the agent's reach
  if (worker) s += t(922, mid + 5, 12.5, c.muted, 'no push');
  else s += `<path d="M866 ${mid} L966 ${mid}" fill="none" stroke="${c.fg}" stroke-width="2" marker-end="url(#a${m})"/>` + t(914, mid - 10, 11.5, c.muted, 'push', { a: 'middle', mono: true })
    + box(970, mid - 32, 200, 64, c, 'THE SERVER', 'CI · branch rules');
  // the step badges, matching the time axis
  s += badge(190, mid + 22, '1', c) + badge(452, mid - 30, '2', c) + (worker ? '' : badge(970, mid - 32, '4', c));
  return s;
}

// ---- The data flow, animated: one loop, every packet on the same clock ----
let DUR = 40;
const f = (n) => n.toFixed(3);
/** A labelled packet that runs along `d` between t0 and t1 (parts of the loop), then fades. */
function packet(c, d, t0, t1, label, { colour = c.fg, side = 'top' } = {}) {
  const shown = `values="0;0;1;1;0;0" keyTimes="0;${f(t0)};${f(t0 + 0.004)};${f(t1 + 0.02)};${f(t1 + 0.03)};1"`;
  return `<g class="pkt" opacity="0"><animate attributeName="opacity" ${shown} dur="${DUR}s" repeatCount="indefinite"/>`
    + `<animateMotion path="${d}" keyPoints="0;0;1;1" keyTimes="0;${f(t0)};${f(t1)};1" calcMode="linear" dur="${DUR}s" repeatCount="indefinite"/>`
    + `<circle r="7" fill="${colour}" stroke="${c.bg}" stroke-width="2"/>` + pill(c, side === 'right' ? 14 : side === 'left' ? -label.length * 7.2 - 32 : -label.length * 3.6 - 9, side === 'top' ? -32 : side === 'below' ? 12 : -9, label, colour) + '</g>';
}
/** The packet's name on a filled tag, so it reads over the road. */
const pill = (c, x, y, label, colour) => `<rect x="${x}" y="${y}" width="${label.length * 7.2 + 18}" height="20" rx="10" fill="${colour}"/>` + t(x + label.length * 3.6 + 9, y + 14, 11.5, c.bg, label, { a: 'middle', mono: true, w: 600 });
/** A highlight that shows between t0 and t1. */
function glow(shape, t0, t1) {
  return `<g class="pkt" opacity="0">${shape}<animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;${f(t0)};${f(t0 + 0.15 / DUR)};${f(t1 - 0.15 / DUR)};${f(t1)};1" dur="${DUR}s" repeatCount="indefinite"/></g>`;
}
// The 14 steps of the process flow, played one move at a time. A plan is a list of moves
// with their own lengths; each starts when the one before ends, so nothing jumps. Every
// action leaves the agent, stops at the guard, then goes on. A caption under the picture
// says, in one plain line, what the current step is.
const LANE = 240, DESK = 480;
/** The way the server's results come back to the lead, red or green: it fixes or merges. */
const BACK = 'M1030 204 L1030 120 L266 120 L266 225';
const ASK = 'M402 212 L278 88';
function plan() {
  const ev = [];
  let t = 0.6, cap = null;
  const L = LANE, K = DESK;
  const add = (kind, dur, args, advance = true) => { ev.push({ kind, at: t, dur, ...args }); if (advance) t += dur + 0.25; };
  const caption = (text, step) => { if (cap) cap.end = t; cap = { kind: 'caption', at: t, text, step }; ev.push(cap); };
  const move = (d, dur, label, o) => add('move', dur, { d, label, o });
  const hold = (shape, dur, advance = true) => add('hold', dur, { shape }, advance);
  const toGuard = (mid) => `M282 ${mid} L392 ${mid}`;
  const onward = (mid) => `M448 ${mid} L800 ${mid} L962 ${mid}`;
  caption('1 · You give the lead a task.', 0);
  move('M250 108 L250 200', 1.4, 'task', { side: 'right' });
  caption("2 · The lead asks the model. yokoten doesn't read this.", 1);
  move(`M222 ${L} L158 ${L}`, 1.2, 'prompt'); move(`M158 ${L} L222 ${L}`, 1.2, 'answer');
  caption('3 · The lead opens a desk. The guard checks it first.', 2);
  move(toGuard(L), 1.2, 'yokoten desk'); hold({ ring: L, col: 'andon' }, 1.0); hold({ ring: L, col: 'running' }, 0.6);
  caption('4 · yokoten opens the desk: its own clone, in a sandbox.', 3);
  const open = t; t += 1.0;
  move(`M250 ${L + 30} L250 ${K - 36}`, 1.6, 'brief', { side: 'right' });
  caption('5 · The worker asks the model. Only the model API gets out.', 1);
  hold({ proxy: true }, 2.6, false);
  move(`M222 ${K} L158 ${K}`, 1.2, 'prompt'); move(`M158 ${K} L222 ${K}`, 1.2, 'answer');
  caption('6 · The worker tries to push. The guard stops it.', 2);
  move(toGuard(K), 1.2, 'git push', { colour: 'andon' }); hold({ ring: K, col: 'andon', note: 'stopped' }, 1.6);
  caption('6 · The worker edits a file. The guard lets it through.', 3);
  move(toGuard(K), 1.2, 'edit'); hold({ ring: K, col: 'running' }, 0.7); move(`M448 ${K} L800 ${K}`, 1.8, 'edit');
  caption('7 · It commits, and the commit check runs in the sandbox.', 3);
  hold({ at: [828, K + 30], note: 'commit check' }, 1.8);
  caption('8 · The desk runs the tests in the sandbox: evidence.', 3);
  hold({ at: [828, K + 30], note: 'tests → evidence' }, 2.0);
  caption('9 · The lead closes the desk and gets the evidence.', 0);
  move(`M250 ${K - 34} L250 ${L + 94}`, 1.8, 'evidence', { colour: 'running', side: 'left' });
  const close = t;
  caption('10 · The lead reviews the diff and runs the checks itself.', 0);
  hold({ at: [250, L - 70], note: 'review' }, 2.4);
  caption('11 · The lead opens a PR. It touches guard settings, so the guard asks you (coming).', 2);
  move(toGuard(L), 1.2, 'PR'); hold({ ring: L, col: 'andon', note: 'touches guard settings' }, 1.6);
  move(ASK, 2.0, 'ask you', { colour: 'andon', side: 'below' });
  hold({ at: [170, 20], note: 'you: yes', colour: 'running' }, 1.4);
  move(ASK, 2.0, 'yes', { colour: 'running', side: 'below', reverse: true }); hold({ ring: L, col: 'running' }, 0.7);
  caption('11 · With your yes, the PR goes to the server.', 4);
  move(onward(L), 2.2, 'PR');
  caption('12 · Round 1: the lead checks CI. It failed.', 4);
  hold({ server: 'andon', note: 'CI: fail' }, 1.6); move(BACK, 2.4, 'fail', { colour: 'andon' });
  caption('12 · The lead fixes it and pushes again, through the guard.', 2);
  hold({ at: [250, L - 70], note: 'fix' }, 1.4);
  move(toGuard(L), 1.2, 'fix'); hold({ ring: L, col: 'running' }, 0.7); move(onward(L), 2.2, 'fix');
  caption('12 · Round 2: the lead checks CI. It passed.', 4);
  hold({ server: 'running', note: 'CI: pass' }, 1.6); move(BACK, 2.4, 'pass', { colour: 'running' });
  caption('13 · The lead merges, then tells you.', 4);
  move(toGuard(L), 1.2, 'merge'); hold({ ring: L, col: 'running' }, 0.7); move(onward(L), 2.2, 'merge');
  hold({ server: 'running', note: 'merged' }, 1.4);
  move('M250 200 L250 108', 1.4, 'report', { side: 'left' });
  caption('14 · Only you release and tag.', 4);
  hold({ release: true }, 3.0);
  t += 1.0;
  cap.end = t;
  return { ev, total: t, open: [open, open + 0.8], close: [close, close + 0.8] };
}
const PLAN = plan();
DUR = PLAN.total;
const sec = (n) => n / DUR;
const OPEN = PLAN.open.map(sec), CLOSE = PLAN.close.map(sec);
function flows(c, L, K) {
  let s = '';
  const col = (name) => (name ? c[name] : c.fg);
  const ring = (x, y, r, k) => `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${k}" stroke-width="3"/>`;
  const G = (shape, a, b) => glow(shape, sec(a), sec(Math.min(b, DUR - 0.01)));
  const tag = (x, y, label, k) => pill(c, x - label.length * 3.6 - 9, y, label, k);
  for (const e of PLAN.ev) {
    const end = e.at + (e.dur ?? 0);
    if (e.kind === 'move') {
      const d = e.o?.reverse ? reversePath(e.d) : e.d;
      s += packet(c, d, sec(e.at), sec(end), e.label, { ...e.o, colour: col(e.o?.colour) });
    } else if (e.kind === 'hold') {
      const h = e.shape, k = col(h.colour ?? h.col);
      if (h.ring) s += G(ring(STEP[2], h.ring, 38, k), e.at, end) + (h.note ? G(tag(STEP[2], h.ring + 92, h.note, k), e.at, end) : '');
      if (h.at) s += G(tag(h.at[0], h.at[1], h.note, k), e.at, end);
      if (h.proxy) s += G(`<rect x="164" y="${K - 21}" width="22" height="42" rx="7" fill="none" stroke="${c.running}" stroke-width="3"/>` + pill(c, 160, K - 62, 'only the model API', c.running), e.at, end);
      if (h.server) s += G(`<rect x="966" y="${L - 36}" width="208" height="72" rx="13" fill="none" stroke="${col(h.server)}" stroke-width="3"/>` + tag(1070, L + 44, h.note, col(h.server)), e.at, end);
      if (h.release) s += G(`<path d="M286 44 L1070 44 L1070 204" fill="none" stroke="${c.andon}" stroke-width="4"/>` + tag(680, 34, 'release: only you', c.andon), e.at, end);
    } else if (e.kind === 'caption') {
      if (e.step) s += G(ring(STEP[e.step], 632, 20, c.andon), e.at, e.end);
    }
  }
  return s;
}
/** The same straight-line path, walked the other way. */
function reversePath(d) {
  const pts = [...d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)|Q\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/g)];
  const nodes = [];
  for (const m of pts) {
    if (m[1] !== undefined) nodes.push({ x: m[1], y: m[2] });
    else nodes.push({ cx: m[3], cy: m[4], x: m[5], y: m[6] });
  }
  let out = `M${nodes[nodes.length - 1].x} ${nodes[nodes.length - 1].y}`;
  for (let i = nodes.length - 1; i > 0; i--) {
    const n = nodes[i], prev = nodes[i - 1];
    out += n.cx !== undefined ? ` Q${n.cx} ${n.cy} ${prev.x} ${prev.y}` : ` L${prev.x} ${prev.y}`;
  }
  return out;
}

function draw(m, { anim = false } = {}) {
  const c = T[m], W = 1200, H = 730;
  const LEAD = 240, WORKER = 480;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${c.bg}"/>`;
  s += `<defs><marker id="a${m}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.6"/></marker></defs>`;
  // the model, one for both lanes
  s += `<rect x="30" y="${LEAD - 60}" width="122" height="${WORKER - LEAD + 120}" rx="14" fill="${c.band}" stroke="${c.fg}" stroke-width="2"/>`
    + cloud(91, 330, c.fg) + cap(91, 378, c.fg, 'MODEL API') + t(91, 396, 11.5, c.muted, 'Base URL', { a: 'middle', mono: true })
    ;
  // you talk with the lead; only you release and tag
  s += person(250, 30, c.fg) + cap(250, 94, c.fg, 'YOU');
  s += `<path d="M250 104 L250 208" fill="none" stroke="${c.fg}" stroke-width="2" marker-start="url(#a${m})" marker-end="url(#a${m})"/>` + t(238, 150, 12.5, c.fg, 'you talk', { a: 'end', mono: true });
  s += `<path d="M286 44 L1070 44 L1070 204" fill="none" stroke="${c.andon}" stroke-width="2" stroke-dasharray="5 5" marker-end="url(#a${m})"/>` + t(310, 36, 12.5, c.andon, 'only you: releases and tags', { mono: true });
  s += `<path d="${BACK}" fill="none" stroke="${c.muted}" stroke-width="2" marker-end="url(#a${m})"/>` + t(1020, 112, 11.5, c.muted, 'results', { a: 'end', mono: true });
  s += lane(c, LEAD, m, { worker: false });
  // animated, the worker's lane stays dim until the lead opens its desk
  const dim = anim ? `<animate attributeName="opacity" values="0.2;0.2;1;1;0.2;0.2" keyTimes="0;${OPEN[0]};${OPEN[1]};${CLOSE[0]};${CLOSE[1]};1" dur="${DUR}s" repeatCount="indefinite"/>` : '';
  s += `<g${anim ? ' opacity="0.2"' : ''}>${dim}${lane(c, WORKER, m, { worker: true })}</g>`;
  s += `<path d="${ASK}" fill="none" stroke="${c.andon}" stroke-width="2" stroke-dasharray="5 5" marker-start="url(#a${m})" marker-end="url(#a${m})"/>` + t(346, 150, 12.5, c.andon, 'asks you (coming)', { mono: true });
  // reports go up as data
  s += `<path d="M250 446 L250 330" fill="none" stroke="${c.running}" stroke-width="2" stroke-dasharray="4 4" marker-start="url(#a${m})" marker-end="url(#a${m})"/>` + t(262, 350, 12.5, c.running, 'brief · messages', { mono: true });
  // the time axis
  s += `<path d="M30 632 L1170 632" fill="none" stroke="${c.muted}" stroke-width="2" marker-end="url(#a${m})"/>` + t(1170, 618, 11.5, c.muted, 'TIME', { a: 'end', mono: true, w: 600, ls: 1.2 });
  const steps = [
    [1, 'The model answers', "yokoten doesn't read it"],
    [2, 'Before it runs', 'guard: allow, deny or ask'],
    [3, 'While it runs', 'sandbox: what it can reach'],
    [4, 'When it lands', 'the server checks again'],
  ];
  for (const [n, a, b] of steps) s += num(STEP[n], 632, String(n), c) + t(STEP[n], 670, 15, c.fg, a, { a: 'middle', w: 600 }) + t(STEP[n], 692, 13, c.muted, b, { a: 'middle' });
  if (anim) s += flows(c, LEAD, WORKER);
  return s + '</svg>';
}
const svg = draw('vars', { anim: true }).replace('<svg ', '<svg class="flow-svg" aria-hidden="true" ');
// Each caption is a step: where it starts, and where to stop so its last move or hold still shows.
const caps = PLAN.ev.filter((e) => e.kind === 'caption');
const steps = caps.map((cap) => {
  const inside = PLAN.ev.filter((e) => e.kind !== 'caption' && e.at >= cap.at && e.at < cap.end);
  const last = Math.max(cap.at + 0.5, ...inside.map((e) => e.at + e.dur));
  return { n: Number(cap.text.match(/^(\d+) · /)[1]), at: cap.at, stop: Number((last - 0.1).toFixed(3)) };
});
const dir = join(dirname(fileURLToPath(import.meta.url)), '../../site/src/content/generated/how');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'flow.svg'), svg + '\n');
writeFileSync(join(dir, 'flow.json'), JSON.stringify({ total: PLAN.total, steps }, null, 2) + '\n');
console.log(`how-flow: ${steps.length} steps, ${PLAN.total.toFixed(1)} s`);
