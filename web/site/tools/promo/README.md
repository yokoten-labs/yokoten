# yokoten promo video

The 32-second promo shown on yokoten.app, made with [Remotion](https://www.remotion.dev/) (React + TypeScript).
The background music is original: `scripts/music.mjs` synthesises it from scratch with a seeded random generator,
so every run writes the same file. It is not committed; generate it before rendering.

This folder is its own package. The site's build, typecheck and Tailwind scan ignore it.

```sh
cd web/site/tools/promo
npm install
node scripts/music.mjs                   # writes public/music.wav, the 32 s score (44.1 kHz stereo WAV)
npx remotion studio src/index.ts          # optional: preview in the browser
nice -n 10 npx remotion render src/index.ts Promo out/promo.mp4 --codec=h264 --concurrency=2
nice -n 10 npx remotion render src/index.ts Promo out/promo.webm --codec=vp9 --concurrency=2
npx remotion still src/index.ts Promo out/poster.jpg --frame=200 --image-format=jpeg --jpeg-quality=85
node scripts/publish.mjs out/promo.mp4 out/promo.webm out/poster.jpg   # then rebuild the site
```

Helpers: `node scripts/wavepng.mjs public/music.wav out/music.png` draws the waveform and spectrogram;
`scripts/still.sh 100 530` renders single frames to `stills/`; `scripts/sheet.mjs` lays stills out on a contact sheet.

Fonts in `public/fonts/` are the site's: Inter, JetBrains Mono and two Noto Sans JP subsets for 横展, copied from
the site's @fontsource-variable packages (SIL Open Font License).

The terminal shows the real screens from `../../site/src/content/generated/facts/screens.json`, which `tools/steps/from-package.mjs`
captures at the release tag. Re-run it at a new tag, then render again; nothing on the terminal is typed by hand.

Subtitles and publishing: `src/strings.ts` holds the words the video says in English, 简体中文, 繁體中文 and 日本語,
with the caption timings. `scripts/publish.mjs` writes the `.vtt` tracks from it, copies the video, the WebM and the poster to
`../../site/public/video/` (`light/`, `dark/`, `captions/`) under hashed names, removes the old ones, and lists the new names in
`../../site/src/content/promo.json`, which the site's player reads.
