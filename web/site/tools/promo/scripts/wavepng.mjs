// usage: node scripts/wavepng.mjs in.wav out.png  — waveform (top) + log-frequency spectrogram (bottom), scene markers
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
const b = readFileSync(process.argv[2]);
const SR = b.readUInt32LE(24), N = (b.length - 44) / 4;
const L = new Float32Array(N), R = new Float32Array(N);
for (let i = 0; i < N; i++) { L[i] = b.readInt16LE(44 + i * 4) / 32768; R[i] = b.readInt16LE(46 + i * 4) / 32768; }
const W = 1600, WH = 220, SH = 420, H = WH + SH + 10;
const img = Buffer.alloc(W * H * 3, 0x0d);
const px = (x, y, r, g, bl) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 3; img[o] = r; img[o + 1] = g; img[o + 2] = bl; };
// waveform: peak (light) + RMS (accent); -1 dBFS guide lines
for (let x = 0; x < W; x++) {
  const s0 = Math.floor(x * N / W), s1 = Math.floor((x + 1) * N / W);
  let mx = 0, mn = 0, e = 0;
  for (let i = s0; i < s1; i++) { const v = (L[i] + R[i]) / 2; mx = Math.max(mx, L[i], R[i]); mn = Math.min(mn, L[i], R[i]); e += v * v; }
  const rms = Math.sqrt(e / (s1 - s0)), mid = WH / 2;
  for (let y = Math.round(mid - mx * mid); y <= Math.round(mid - mn * mid); y++) px(x, y, 110, 118, 129);
  for (let y = Math.round(mid - rms * mid); y <= Math.round(mid + rms * mid); y++) px(x, y, 236, 143, 108);
  const c = Math.round(mid - 0.891 * mid), c2 = Math.round(mid + 0.891 * mid); px(x, c, 200, 60, 60); px(x, c2, 200, 60, 60);
}
// spectrogram: 4096-pt FFT, 30 Hz..16 kHz log axis, -100..-20 dB
const FFT = 4096, half = FFT / 2;
const win = Float32Array.from({ length: FFT }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FFT));
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len; for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) { const wr = Math.cos(a * k), wi = Math.sin(a * k); const ur = re[i + k], ui = im[i + k]; const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi, vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr; re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi; } }
}
const fmin = 30, fmax = 16000;
const col = (v) => { // dark -> blue -> accent -> white
  const s = [[13, 17, 23], [40, 60, 120], [236, 143, 108], [255, 245, 230]]; const p = v * 3, i = Math.min(2, Math.floor(p)), t = p - i;
  return s[i].map((c, k) => Math.round(c + (s[i + 1][k] - c) * t));
};
for (let x = 0; x < W; x++) {
  const c = Math.floor(x * N / W) - half, re = new Float64Array(FFT), im = new Float64Array(FFT);
  for (let i = 0; i < FFT; i++) { const j = c + i; re[i] = j >= 0 && j < N ? (L[j] + R[j]) / 2 * win[i] : 0; }
  fft(re, im);
  for (let y = 0; y < SH; y++) {
    const f = fmin * Math.pow(fmax / fmin, 1 - y / (SH - 1)), k = Math.min(half - 1, Math.round(f * FFT / SR));
    const mag = Math.hypot(re[k], im[k]) / (FFT / 4), db = 20 * Math.log10(mag + 1e-12);
    const v = Math.max(0, Math.min(1, (db + 100) / 80));
    px(x, WH + 10 + y, ...col(v));
  }
}
// scene markers (s): guard/doctor 10.2, 横展 18.3, climb 29, flag 34.2, logo 37.1
for (const t of [10.2, 18.3, 29, 34.2, 37.07]) { const x = Math.round(t / (N / SR) * W); for (let y = 0; y < H; y += 3) px(x, y, 240, 246, 252); }
// PNG
const raw = Buffer.alloc((W * 3 + 1) * H); for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; img.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); }
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const v of buf) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(process.argv[3], Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
