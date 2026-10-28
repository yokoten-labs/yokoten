// Contact sheet of stills, for review. Needs playwright (npm i --no-save playwright).
// usage: node scripts/sheet.mjs out.png cols width "label=path" ...
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const [out, cols, width, ...items] = process.argv.slice(2);
const cells = items.map((it) => { const i = it.indexOf('='); return { label: it.slice(0, i), src: 'data:image/png;base64,' + readFileSync(it.slice(i + 1)).toString('base64') }; });
const W = Number(width);
const html = `<html><body style="margin:0;background:#0d1117;padding:24px;width:${W - 48}px;font-family:sans-serif">
<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:16px">
${cells.map((c) => `<figure style="margin:0"><img src="${c.src}" style="width:100%;display:block;border:1px solid #30363d;border-radius:6px"><figcaption style="color:#8b949e;font-size:16px;margin-top:6px">${c.label}</figcaption></figure>`).join('')}
</div></body></html>`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: W, height: 400 } });
await p.setContent(html);
await p.screenshot({ path: out, fullPage: true });
await b.close();
