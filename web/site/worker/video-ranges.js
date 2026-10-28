// File names carry a content hash, so a cached copy never mixes two versions.
// worker/index.js sends /video/* here (see run_worker_first in wrangler.jsonc). Static assets answer a
// Range request with the whole file (200), but Safari on iPhone and iPad will only play
// video from a server that returns byte ranges (206). Everything else is served as is.
// The body is streamed, never read into memory: the Free plan allows 10 ms of CPU.
import SIZES from './video-sizes.json';

const HEADERS = {
  'Cache-Control': 'public, max-age=31536000, immutable',
  'X-Content-Type-Options': 'nosniff',
  'Accept-Ranges': 'bytes',
};

// Passes on bytes start..end (inclusive) of a stream and drops the rest.
function slice(body, start, end) {
  let pos = 0;
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, ctl) {
        const from = Math.max(start - pos, 0);
        const to = Math.min(end + 1 - pos, chunk.byteLength);
        pos += chunk.byteLength;
        if (from < to) ctl.enqueue(chunk.subarray(from, to));
        if (pos > end) ctl.terminate();
      },
    }),
  );
}

export async function serveVideo(request, env) {
  const res = await env.ASSETS.fetch(request);
  const range = request.headers.get('Range');
  if (res.status !== 200) return res;

  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(HEADERS)) headers.set(k, v);
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  const size = SIZES[new URL(request.url).pathname];
  if (!m || (m[1] === '' && m[2] === '') || !size) return new Response(res.body, { status: 200, headers });

  let start, end;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2])); // last N bytes
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) {
    res.body?.cancel();
    headers.set('Content-Range', `bytes */${size}`);
    headers.delete('Content-Length');
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  if (request.method === 'HEAD') return new Response(null, { status: 206, headers });
  // The whole file needs no slicing, so the runtime pipes it without running JS.
  const body = start === 0 && end === size - 1 ? res.body : slice(res.body, start, end);
  return new Response(body, { status: 206, headers });
}
