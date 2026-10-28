// The logo mark, from one source: the header and footer (Mark.astro), the browser icon
// (site/public/images/favicon.svg, written by `node tools/steps/mark.mjs` in the build) and the share images
// (social-preview.mjs) all draw it from here.
//
// The guard (owner, 2026-10-28): a y cut out of a stop-sign octagon, in one colour that follows
// the theme (`currentColor`), black on light and white on dark. The octagon is the stop yokoten
// shows when it refuses a command; the y is the way through. One drawing at every size, 16px up.
//
// How it was drawn: the y is one closed shape on a 300-high grid (stroke 74, the stem leaning
// 0.56, the arm 0.62, the crotch at 110 and the arm joining the stem at 184), scaled to 0.58 of
// the octagon's height, and placed by half its mass and half its box, a little right and low,
// so it looks centred. The octagon's corners are rounded by a 28 stroke, so it holds at 16px.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MARK = {
  octagon: '164.04,34 347.96,34 478,164.04 478,347.96 347.96,478 164.04,478 34,347.96 34,164.04',
  round: 28,
  y: 'M116.2 132.3 L195.7 132.3 L258.2 233.1 L314.4 132.3 L391.8 132.3 L238.5 406.0 L161.1 406.0 L220.3 300.4 Z',
};

let count = 0;
/** A fresh id for each mark on a page, the same on every build. */
export const nextId = () => String(++count);

/**
 * The mark's inner SVG, in a 512 by 512 box. `colour` is the octagon's one colour (currentColor
 * follows the theme); the y is cut out of it, so whatever is behind shows through. `id` keeps
 * the mask unique when a page shows the mark twice.
 */
export function guardInner({ colour = 'currentColor', id = 'g', m = MARK } = {}) {
  return `<defs><mask id="yk-${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="white"/><path d="${m.y}" fill="black"/></mask></defs>`
    + `<polygon points="${m.octagon}" fill="${colour}" stroke="${colour}" stroke-width="${m.round}" stroke-linejoin="round" mask="url(#yk-${id})"/>`;
}

// The browser icon: black on a light tab bar, white on a dark one.
export const favicon = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><style>svg{color:#171717}@media (prefers-color-scheme:dark){svg{color:#ededed}}</style>${guardInner({ id: 'f' })}</svg>\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(fileURLToPath(new URL('../../site/public/images/favicon.svg', import.meta.url)), favicon());
}
