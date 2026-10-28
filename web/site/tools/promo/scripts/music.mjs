// Original ambient score for the yokoten promo, synthesised from scratch.
// usage (from tools/promo/): node scripts/music.mjs [out.wav]   (default: public/music.wav)
// 44.1 kHz stereo 16-bit, 32 s. Key D major. Tempo chosen so the resolving
// D chord lands on a downbeat exactly at frame 690 (23 s), when the kanban band opens.
// The score was written for a 34.2 s resolve; K stretches its section times to the new one.
import { writeFileSync } from 'node:fs';

const SR = 44100;
const DUR = 32;
const N = SR * DUR;
const RESOLVE = 690 / 30; // 23 s
const K = RESOLVE / 34.2;
const BAR = RESOLVE / 11; // 11 bars before the resolve -> ~77 BPM
const BEAT = BAR / 4;

const L = new Float32Array(N), R = new Float32Array(N); // dry mix
const sendL = new Float32Array(N), sendR = new Float32Array(N); // reverb send
const dlyL = new Float32Array(N), dlyR = new Float32Array(N); // delay send

const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
const NOTE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const n = (s) => { const m = s.match(/^([A-G]#?)(-?\d)$/); return NOTE[m[1]] + 12 * (+m[2] + 1); };
// seeded RNG so every run is identical
let seed = 0x9e3779b9;
Math.random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// ---- harmony: [startBar, durationBars, pad voicing, bass] ----
const CH = [
  [0, 1, ['B2', 'F#3', 'C#4', 'D4'], 'B1'], // Bm(add9) - uneasy
  [1, 1, ['G2', 'D3', 'F#3', 'B3'], 'G1'], // Gmaj7
  [2, 0.5, ['E3', 'G3', 'B3', 'F#4'], 'E2'], // Em9
  [2.5, 0.5, ['F#2', 'C#3', 'E3', 'B3'], 'F#1'], // F#7sus4
  [3, 1, ['D3', 'A3', 'E4', 'F#4'], 'D2'], // D(add9) - hopeful
  [4, 1, ['C#3', 'A3', 'E4', 'A4'], 'C#2'], // A/C#
  [5, 0.5, ['B2', 'F#3', 'A3', 'D4'], 'B1'], // Bm7
  [5.5, 0.5, ['G2', 'D3', 'B3', 'D4'], 'G1'], // G
  [6, 1, ['G3', 'D4', 'A4', 'B4'], 'G1'], // G(add9) - widening
  [7, 1, ['F#3', 'A3', 'D4', 'A4'], 'F#2'], // D/F#
  [8, 0.5, ['E3', 'B3', 'D4', 'G4'], 'E2'], // Em7
  [8.5, 0.5, ['E3', 'A3', 'D4', 'G4'], 'A1'], // A7sus4
  [9, 0.5, ['B3', 'D4', 'F#4', 'B4'], 'B1'], // Bm - climb
  [9.5, 0.5, ['G3', 'D4', 'G4', 'B4'], 'G1'], // G
  [10, 0.5, ['E3', 'B3', 'D4', 'G4'], 'E2'], // Em7
  [10.5, 0.25, ['E3', 'A3', 'D4', 'E4'], 'A1'], // Asus4
  [10.75, 0.25, ['E3', 'A3', 'C#4', 'E4'], 'A1'], // A
  [11, 3.4, ['D3', 'A3', 'E4', 'F#4', 'A4'], 'D2'], // D(add9) - summit
];

// ---- pad: detuned soft additive voices, slow crossfades, brightness follows the story ----
function brightness(t) {
  // 0..1: dark & close at start, opens for 横展, brightest at the summit
  if (t < 9.3 * K) return 0.15;
  if (t < 18.6 * K) return 0.15 + 0.2 * smooth((t - 9.3 * K) / (3 * K));
  if (t < 28 * K) return 0.35 + 0.15 * smooth((t - 18.6 * K) / (4 * K));
  if (t < RESOLVE) return 0.5 + 0.3 * smooth((t - 28 * K) / (RESOLVE - 28 * K));
  return 0.8 - 0.4 * smooth((t - RESOLVE) / (7 * K));
}
function padLevel(t) {
  // continuous (no steps -> no clicks)
  return 0.55 + 0.07 * smooth((t - 8.3 * K) / 2) + 0.06 * smooth((t - 17.6 * K) / 2) + 0.22 * smooth((t - 28 * K) / (RESOLVE - 28 * K));
}
const HARM = 7;
for (const [sb, db, voicing, bass] of CH) {
  const t0 = sb * BAR, t1 = (sb + db) * BAR;
  const att = sb === 11 ? 0.5 : 1.0, rel = 1.6;
  const s0 = Math.max(0, Math.floor((t0 - 0.05) * SR)), s1 = Math.min(N, Math.ceil((t1 + rel) * SR));
  voicing.forEach((name, vi) => {
    const f = midi(n(name));
    const pan = voicing.length === 1 ? 0 : -0.6 + (1.2 * vi) / (voicing.length - 1);
    for (const det of [-0.07, 0, 0.07]) {
      const fd = f * Math.pow(2, det / 12);
      const ph0 = Math.random() * 6.283;
      const p = Math.max(-1, Math.min(1, pan + det * 4));
      const gl = Math.cos((p + 1) * Math.PI / 4), gr = Math.sin((p + 1) * Math.PI / 4);
      for (let i = s0; i < s1; i++) {
        const t = i / SR;
        let env = smooth((t - t0) / att) * (1 - smooth((t - t1) / rel));
        if (env <= 0) continue;
        const b = brightness(t);
        const w = 2 * Math.PI * fd * t + ph0;
        let s = 0;
        for (let h = 1; h <= HARM; h++) {
          const roll = Math.pow(h, -(2.6 - 1.6 * b)); // darker = steeper rolloff
          s += roll * Math.sin(h * w + h * 0.7);
        }
        // slow breathing tremolo per voice
        s *= env * padLevel(t) * 0.035 * (1 + 0.12 * Math.sin(2 * Math.PI * 0.17 * t + vi));
        L[i] += s * gl; R[i] += s * gr;
        sendL[i] += s * gl * 0.9; sendR[i] += s * gr * 0.9;
      }
    }
  });
  // bass: soft sine + a little 2nd harmonic; silent in the opening bars except a faint drone
  const bf = midi(n(bass));
  for (let i = s0; i < s1; i++) {
    const t = i / SR;
    const env = smooth((t - t0) / Math.max(att, 0.6)) * (1 - smooth((t - t1) / rel));
    if (env <= 0) continue;
    const lvl = 0.35 + 0.2 * smooth((t - 8.3 * K) / 2) + 0.1 * smooth((t - RESOLVE + 1) / 2);
    const w = 2 * Math.PI * bf * t;
    const s = env * lvl * 0.09 * (Math.sin(w) + 0.18 * Math.sin(2 * w));
    L[i] += s; R[i] += s;
    sendL[i] += s * 0.25; sendR[i] += s * 0.25;
  }
}

// ---- pluck: soft FM electric-piano tone ----
function pluck(t, name, vel, pan, decay = 1.6) {
  const f = midi(n(name));
  const s0 = Math.floor(t * SR), len = Math.floor((decay * 3) * SR);
  const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
  const ph = Math.random() * 6.283;
  for (let k = 0; k < len && s0 + k < N; k++) {
    const x = k / SR;
    const env = (1 - Math.exp(-x / 0.004)) * Math.exp(-x / decay) * (1 - smooth((x - decay * 2.6) / (decay * 0.4)));
    const idx = 1.4 * vel * Math.exp(-x / 0.18);
    const w = 2 * Math.PI * f * x + ph;
    let s = Math.sin(w + idx * Math.sin(w)) + 0.22 * Math.sin(2 * w) * Math.exp(-x / 0.4);
    s *= env * vel * 0.085;
    const i = s0 + k;
    L[i] += s * gl; R[i] += s * gr;
    sendL[i] += s * gl * 0.7; sendR[i] += s * gr * 0.7;
    dlyL[i] += s * gl * 0.5; dlyR[i] += s * gr * 0.5;
  }
}
const chordAt = (bar) => { let c = CH[0]; for (const ch of CH) if (bar >= ch[0] - 1e-9) c = ch; return c[2]; };
const up = (name, oct) => name.replace(/-?\d$/, (d) => String(+d + oct));

// Section 1 (bars 0-3): sparse, hesitant notes, a little off the grid
const s1 = [[0.5, 'F#4'], [1.5, 'D5'], [3, 'C#5'], [5, 'B4'], [6.5, 'F#4'], [7.5, 'A4'], [9, 'B4'], [10.5, 'C#5'], [11, 'B4']];
for (const [beat, name] of s1) pluck(beat * BEAT + 0.012 * Math.sin(beat * 7), name, 0.5, Math.sin(beat) * 0.4, 2.0);

// Section 2 (bars 3-6): steady eighth-note arpeggio, hopeful
// Section 3 (bars 6-9): wider range, alternating pans, more delay
// Section 4 (bars 9-11): rising contour, denser, growing velocity
for (let e = 3 * 8; e < 11 * 8; e++) {
  const bar = e / 8;
  const v = chordAt(bar);
  const pos = e % 8;
  let name, vel, pan;
  if (bar < 6) {
    const pat = [0, 2, 3, 1, 2, 3, 1, 2];
    name = up(v[pat[pos]], 1); vel = pos === 0 ? 0.55 : 0.4; pan = 0.15 * Math.sin(e);
    if (pos === 7 && Math.floor(bar) === 5) continue; // breathe
  } else if (bar < 9) {
    const pat = [0, 1, 2, 3, 2, 3, 1, 3];
    const oct = pos >= 4 ? 2 : 1;
    name = up(v[pat[pos]], oct); vel = pos % 4 === 0 ? 0.5 : 0.38; pan = pos % 2 ? 0.55 : -0.55;
  } else {
    const prog = (bar - 9) / 2; // 0..1 across the climb
    const pat = [0, 1, 2, 3, 1, 2, 3, 3];
    const oct = 1 + (pos >= 6 || (prog > 0.5 && pos >= 3) ? 1 : 0);
    name = up(v[pat[pos]], oct); vel = 0.38 + 0.25 * prog + (pos === 0 ? 0.08 : 0); pan = 0.35 * Math.sin(e * 1.3);
    // add sixteenth fills in the last bar of the climb
    if (bar >= 10) pluck((e + 0.5) * BEAT / 2, up(v[(pat[pos] + 1) % 4], oct), vel * 0.6, -pan, 0.9);
  }
  pluck(e * BEAT / 2, name, vel, pan, bar < 6 ? 1.4 : 1.2);
}
// Summit: a rolled D(add9) chord, then a few last notes ringing into the logo
const roll = ['D4', 'A4', 'E5', 'F#5', 'A5', 'D6'];
roll.forEach((name, i) => pluck(RESOLVE + i * 0.07, name, 0.5 - i * 0.03, -0.5 + i * 0.2, 2.6));
[[2, 'F#5'], [3.5, 'E5'], [5, 'A4'], [6, 'D5']].forEach(([b, name]) => pluck(RESOLVE + b * BEAT, name, 0.35, 0.2, 2.4));

// ---- very soft pulse under the climb only (low sine thump on beats) ----
for (let b = 36; b < 44; b++) {
  const t0 = b * BEAT, s0 = Math.floor(t0 * SR);
  const lvl = 0.05 + 0.06 * ((b - 36) / 8);
  for (let k = 0; k < SR * 0.35; k++) {
    const x = k / SR;
    const f = 55 + 25 * Math.exp(-x / 0.03);
    const s = lvl * Math.sin(2 * Math.PI * f * x) * (1 - Math.exp(-x / 0.003)) * Math.exp(-x / 0.12);
    L[s0 + k] += s; R[s0 + k] += s;
  }
}

// ---- soft airy swell (filtered noise) rising into the summit ----
{
  let lpL = 0, lpR = 0, hpL = 0, hpR = 0, pl = 0, pr = 0;
  const a0 = 9.5 * BAR;
  for (let i = Math.floor(a0 * SR); i < N; i++) {
    const t = i / SR;
    let env;
    if (t < RESOLVE) env = Math.pow(smooth((t - a0) / (RESOLVE - a0)), 2) * (1 - 0.4 * smooth((t - RESOLVE + 0.4) / 0.4));
    else env = Math.exp(-(t - RESOLVE) / 0.9);
    if (env < 1e-5 && t > RESOLVE) break;
    const cut = 400 + 3500 * env;
    const a = 1 - Math.exp(-2 * Math.PI * cut / SR);
    const nl = Math.random() * 2 - 1, nr = Math.random() * 2 - 1;
    lpL += a * (nl - lpL); lpR += a * (nr - lpR);
    hpL = lpL - pl; hpR = lpR - pr; pl += 0.01 * (lpL - pl); pr += 0.01 * (lpR - pr);
    const g = 0.035 * env;
    L[i] += hpL * g; R[i] += hpR * g;
    sendL[i] += hpL * g * 1.5; sendR[i] += hpR * g * 1.5;
  }
}

// ---- ping-pong delay (dotted eighth) on the plucks ----
{
  const d = Math.round(BEAT * 0.75 * SR);
  const bl = new Float32Array(N), br = new Float32Array(N);
  let lp1 = 0, lp2 = 0;
  for (let i = 0; i < N; i++) {
    const fromR = i >= d ? br[i - d] : 0, fromL = i >= d ? bl[i - d] : 0;
    lp1 += 0.35 * (fromR - lp1); lp2 += 0.35 * (fromL - lp2); // darker repeats
    bl[i] = dlyL[i] + lp1 * 0.42;
    br[i] = dlyR[i] * 0.3 + lp2 * 0.42;
    const wet = 0.22;
    L[i] += bl[i] * wet; R[i] += br[i] * wet;
    sendL[i] += bl[i] * wet * 0.6; sendR[i] += br[i] * wet * 0.6;
  }
}

// ---- Freeverb-style reverb ----
function reverb(input, spread) {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((x) => Math.round((x + spread) * SR / 44100 * 1.25));
  const aps = [556, 441, 341, 225].map((x) => Math.round((x + spread) * SR / 44100));
  const out = new Float32Array(N);
  const fb = 0.86, damp = 0.35;
  for (const len of combs) {
    const buf = new Float32Array(len); let idx = 0, store = 0;
    for (let i = 0; i < N; i++) {
      const y = buf[idx];
      store = y * (1 - damp) + store * damp;
      buf[idx] = input[i] * 0.015 + store * fb;
      idx = (idx + 1) % len;
      out[i] += y;
    }
  }
  for (const len of aps) {
    const buf = new Float32Array(len); let idx = 0;
    for (let i = 0; i < N; i++) {
      const b = buf[idx];
      const y = -out[i] + b;
      buf[idx] = out[i] + b * 0.5;
      idx = (idx + 1) % len;
      out[i] = y;
    }
  }
  return out;
}
// pre-delay
const PRE = Math.round(0.025 * SR);
const pin = (x) => { const o = new Float32Array(N); o.set(x.subarray(0, N - PRE), PRE); return o; };
const rvL = reverb(pin(sendL), 0), rvR = reverb(pin(sendR), 23);
const WET = 0.55;
for (let i = 0; i < N; i++) {
  const m = (rvL[i] + rvR[i]) * 0.5, sd = (rvL[i] - rvR[i]) * 0.5;
  L[i] += (m + sd * 1.3) * WET; R[i] += (m - sd * 1.3) * WET;
}

// ---- DC block + gentle high-shelf trim + master fades ----
{
  let xl = 0, yl = 0, xr = 0, yr = 0;
  for (let i = 0; i < N; i++) {
    const nl = L[i] - xl + 0.9995 * yl; xl = L[i]; yl = nl; L[i] = nl;
    const nr = R[i] - xr + 0.9995 * yr; xr = R[i]; yr = nr; R[i] = nr;
  }
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const fin = smooth(t / 0.6);
    const fout = 1 - smooth((t - 28.6) / (DUR - 0.05 - 28.6)); // soft tail over the logo, silent at 31.95 s
    const g = fin * Math.pow(Math.max(0, fout), 1.3);
    L[i] *= g; R[i] *= g;
  }
}

// ---- loudness: ITU-R BS.1770 integrated LUFS (K-weighting + gating) ----
function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
function kweight(x) {
  // 44.1 kHz coefficients derived from the 48 kHz spec via bilinear design (pyloudnorm formulas)
  const G = 3.999843853973347, Q1 = 0.7071752369554196, fc1 = 1681.974450955533;
  let K = Math.tan(Math.PI * fc1 / SR); const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q1 + K * K;
  const s = biquad(x, (Vh + Vb * K / Q1 + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q1 + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q1 + K * K) / a0);
  const fc2 = 38.13547087602444, Q2 = 0.5003270373238773; K = Math.tan(Math.PI * fc2 / SR);
  a0 = 1 + K / Q2 + K * K;
  return biquad(s, 1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q2 + K * K) / a0);
}
function lufs(l, r) {
  const kl = kweight(l), kr = kweight(r);
  const blk = Math.round(0.4 * SR), hop = Math.round(0.1 * SR);
  const zs = [];
  for (let s = 0; s + blk <= N; s += hop) { let e = 0; for (let i = s; i < s + blk; i++) e += kl[i] * kl[i] + kr[i] * kr[i]; zs.push(e / blk); }
  const L_ = (z) => -0.691 + 10 * Math.log10(z);
  let g = zs.filter((z) => L_(z) > -70);
  const rel = L_(g.reduce((a, b) => a + b, 0) / g.length) - 10;
  g = g.filter((z) => L_(z) > rel);
  return L_(g.reduce((a, b) => a + b, 0) / g.length);
}
const peakOf = () => { let p = 0; for (let i = 0; i < N; i++) p = Math.max(p, Math.abs(L[i]), Math.abs(R[i])); return p; };

const TARGET = -16, CEIL = Math.pow(10, -1.3 / 20);
const before = lufs(L, R);
let gain = Math.pow(10, (TARGET - before) / 20);
const pk = peakOf() * gain;
if (pk > CEIL) gain *= CEIL / pk; // keep true peak under -1 dBTP; settle for slightly quieter instead
for (let i = 0; i < N; i++) { L[i] *= gain; R[i] *= gain; }
const finalL = lufs(L, R), finalPk = peakOf();
console.log(`bar ${BAR.toFixed(4)} s (${(240 / BAR).toFixed(2)} BPM), resolve at ${RESOLVE.toFixed(3)} s`);
console.log(`integrated ${finalL.toFixed(2)} LUFS, sample peak ${(20 * Math.log10(finalPk)).toFixed(2)} dBFS`);

// ---- write 16-bit WAV with TPDF dither ----
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
let clips = 0;
for (let i = 0; i < N; i++) {
  for (const [c, ch] of [[0, L], [1, R]]) {
    let v = Math.round(ch[i] * 32767 + (Math.random() - Math.random()));
    if (v > 32767 || v < -32768) { clips++; v = Math.max(-32768, Math.min(32767, v)); }
    buf.writeInt16LE(v, 44 + i * 4 + c * 2);
  }
}
writeFileSync(process.argv[2] || 'public/music.wav', buf);
console.log(`clipped samples: ${clips}`);
