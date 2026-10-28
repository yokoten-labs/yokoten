import React, { useEffect, useState } from 'react';
import { AbsoluteFill, Html5Audio, Easing, continueRender, delayRender, getInputProps, interpolate, staticFile, useCurrentFrame } from 'remotion';
// The real screens the site shows, captured in CI at the release tag (tools/steps/from-package.mjs).
// Nothing on the terminal is retyped: every line comes from this file.
import screens from '../../../site/src/content/generated/facts/screens.json';
// The video's length, scene starts and subtitle cue timings live in strings.ts. The picture draws no
// sentences of its own: the words come from the subtitle tracks (subtitles.mjs).
import { DURATION, FPS, SCENES } from './strings';
import { screenRuns, type Run, type Style } from '../../../site/src/lib/terminal/ansi';

export { DURATION, FPS };

// The brand: warm paper and ink, and the product's terminal colours: red for a stop, yellow for the kanban, green for running.
const PAPER = '#ffffff';
const INK = '#171717';
const ANDON = '#c50f1f';
const KANBAN = '#c19c00';
const SMALL = '#666666';
// The page around the screens follows the site's theme: one render per theme, chosen with
// --props='{"theme":"dark"}' (README). Dark is the site's pure black with its soft white text.
const DARK = (getInputProps() as { theme?: string }).theme === 'dark';
const PAGE = DARK ? '#000000' : PAPER;
const PAGE_TEXT = DARK ? '#ededed' : INK;
const PAGE_SMALL = DARK ? '#a1a1a1' : SMALL;
const PAGE_EDGE = DARK ? 'inset 0 0 0 2px #2e2e2e' : 'none';
const CORAL = '#ec8f6c'; // the dot in the logo
// The terminal, as the site's .term draws it: Windows Terminal's default scheme (Campbell).
const T_BG = '#0c0c0c';
const T_FG = '#cccccc';
const T_DIM = '#767676';
const T_COLOUR: Record<Style, string> = { bold: '#f2f2f2', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', cyan: '#3a96dd' };

// The site's faces (site/src/styles/global.css): Inter, JetBrains Mono, Noto Sans JP for 横展.
const COND = "'Inter', sans-serif";
const SANS = "'Inter', 'Noto JP', sans-serif";
const MONO = "'JetBrains Mono', monospace";

const ease = Easing.bezier(0.45, 0, 0.2, 1);
const snap = Easing.bezier(0.2, 0.9, 0.3, 1.25); // a little overshoot, for the badge
const ramp = (f: number, a: number, b: number, e = ease) => interpolate(f, [a, b], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: e });

// ---------- fonts ----------
const useFonts = () => {
  const [handle] = useState(() => delayRender('fonts'));
  useEffect(() => {
    // variable fonts: one file covers every weight
    const faces = [
      new FontFace('Inter', `url(${staticFile('fonts/inter.woff2')})`, { weight: '100 900' }),
      // 横 and 展 only, for the wordmark (the site's Noto Sans JP subsets 105 and 106).
      new FontFace('Noto JP', `url(${staticFile('fonts/noto-jp-105.woff2')})`, { weight: '100 900', unicodeRange: 'U+5C55' }),
      new FontFace('Noto JP', `url(${staticFile('fonts/noto-jp-106.woff2')})`, { weight: '100 900', unicodeRange: 'U+6A2A' }),
      new FontFace('JetBrains Mono', `url(${staticFile('fonts/jetbrains-mono.woff2')})`, { weight: '100 800' }),
    ];
    Promise.all(faces.map((f) => f.load().then(() => document.fonts.add(f))))
      .then(() => document.fonts.ready)
      .then(() => continueRender(handle));
  }, [handle]);
};

// ---------- a captured screen, in the colours yokoten's own styleText gives it (site/src/lib/terminal/ansi.ts) ----------
type ScreenKey = keyof typeof screens;
type Seg = { t: string; c?: string; b?: boolean };

const colour = (line: Run[]): Seg[] =>
  line.map((r) => ({ t: r.text, c: r.styles.filter((x) => x !== 'bold').map((x) => T_COLOUR[x]).pop() ?? (r.styles.includes('bold') ? T_COLOUR.bold : undefined), b: r.styles.includes('bold') }));
const body = (key: ScreenKey) => [[], ...screenRuns(screens[key].ansi)].map(colour);

// ---------- the terminal window ----------
// A refusal is short and set large; the first run is 24 rows and set smaller, so all of it fits
// and nothing scrolls away.
const BIG = { size: 24, lh: 34 };
const SMALL_TYPE = { size: 20, lh: 28 };
const VIEW = 24 * SMALL_TYPE.lh;
const WIN = { x: 260, y: 84, w: 1400, h: 56 + 36 + VIEW + 40 };

type Shot = { key: ScreenKey; at: number; typeAt: number; perChar: number; showAt: number; perLine: number };
const SHOTS: Shot[] = [
  { key: 'guard, force push', at: SCENES.type, typeAt: 24, perChar: 2, showAt: SCENES.stop + 8, perLine: 5 },
  { key: 'guard, wipe home', at: SCENES.more, typeAt: SCENES.more + 6, perChar: 1.5, showAt: SCENES.more + 24, perLine: 2 },
  { key: 'guard, tag push', at: SCENES.tag, typeAt: SCENES.tag + 6, perChar: 1, showAt: SCENES.tag + 28, perLine: 2 },
  { key: 'first run', at: SCENES.first, typeAt: SCENES.first + 10, perChar: 2, showAt: SCENES.first + 42, perLine: 6 },
];

const Line: React.FC<{ segs: Seg[]; lh: number }> = ({ segs, lh }) => (
  <div style={{ height: lh, whiteSpace: 'pre' }}>
    {segs.map((s, i) => (
      <span key={i} style={{ color: s.c ?? T_FG, fontWeight: s.b ? 700 : 400 }}>{s.t}</span>
    ))}
  </div>
);

const Terminal: React.FC = () => {
  const f = useCurrentFrame();
  const appear = ramp(f, 0, 16);
  const leave = ramp(f, SCENES.next, SCENES.next + 20);
  if (appear <= 0 || leave >= 1) return null;

  const shot = [...SHOTS].reverse().find((s) => f >= s.at)!;
  const typed = screens[shot.key].typed;
  const chars = Math.max(0, Math.min(typed.length, Math.floor((f - shot.typeAt) / shot.perChar)));
  const typing = chars < typed.length;
  const lines = f < shot.showAt ? [] : body(shot.key).slice(0, 1 + Math.floor((f - shot.showAt) / shot.perLine));
  const { size: SIZE, lh: LH } = shot.key === 'first run' ? SMALL_TYPE : BIG;

  const stopped = shot.key.startsWith('guard, ') && f >= shot.showAt;
  const shown = ramp(f, shot.showAt - 2, shot.showAt + 6);
  const swap = shot.at === 0 ? 1 : ramp(f, shot.at, shot.at + 6); // a quick fade as one screen gives way to the next
  const badge = stopped ? ramp(f, shot.showAt, shot.showAt + 12, snap) : 0;
  const cursorOn = Math.floor(f / 15) % 2 === 0 || typing;

  return (
    <div
      style={{
        position: 'absolute', left: WIN.x, top: WIN.y, width: WIN.w, height: WIN.h,
        opacity: appear * (1 - leave), transform: `translateY(${(1 - appear) * 24 - leave * 40}px)`,
        background: T_BG, borderRadius: 18, overflow: 'hidden',
        boxShadow: DARK ? 'inset 0 0 0 2px #2e2e2e' : '0 2px 4px rgba(21,23,28,.10), 0 30px 80px -20px rgba(21,23,28,.45)',
      }}
    >
      <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 12, padding: '0 28px 0 40px', borderBottom: '1px solid #2a2d34', fontFamily: MONO, fontSize: 20, color: T_DIM }}>
        {[0, 1, 2].map((i) => <div key={i} style={{ width: 14, height: 14, borderRadius: 7, background: '#3a3e47' }} />)}
        <div style={{ marginLeft: 18 }}>agent · my-app</div>
        <div style={{ flex: 1 }} />
        {stopped && <div style={{ opacity: shown }}>exit {screens[shot.key].exit}</div>}
      </div>
      <div style={{ position: 'absolute', left: 52, right: 40, top: 56 + 36, height: VIEW, overflow: 'hidden', fontFamily: MONO, fontSize: SIZE, opacity: swap }}>
        <div>
          <div style={{ height: LH, whiteSpace: 'pre', color: T_FG }}>
            <span style={{ color: T_DIM }}>$ </span>
            {typed.slice(0, chars)}
            {lines.length === 0 && <span style={{ display: 'inline-block', width: SIZE * 0.6, height: SIZE * 1.1, verticalAlign: -5, marginLeft: 2, background: cursorOn ? T_FG : 'transparent' }} />}
          </div>
          {lines.map((segs, i) => <Line key={i} segs={segs} lh={LH} />)}
        </div>
      </div>
      {badge > 0 && (
        <div
          style={{
            position: 'absolute', right: 36, top: 56 + 28, padding: '10px 22px', borderRadius: 999,
            background: ANDON, color: PAPER, fontFamily: COND, fontWeight: 700, fontSize: 30, letterSpacing: '0.08em',
            opacity: Math.min(1, badge * 2), transform: `scale(${0.6 + 0.4 * badge})`, transformOrigin: 'right center',
          }}
        >
          STOPPED
        </div>
      )}
    </div>
  );
};

// ---------- next: the kanban band. Words come from the subtitles; the cards carry no made-up data ----------
const Kanban: React.FC = () => {
  const f = useCurrentFrame();
  const up = ramp(f, SCENES.next, SCENES.next + 22);
  const out = ramp(f, SCENES.end, SCENES.end + 18);
  if (up <= 0 || out >= 1) return null;
  const cols = 3;
  const colW = 440;
  const gap = 40;
  const left = (1920 - cols * colW - (cols - 1) * gap) / 2;
  const top = 150;
  // Three blank cards wait in the first column. One at a time each goes to the middle column and
  // on to the last, until all three are done: work moves one way, and nothing is left behind.
  const cards = [0, 1, 2].map((i) => {
    const go = SCENES.next + 46 + i * 26;
    return { row: i, toDoing: go, toDone: go + 22 };
  });
  return (
    <AbsoluteFill style={{ background: KANBAN, transform: `translateY(${(1 - up) * 1080 - out * 1080}px)` }}>
      <div style={{ position: 'absolute', left, top: 84, fontFamily: MONO, fontSize: 22, color: INK, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: ramp(f, SCENES.next + 16, SCENES.next + 30) }}>
        next · kanban
      </div>
      {Array.from({ length: cols }, (_, c) => (
        <div key={c} style={{ position: 'absolute', left: left + c * (colW + gap), top, width: colW, height: 600, borderRadius: 16, background: 'rgba(21,23,28,.08)', opacity: ramp(f, SCENES.next + 14 + c * 4, SCENES.next + 30 + c * 4) }}>
          <div style={{ position: 'absolute', left: 28, top: 22, fontFamily: MONO, fontSize: 22, letterSpacing: '0.1em', textTransform: 'uppercase', color: INK, opacity: 0.7 }}>{['to do', 'doing', 'done'][c]}</div>
        </div>
      ))}
      {cards.map((card, i) => {
        const o = ramp(f, SCENES.next + 26 + i * 5, SCENES.next + 38 + i * 5);
        const a = ramp(f, card.toDoing, card.toDoing + 16);
        const b = ramp(f, card.toDone, card.toDone + 16);
        const col = a + b;
        // to do keeps its row; doing holds one card at a time (row 0); done stacks in order
        const row = b > 0 ? card.row * b : card.row * (1 - a);
        const lift = (Math.sin(Math.PI * a) + Math.sin(Math.PI * b)) * 10; // a card lifts a little as it moves
        const x = left + col * (colW + gap) + 24;
        const y = top + 68 + row * 132 - lift;
        return (
          <div key={i} style={{ position: 'absolute', left: x, top: y, width: colW - 48, height: 108, borderRadius: 12, background: PAPER, opacity: o, boxShadow: '0 1px 2px rgba(21,23,28,.12), 0 8px 24px -10px rgba(21,23,28,.3)', transform: `translateY(${(1 - o) * 16}px)` }}>
            <div style={{ position: 'absolute', left: 0, top: 18, bottom: 18, width: 6, borderRadius: 3, background: col >= 1.5 ? '#2f8f5b' : INK, opacity: 0.8 }} />
            <div style={{ position: 'absolute', left: 28, top: 30, width: 220, height: 14, borderRadius: 7, background: 'rgba(21,23,28,.18)' }} />
            <div style={{ position: 'absolute', left: 28, top: 60, width: 140, height: 14, borderRadius: 7, background: 'rgba(21,23,28,.10)' }} />
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

// ---------- the end card: logo C, the wordmark, the one command, the address ----------
const EndCard: React.FC = () => {
  const f = useCurrentFrame();
  const t0 = SCENES.end + 10;
  const mark = ramp(f, t0, t0 + 18, snap);
  if (mark <= 0) return null;
  const word = ramp(f, t0 + 10, t0 + 28);
  const cmd = ramp(f, t0 + 26, t0 + 44);
  const url = ramp(f, t0 + 40, t0 + 56);
  const rise = (t: number) => ({ opacity: t, transform: `translateY(${(1 - t) * 14}px)` });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: -110 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 40 }}>
          {/* logo C, geometry from site/src/components/brand/Mark.astro */}
          <svg width={168} height={168} viewBox="0 0 512 512" style={{ opacity: Math.min(1, mark * 1.5), transform: `scale(${0.7 + 0.3 * mark})` }}>
            <rect x="4" y="4" width="504" height="504" rx="110" fill={INK} stroke={DARK ? '#2e2e2e' : 'none'} strokeWidth={8} />
            <g fill="none" stroke="#eef2fb" strokeWidth="40" strokeLinecap="round">
              <path d="M150 120 C 160 210, 205 255, 262 268" />
              <path d="M356 112 C 360 220, 300 300, 160 410" />
            </g>
            <circle cx="268" cy="272" r={38 * ramp(f, t0 + 8, t0 + 20, snap)} fill={CORAL} />
          </svg>
          <div style={{ ...rise(word), display: 'flex', alignItems: 'baseline', color: PAGE_TEXT, lineHeight: 1 }}>
            <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 124, letterSpacing: '-0.02em' }}>yokoten</span>
            <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 104, marginLeft: 22 }}>横展</span>
          </div>
        </div>
        <div style={{ ...rise(cmd), marginTop: 64, padding: '20px 36px', borderRadius: 14, background: T_BG, boxShadow: PAGE_EDGE, color: T_FG, fontFamily: MONO, fontWeight: 500, fontSize: 40 }}>
          <span style={{ color: T_DIM }}>$ </span>npx yokoten
        </div>
        <div style={{ ...rise(url), marginTop: 30, fontFamily: MONO, fontSize: 28, color: PAGE_SMALL, letterSpacing: '0.04em' }}>yokoten.app</div>
      </div>
    </AbsoluteFill>
  );
};

export const Promo: React.FC = () => {
  useFonts();
  return (
    <AbsoluteFill style={{ background: PAGE }}>
      {/* original score, generated by scripts/music.mjs */}
      <Html5Audio src={staticFile('music.wav')} />
      <Terminal />
      <Kanban />
      <EndCard />
    </AbsoluteFill>
  );
};
