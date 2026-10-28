// Makes the 1200x630 share previews (og:image) with tools/images/social-preview.mjs, the site's own copy
// of the social preview source. Run it when the hero sentence or the logo changes:
//   node tools/images/og-images.mjs                       writes site/public/images/og-en.png and og-zh.png
//   node tools/images/og-images.mjs github <out.png>      the 1280x640 GitHub social preview, English
//   node tools/images/og-images.mjs github <out.png> zh   the same, Chinese
import { fileURLToPath } from 'node:url';
import { renderPreview } from './social-preview.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const [mode, out, lang = 'en'] = process.argv.slice(2);

if (mode === 'github') {
  if (!out) throw new Error('usage: node tools/images/og-images.mjs github <out.png> [en|zh]');
  const kb = await renderPreview({ lang, width: 1280, height: 640, out });
  console.log(`og-images: ${out} 1280x640 ${kb} KB`);
} else {
  for (const lang of ['en', 'zh']) {
    const file = `${root}site/public/images/og-${lang}.png`;
    const kb = await renderPreview({ lang, width: 1200, height: 630, out: file });
    if (kb > 300) throw new Error(`og-${lang}.png is ${kb} KB; the limit is 300 KB`);
    console.log(`og-images: site/public/images/og-${lang}.png 1200x630 ${kb} KB`);
  }
}
