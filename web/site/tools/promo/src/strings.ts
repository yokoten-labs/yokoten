// The words the promo says, per language, and when it says them. The video draws no sentences of its
// own: these come only from the subtitle tracks that subtitles.mjs writes. Promo.tsx imports DURATION,
// FPS, SCENES and END_CARD from here, so the timings live in this file alone.
// Keep this file free of imports and non-erasable TypeScript, so Node can load it directly.

export type Lang = 'en' | 'zh' | 'tw' | 'ja';

export const FPS = 30;
export const DURATION = 960; // 32 s at 30 fps

/** Where each scene starts; the next one's start is its end. music.mjs resolves on `next` (frame 690). */
export const SCENES = { type: 0, stop: 120, more: 300, tag: 390, first: 480, next: 690, end: 840 } as const;

/** A subtitle cue is on screen from frame `from` to frame `to`; the scenes in Promo.tsx are paced to these. */
export type CaptionTiming = { from: number; to: number };

export const CAPTION_TIMINGS: CaptionTiming[] = [
  { from: 8, to: 114 },
  { from: 132, to: 294 },
  { from: 310, to: 386 },
  { from: 398, to: 474 },
  { from: 492, to: 680 },
  { from: 702, to: 834 },
];

/** The end card: the slogan rises at frame 856 and stays to the last frame. */
export const END_CARD: CaptionTiming = { from: 856, to: DURATION };

export type Strings = {
  /** BCP 47 tag, for <track srclang>. */
  tag: string;
  /** The track's name in its own language, for the player's menu. */
  label: string;
  /** One entry per CAPTION_TIMINGS item; each string is one line. */
  captions: string[][];
  /** The headline, said under the logo on the end card. Same words as the home page's h1. */
  slogan: string;
};

export const STRINGS: Record<Lang, Strings> = {
  en: {
    tag: 'en',
    label: 'English',
    captions: [
      ['Your AI agent moves fast.'],
      ['yokoten checks each command before it runs.'],
      ['Wipe your home folder? Stopped.'],
      ['Release without asking you? Stopped.'],
      ['Set it up with one command.'],
      ['Next: see every agent’s work on one board.'],
    ],
    slogan: 'Stops the mistake you can’t undo.',
  },
  zh: {
    tag: 'zh-Hans',
    label: '简体中文',
    captions: [
      ['你的 AI agent 动作很快。'],
      ['命令还没执行，yokoten 就先拦下。'],
      ['想清空你的主目录？拦下。'],
      ['没经过你就发版？也拦下。'],
      ['一条命令，就能装好。'],
      ['接下来：每个 agent 在做什么，一块看板全看到。'],
    ],
    slogan: '拦住 AI agent 那些收不回来的错误。',
  },
  // Taiwan usage (家目錄, 指令, 設定), not a character conversion. Each line says what yokoten does, as the
  // English one implies: a bare '清空你的家目錄' read as if the video did it (owner, 2026-10-28).
  tw: {
    tag: 'zh-Hant-TW',
    label: '繁體中文',
    captions: [
      ['你的 AI agent 動作很快。'],
      ['指令還沒執行，yokoten 就先擋下。'],
      ['想清空你的家目錄？擋下。'],
      ['沒經過你就發布版本？也擋下。'],
      ['一個指令，就能裝好。'],
      ['接下來：每個 agent 在做什麼，一塊看板全看到。'],
    ],
    slogan: '擋下 AI agent 那些收不回來的錯誤。',
  },
  ja: {
    tag: 'ja',
    label: '日本語',
    captions: [
      ['AI エージェントは手が速い。'],
      ['実行される前に、yokoten が止める。'],
      ['ホームフォルダを消そうとしても、止める。'],
      ['あなたの知らないうちにリリース？それも止める。'],
      ['コマンドひとつで、導入完了。'],
      ['次は、全エージェントの作業をひとつのボードで見渡せるように。'],
    ],
    slogan: 'AI エージェントの取り返しのつかないミスを止める。',
  },
};
