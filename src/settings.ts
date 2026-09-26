// The whole composition is described by one plain, serialisable Settings object.
// It is what gets saved locally, encoded into share links and applied by presets,
// so everything here is validated and clamped on the way in.

export const MODES = ['words', 'letters', 'chain'] as const;
export const FINISHES = ['ink', 'enamel', 'chrome', 'glass', 'clay'] as const;
export const FONT_IDS = ['inter', 'archivo', 'dmserif', 'instrument', 'spacemono', 'custom'] as const;

export type Mode = (typeof MODES)[number];
export type Finish = (typeof FINISHES)[number];
export type FontId = (typeof FONT_IDS)[number];

export interface Settings {
  text: string;
  mode: Mode;
  font: FontId;
  /** Em size in world units (the room is ~10 units tall on desktop). */
  size: number;
  /** Extra space between glyphs, in em. */
  tracking: number;
  /** Extrusion depth, in em. */
  depth: number;
  /** Bevel size, in em. */
  bevel: number;
  finish: Finish;
  ink: string;
  accent: string;
  bg: string;
  /** Share of tokens drawn in the accent colour. */
  accentRatio: number;
  /** Multiplier on standard gravity; negative floats upward. */
  gravity: number;
  wind: number;
  fan: number;
  bounce: number;
  friction: number;
  floor: boolean;
  hang: boolean;
  /** Constrain everything to the poster plane (2.5D), like the original. */
  flat: boolean;
  sound: boolean;
  seed: number;
}

export const DEFAULTS: Settings = {
  text: 'Hi, I’m an Art Director utilizing AI to create tooling.',
  mode: 'words',
  font: 'inter',
  size: 1.05,
  tracking: -0.01,
  depth: 0.22,
  bevel: 0.012,
  finish: 'ink',
  ink: '#111111',
  accent: '#ff4f1f',
  bg: '#f6f4ef',
  accentRatio: 0.16,
  gravity: 1,
  wind: 0,
  fan: 0.5,
  bounce: 0.35,
  friction: 0.6,
  floor: true,
  hang: false,
  flat: false,
  sound: false,
  seed: 7,
};

type NumericKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];

export const RANGES: Record<NumericKey, { min: number; max: number; step: number }> = {
  size: { min: 0.4, max: 2.4, step: 0.01 },
  tracking: { min: -0.1, max: 0.4, step: 0.005 },
  depth: { min: 0.02, max: 1.2, step: 0.01 },
  bevel: { min: 0, max: 0.04, step: 0.001 },
  accentRatio: { min: 0, max: 1, step: 0.01 },
  gravity: { min: -1, max: 2.5, step: 0.01 },
  wind: { min: -1, max: 1, step: 0.01 },
  fan: { min: 0, max: 1, step: 0.01 },
  bounce: { min: 0, max: 0.98, step: 0.01 },
  friction: { min: 0, max: 1.5, step: 0.01 },
  seed: { min: 0, max: 2 ** 31 - 1, step: 1 },
};

export const MAX_TEXT = 280;

const HEX = /^#[0-9a-f]{6}$/i;

function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

function num(key: NumericKey, value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const { min, max } = RANGES[key];
  return Math.min(max, Math.max(min, n));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function colour(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : fallback;
}

/** Merge untrusted input (storage, URL, presets) over a base, keeping only valid values. */
export function sanitize(input: unknown, base: Settings = DEFAULTS): Settings {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const text = typeof src.text === 'string' ? src.text.slice(0, MAX_TEXT) : base.text;
  return {
    text,
    mode: oneOf(MODES, src.mode, base.mode),
    font: oneOf(FONT_IDS, src.font, base.font),
    size: num('size', src.size, base.size),
    tracking: num('tracking', src.tracking, base.tracking),
    depth: num('depth', src.depth, base.depth),
    bevel: num('bevel', src.bevel, base.bevel),
    finish: oneOf(FINISHES, src.finish, base.finish),
    ink: colour(src.ink, base.ink),
    accent: colour(src.accent, base.accent),
    bg: colour(src.bg, base.bg),
    accentRatio: num('accentRatio', src.accentRatio, base.accentRatio),
    gravity: num('gravity', src.gravity, base.gravity),
    wind: num('wind', src.wind, base.wind),
    fan: num('fan', src.fan, base.fan),
    bounce: num('bounce', src.bounce, base.bounce),
    friction: num('friction', src.friction, base.friction),
    floor: bool(src.floor, base.floor),
    hang: bool(src.hang, base.hang),
    flat: bool(src.flat, base.flat),
    sound: bool(src.sound, base.sound),
    seed: Math.round(num('seed', src.seed, base.seed)),
  };
}

/** Keys whose change means the type has to be re-set and the bodies rebuilt. */
export const REBUILD_KEYS: readonly (keyof Settings)[] = ['text', 'mode', 'font', 'size', 'tracking', 'depth', 'bevel', 'seed'];

export function changedKeys(a: Settings, b: Settings): (keyof Settings)[] {
  return (Object.keys(b) as (keyof Settings)[]).filter((k) => a[k] !== b[k]);
}

// ---------------------------------------------------------------------------
// Share links: #k=<base64url(JSON)>. Only values that differ from DEFAULTS are
// written, which keeps links short enough to paste into a message.

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeSettings(s: Settings): string {
  const diff: Partial<Record<keyof Settings, unknown>> = {};
  for (const k of Object.keys(s) as (keyof Settings)[]) {
    if (s[k] !== DEFAULTS[k]) diff[k] = s[k];
  }
  // A custom font can't travel in a link; the receiver falls back to the default face.
  if (diff.font === 'custom') delete diff.font;
  return toBase64Url(JSON.stringify(diff));
}

export function decodeSettings(encoded: string): Settings | null {
  try {
    return sanitize(JSON.parse(fromBase64Url(encoded)));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scenes. Each is a partial patch applied over the current settings, so the
// user's text and font survive a scene change.

export interface Preset {
  id: string;
  label: string;
  hint: string;
  patch: Partial<Settings>;
}

export const PRESETS: Preset[] = [
  {
    id: 'poster',
    label: 'Poster',
    hint: 'Flat ink on paper — the original, now with real shadows.',
    patch: { mode: 'words', finish: 'ink', flat: true, gravity: 1, wind: 0, fan: 0.5, bounce: 0.35, friction: 0.6, floor: true, hang: false, bg: '#f6f4ef', ink: '#111111', accent: '#ff4f1f', accentRatio: 0.16, depth: 0.22 },
  },
  {
    id: 'storm',
    label: 'Storm',
    hint: 'Enamel letters in a gusting crosswind.',
    patch: { mode: 'letters', finish: 'enamel', flat: false, gravity: 0.45, wind: 0.55, fan: 0.9, bounce: 0.7, friction: 0.2, floor: true, hang: false, bg: '#0f1117', ink: '#f6f4ef', accent: '#0a84ff', accentRatio: 0.2, depth: 0.3 },
  },
  {
    id: 'zero',
    label: 'Zero-G',
    hint: 'No gravity, no floor, slow tumble.',
    patch: { mode: 'letters', finish: 'clay', flat: false, gravity: 0, wind: 0.04, fan: 0.35, bounce: 0.9, friction: 0.05, floor: false, hang: false, bg: '#ffffff', ink: '#121212', accent: '#ff2d55', accentRatio: 0.14, depth: 0.35 },
  },
  {
    id: 'bunting',
    label: 'Bunting',
    hint: 'Letters strung on a line, pinned at both ends.',
    patch: { mode: 'chain', finish: 'enamel', flat: true, gravity: 1, wind: 0.12, fan: 0.6, bounce: 0.2, friction: 0.5, floor: true, hang: true, bg: '#fff6e8', ink: '#1d3557', accent: '#e63946', accentRatio: 0.34, depth: 0.16 },
  },
  {
    id: 'chrome',
    label: 'Chrome',
    hint: 'Polished metal, heavy drop.',
    patch: { mode: 'words', finish: 'chrome', flat: false, gravity: 1.6, wind: 0, fan: 0.7, bounce: 0.25, friction: 0.45, floor: true, hang: false, bg: '#d9dde3', ink: '#c9ced6', accent: '#ffb000', accentRatio: 0.18, depth: 0.4 },
  },
  {
    id: 'rain',
    label: 'Rain',
    hint: 'Glass letters that fall forever.',
    patch: { mode: 'letters', finish: 'glass', flat: false, gravity: 0.7, wind: -0.08, fan: 0.6, bounce: 0.4, friction: 0.3, floor: false, hang: false, bg: '#e9eef2', ink: '#9fd3ff', accent: '#ff4f1f', accentRatio: 0.1, depth: 0.3 },
  },
];

/** Deterministic PRNG so a seed always produces the same accents and scatter. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
