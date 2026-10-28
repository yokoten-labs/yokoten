// Puts a rendered promo on the site: the video, its poster and the subtitle tracks from
// src/strings.ts, each under a hashed name (/video/* is cached for a year), and the list of
// those names in site/src/content/promo.json, which site/src/lib/content/facts.ts reads.
// usage (from tools/promo/): node scripts/publish.mjs out/promo.mp4 out/promo.webm out/poster.jpg \
//   [out/promo-dark.mp4 out/promo-dark.webm out/poster-dark.jpg]   the same on the dark page
//   then rebuild the site. Node 22.18+ loads the .ts file directly.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTION_TIMINGS, DURATION, END_CARD, FPS, STRINGS } from '../src/strings.ts';

const here = dirname(fileURLToPath(import.meta.url));
// here is tools/promo/scripts; the site package is three folders up.
const root = join(here, '../../..');
const site = join(root, 'site');
// site/public/video, in light/, dark/ and captions/: tools/steps/video-sizes.mjs reads it
const videoDir = join(site, 'public/video');

const [mp4, webm, poster, darkMp4, darkWebm, darkPoster] = process.argv.slice(2);
if (!mp4 || !webm || !poster) throw new Error('usage: node publish.mjs <video.mp4> <video.webm> <poster.jpg> [<dark.mp4> <dark.webm> <dark-poster.jpg>]');
if (darkMp4 && !(darkWebm && darkPoster)) throw new Error('the dark render needs all three files: mp4, webm and poster');

const stamp = (frame) => {
  const ms = Math.round((frame / FPS) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
};

const cuesFor = (words) => {
  if (words.captions.length !== CAPTION_TIMINGS.length) throw new Error(`${words.tag}: ${words.captions.length} captions, want ${CAPTION_TIMINGS.length}`);
  return [...CAPTION_TIMINGS.map((t, i) => ({ ...t, lines: words.captions[i] })), { ...END_CARD, lines: [words.slogan] }];
};

const check = (cues) => {
  let last = -1;
  for (const c of cues) {
    if (!(c.from > last && c.to > c.from && c.to <= DURATION)) throw new Error(`cue out of order or past the end: ${c.lines.join(' / ')}`);
    last = c.to;
  }
};

// The picture draws no sentences, so the cues sit where players put them by default: at the bottom.
const vtt = (cues) => 'WEBVTT\n\n' + cues.map((c, i) => `${i + 1}\n${stamp(c.from)} --> ${stamp(c.to)}\n${c.lines.join('\n')}\n`).join('\n');

// Each file goes in its folder (light/, dark/ or captions/), and its URL names the folder too.
const hashed = (folder, stem, ext, data) => {
  const name = `${stem}.${createHash('sha256').update(data).digest('hex').slice(0, 8)}.${ext}`;
  mkdirSync(join(videoDir, folder), { recursive: true });
  writeFileSync(join(videoDir, folder, name), data);
  return `/video/${folder}/${name}`;
};

// the old promo files go; the new ones are written below
for (const folder of ['light', 'dark', 'captions']) {
  const dir = join(videoDir, folder);
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (/^yokoten-promo/.test(f)) rmSync(join(dir, f));
}

const out = {
  mp4: hashed('light', 'yokoten-promo', 'mp4', readFileSync(mp4)),
  webm: hashed('light', 'yokoten-promo', 'webm', readFileSync(webm)),
  poster: hashed('light', 'yokoten-promo-poster', 'jpg', readFileSync(poster)),
  ...(darkMp4 ? { dark: {
    mp4: hashed('dark', 'yokoten-promo-dark', 'mp4', readFileSync(darkMp4)),
    webm: hashed('dark', 'yokoten-promo-dark', 'webm', readFileSync(darkWebm)),
    poster: hashed('dark', 'yokoten-promo-dark-poster', 'jpg', readFileSync(darkPoster)),
  } } : {}),
  seconds: DURATION / FPS,
  captions: {},
};
for (const [lang, words] of Object.entries(STRINGS)) {
  const cues = cuesFor(words);
  check(cues);
  out.captions[lang] = hashed('captions', `yokoten-promo.${lang}`, 'vtt', vtt(cues));
}
writeFileSync(join(site, 'src/content/promo.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`published: ${out.mp4}, ${out.webm}, ${out.poster}, ${Object.keys(out.captions).length} caption tracks`);
