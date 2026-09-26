// Typesetting, independent of fonts and physics so it can be unit tested.
// Everything is in em; the caller scales to world units.

import type { Mode } from '../settings';

export interface Metrics {
  /** Advance width of a character in em. */
  advance(ch: string): number;
  /** Kerning adjustment between two characters in em (0 when unknown). */
  kern(a: string, b: string): number;
  /** Width of a word space in em. */
  space: number;
  /** Baseline-to-baseline distance in em. */
  lineHeight: number;
  /** Cap height in em, used to centre the block optically. */
  capHeight: number;
}

export interface SetGlyph {
  ch: string;
  /** Left edge of the glyph's advance box, em. */
  x: number;
  /** Baseline, em (y-up; first line at 0, later lines negative). */
  y: number;
  advance: number;
  line: number;
  word: number;
}

export interface SetWord {
  glyphs: SetGlyph[];
  line: number;
  index: number;
  x0: number;
  x1: number;
}

export interface SetLine {
  words: SetWord[];
  width: number;
  baseline: number;
}

export interface Typeset {
  lines: SetLine[];
  width: number;
  height: number;
}

/** Split into paragraphs and words, collapsing runs of whitespace. */
export function splitWords(text: string): string[][] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((p) => p.trim().split(/\s+/).filter(Boolean))
    .filter((p) => p.length > 0);
}

function wordWidth(chars: string[], m: Metrics, tracking: number): number {
  let w = 0;
  chars.forEach((ch, i) => {
    w += m.advance(ch);
    if (i < chars.length - 1) w += m.kern(ch, chars[i + 1]) + tracking;
  });
  return w;
}

/**
 * Greedy line breaking, centred lines, block centred on (0, 0) optically
 * (half cap height above the last baseline to the top of the first cap).
 * Words longer than the measure are broken between characters.
 */
export function typeset(text: string, m: Metrics, maxWidth: number, tracking = 0): Typeset {
  const paragraphs = splitWords(text);
  type Pending = { chars: string[]; width: number }[];
  const rawLines: Pending[] = [];

  for (const para of paragraphs) {
    let line: Pending = [];
    let lineWidth = 0;
    const pushWord = (chars: string[]) => {
      const w = wordWidth(chars, m, tracking);
      const gap = line.length ? m.space + tracking : 0;
      if (line.length && lineWidth + gap + w > maxWidth) {
        rawLines.push(line);
        line = [];
        lineWidth = 0;
      }
      lineWidth += (line.length ? m.space + tracking : 0) + w;
      line.push({ chars, width: w });
    };
    for (const word of para) {
      const chars = [...word];
      if (wordWidth(chars, m, tracking) <= maxWidth) {
        pushWord(chars);
        continue;
      }
      // Hard-break an over-long word into measure-sized pieces.
      let piece: string[] = [];
      for (const ch of chars) {
        if (piece.length && wordWidth([...piece, ch], m, tracking) > maxWidth) {
          pushWord(piece);
          piece = [];
        }
        piece.push(ch);
      }
      if (piece.length) pushWord(piece);
    }
    if (line.length) rawLines.push(line);
  }

  const lines: SetLine[] = [];
  let wordIndex = 0;
  rawLines.forEach((raw, li) => {
    const width = raw.reduce((s, w, i) => s + w.width + (i ? m.space + tracking : 0), 0);
    const baseline = -li * m.lineHeight;
    let x = -width / 2;
    const words: SetWord[] = raw.map((w) => {
      const x0 = x;
      const glyphs: SetGlyph[] = [];
      w.chars.forEach((ch, i) => {
        glyphs.push({ ch, x, y: baseline, advance: m.advance(ch), line: li, word: wordIndex });
        x += m.advance(ch);
        if (i < w.chars.length - 1) x += m.kern(ch, w.chars[i + 1]) + tracking;
      });
      const word: SetWord = { glyphs, line: li, index: wordIndex++, x0, x1: x };
      x += m.space + tracking;
      return word;
    });
    lines.push({ words, width, baseline });
  });

  // Centre optically: top of first line's caps to the last baseline.
  const top = m.capHeight;
  const bottom = lines.length ? lines[lines.length - 1].baseline : 0;
  const shift = -(top + bottom) / 2;
  for (const line of lines) {
    line.baseline += shift;
    for (const w of line.words) for (const g of w.glyphs) g.y += shift;
  }

  return {
    lines,
    width: lines.reduce((mx, l) => Math.max(mx, l.width), 0),
    height: lines.length ? m.capHeight + (lines.length - 1) * m.lineHeight : 0,
  };
}

export interface TokenPlan {
  glyphs: SetGlyph[];
  line: number;
  word: number;
  /** First token of its word (letters) / every word (words). */
  wordStart: boolean;
  lineStart: boolean;
  lineEnd: boolean;
}

/** Group set glyphs into physical bodies for a mode. */
export function planTokens(set: Typeset, mode: Mode): TokenPlan[] {
  const out: TokenPlan[] = [];
  for (const line of set.lines) {
    const start = out.length;
    for (const word of line.words) {
      if (mode === 'words') {
        out.push({ glyphs: word.glyphs, line: word.line, word: word.index, wordStart: true, lineStart: false, lineEnd: false });
      } else {
        word.glyphs.forEach((g, i) =>
          out.push({ glyphs: [g], line: word.line, word: word.index, wordStart: i === 0, lineStart: false, lineEnd: false }),
        );
      }
    }
    if (out.length > start) {
      out[start].lineStart = true;
      out[out.length - 1].lineEnd = true;
    }
  }
  return out;
}

/**
 * Find the largest em size (≤ wanted) at which the text fits the room.
 * Re-sets the type at each candidate because the measure changes with size.
 */
export function fitSize(
  text: string,
  m: Metrics,
  wanted: number,
  roomWidth: number,
  roomHeight: number,
  tracking: number,
  fill = { w: 0.86, h: 0.74 },
): { size: number; set: Typeset } {
  let size = wanted;
  let set = typeset(text, m, (roomWidth * fill.w) / size, tracking);
  for (let i = 0; i < 12; i++) {
    const h = set.height * size;
    if (h <= roomHeight * fill.h) break;
    size *= Math.max(0.6, Math.sqrt((roomHeight * fill.h) / h));
    set = typeset(text, m, (roomWidth * fill.w) / size, tracking);
  }
  return { size, set };
}
