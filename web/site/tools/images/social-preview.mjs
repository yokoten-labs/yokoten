// The share images, from one source: the site's og images (1200x630) and the repo's GitHub
// preview (1280x640). Copied from the brand source (yokoten-mascot/brand-andon/brand.mjs,
// Fable 5.1, 2026-10-28) so the site owns it: the guard mark with the wordmark, the one sentence, and
// the two real screens (the refusal on a red cord, the first run on a green one).
// Fonts are the machine's: IBM Plex Sans, Sans Condensed and Mono, and Noto Sans CJK SC.
//   import { renderPreview } from './social-preview.mjs'
//   node tools/images/social-preview.mjs <en|zh> <out.png> [width height]
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { guardInner } from '../steps/mark.mjs';

export const C = { ink: '#171717', paper: '#ffffff', red: '#d7392b', amber: '#e9b949', green: '#2f8f5b', grey: '#666666', rule: '#ebebeb', card: '#e6e1d6' };
const SANS = 'IBM Plex Sans', COND = 'IBM Plex Sans Condensed', MONO = 'IBM Plex Mono', CJK = 'Noto Sans CJK SC';
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The mark comes from tools/steps/mark.mjs, the one source for every place the logo is drawn.
export const mark = (x, y, size, { colour = C.ink } = {}) => `<g transform="translate(${x} ${y}) scale(${size / 512})">${guardInner({ colour, id: `og${x}${y}` })}</g>`;

// The wordmark alone, as in the site header: 横展 lives beside its explanation, not on a first glance.
export const wordmark = (x, y, size, colour = C.ink) => `
  <text x="${x}" y="${y}" font-family="${SANS}" font-size="${size}" font-weight="700" letter-spacing="-${size * 0.02}" fill="${colour}">yokoten</text>`;

// The refusal card: the CLI's real text (captured "guard, force push"), on ink, a red cord down the left.
export const refusal = (x, y, w, h, fs = 15) => {
  const L = fs * 1.7, P = C.paper;
  const lines = [
    [['$ ', C.grey], ['git push -f origin main', P]], [],
    [['yokoten stopped this: ', C.red, 700], ['git push -f forces the push', C.red, 700]], [['  [force-push]', C.red]], [],
    [['  Why       ', P, 700], ['A plain force push can throw away work', P]], [['            ', P], ['that someone else pushed.', P]], [],
    [['  Instead   ', P, 700], ['Use --force-with-lease, which stops when', P]], [['            ', P], ['the remote has work you have not seen.', P]],
  ];
  return `<g transform="translate(${x} ${y})"><rect width="${w}" height="${h}" rx="6" fill="${C.ink}"/><rect width="6" height="${h}" fill="${C.red}"/>
    ${lines.map((parts, i) => parts.length ? `<text x="${fs * 1.6}" y="${fs * 2.4 + i * L}" font-family="${MONO}" font-size="${fs}" xml:space="preserve">${parts.map(([t, c, wgt]) => `<tspan fill="${c}"${wgt ? ` font-weight="${wgt}"` : ''}>${esc(t)}</tspan>`).join('')}</text>` : '').join('\n')}
  </g>`;
};

// The first-run screen, pasted from the CI-captured "first run" (yokoten 0.1.1); the v0.1.2 build pastes its own.
export const firstRun = (x, y, w, h, fs = 13) => {
  const L = fs * 1.7, P = C.paper, G = C.green, A = C.amber;
  // The marks as a terminal shows them (the capture's colour copy): ✔ before ok, ✘ before MISSING, in the mark's column.
  const row = (mark, text, colour) => [[`  ${(mark === 'ok' ? '✔ ok' : mark === 'MISSING' ? '✘ MISSING' : mark).padEnd(12)}`, colour, 700], [text, P]];
  const lines = [
    [['$ ', C.grey], ['npx yokoten', P]], [],
    [['yokoten 0.1.1 · set up; stage 1 of 5, safety net', P, 700]], [],
    row('ok', 'guard on for Claude Code on this computer', G),
    row('ok', '18 files written in this project, none of yours changed', G), [],
    row('MISSING', '~/.config/yokoten/private-marks is missing or has no marks', C.red),
    [['              ', P], ['Type your name, your city or a domain; it is not shown.', P]],
    [['              ', P], ['Fix: `npx yokoten marks add`', P]],
  ];
  return `<g transform="translate(${x} ${y})"><rect width="${w}" height="${h}" rx="6" fill="${C.ink}"/><rect width="6" height="${h}" fill="${C.green}"/>
    ${lines.map((parts, i) => parts.length ? `<text x="${fs * 1.6}" y="${fs * 2.4 + i * L}" font-family="${MONO}" font-size="${fs}" xml:space="preserve">${parts.map(([t, c, wgt]) => `<tspan fill="${c}"${wgt ? ` font-weight="${wgt}"` : ''}>${esc(t)}</tspan>`).join('')}</text>` : '').join('\n')}
  </g>`;
};

const tag = (x, y, text, fill = C.amber, ink = C.ink) => `<rect x="${x}" y="${y}" width="${text.length * 10.5 + 26}" height="30" rx="3" fill="${fill}"/><text x="${x + 13}" y="${y + 20}" font-family="${MONO}" font-size="14" font-weight="700" fill="${ink}">${esc(text)}</text>`;

// ---- The share image (1280x640). One message, three levels, whitespace: the lockup, one sentence,
// one command. Rules borrowed from IBM Carbon (8 px grid, expressive type: display 84/92, body 28,
// IBM Plex) and GitHub Primer (one accent, grey for secondary text). Nothing else on it.
export function preview({ lang = 'en', width = 1280, height = 640 } = {}) {
  const W = 1280, H = 640, M = 80;
  // Drawn for 1280x640; another size scales to the width and centres the drawing.
  const vbH = (W * height) / width, dy = (vbH - H) / 2;
  const T = lang === 'zh'
    ? { h: ['拦住 AI agent', '那些收不回来的错误。'], font: CJK, size: 80, lh: 96, sub: '一条命令，不用设置。免费，MIT。', subFont: CJK }
    : { h: ['Stops the mistake', 'you can’t undo.'], font: COND, size: 84, lh: 92, sub: 'One command, no setup. Free, MIT.', subFont: SANS };
  const y1 = 268;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${W} ${vbH}">
  <rect width="${W}" height="${vbH}" fill="${C.paper}"/>
  <g transform="translate(0 ${dy})">
  ${mark(M, 72, 40)}${wordmark(M + 56, 104, 28)}
  <text font-family="${T.font}" font-size="${T.size}" font-weight="700" fill="${C.ink}" letter-spacing="-1">${T.h.map((l, i) => `<tspan x="${M}" y="${y1 + i * T.lh}">${esc(l)}</tspan>`).join('')}</text>
  <text x="${M}" y="${y1 + T.lh + 64}" font-family="${T.subFont}" font-size="28" fill="${C.grey}">${esc(T.sub)}</text>
  <rect x="${M}" y="${H - M - 56}" width="232" height="56" rx="4" fill="${C.ink}"/>
  <text x="${M + 20}" y="${H - M - 19}" font-family="${MONO}" font-size="24" fill="${C.paper}"><tspan fill="#767676">$</tspan> npx yokoten</text>
  </g>
</svg>`;
}

export async function renderPreview({ lang = 'en', width = 1280, height = 640, out }) {
  if (lang !== 'en' && lang !== 'zh') throw new Error('unknown language: ' + lang);
  if (!out) throw new Error('renderPreview needs an out path');
  await sharp(Buffer.from(preview({ lang, width, height })), { density: 144 }).resize(width, height).png({ compressionLevel: 9 }).toFile(out);
  return Math.round(statSync(out).size / 1024);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [lang, out, w, h] = process.argv.slice(2);
  if (!lang || !out) throw new Error('usage: node tools/images/social-preview.mjs <en|zh> <out.png> [width height]');
  const kb = await renderPreview({ lang, out, width: Number(w) || 1280, height: Number(h) || 640 });
  console.log('wrote', out, kb + ' KB');
}
