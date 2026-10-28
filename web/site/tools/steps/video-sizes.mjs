// Writes the byte size of each file under site/public/video (light/, dark/, captions/) to
// worker/video-sizes.json, keyed by its URL path (/video/light/...).
// Inside the Worker a static asset's response has no Content-Length, and a byte range
// needs the size; reading the body to count it would cost too much CPU.
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dir = `${root}site/public/video`;
const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(`${dir}/${f}`).isFile());
const sizes = Object.fromEntries(files.map((f) => f.replace(/\\/g, '/')).sort().map((f) => [`/video/${f}`, statSync(`${dir}/${f}`).size]));
writeFileSync(`${root}worker/video-sizes.json`, JSON.stringify(sizes, null, 2) + '\n');
