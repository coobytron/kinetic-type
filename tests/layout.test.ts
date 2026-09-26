import { describe, expect, it } from 'vitest';
import { fitSize, planTokens, splitWords, typeset, type Metrics } from '../src/type/layout';

// Monospaced fake: every glyph 0.5em, space 0.25em.
const mono: Metrics = { advance: () => 0.5, kern: () => 0, space: 0.25, lineHeight: 1.2, capHeight: 0.7 };

describe('typeset', () => {
  it('splits paragraphs and collapses whitespace', () => {
    expect(splitWords('  a  b\n\n c\td ')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('wraps greedily to the measure and centres lines', () => {
    const set = typeset('aa bb cc', mono, 2.3);
    // "aa bb" = 1 + .25 + 1 = 2.25 fits; "cc" wraps.
    expect(set.lines.map((l) => l.words.length)).toEqual([2, 1]);
    for (const line of set.lines) {
      const first = line.words[0].glyphs[0].x;
      expect(first).toBeCloseTo(-line.width / 2);
    }
  });

  it('centres the block optically around y = 0', () => {
    const set = typeset('aa\nbb', mono, 10);
    const top = set.lines[0].baseline + mono.capHeight;
    const bottom = set.lines[1].baseline;
    expect(top + bottom).toBeCloseTo(0);
  });

  it('applies tracking and kerning between glyphs, not after the last one', () => {
    const kerned: Metrics = { ...mono, kern: (a, b) => (a === 'A' && b === 'V' ? -0.1 : 0) };
    const set = typeset('AV', kerned, 10, 0.05);
    const [a, v] = set.lines[0].words[0].glyphs;
    expect(v.x - a.x).toBeCloseTo(0.5 - 0.1 + 0.05);
    expect(set.lines[0].width).toBeCloseTo(0.5 + 0.5 - 0.1 + 0.05);
  });

  it('hard-breaks words longer than the measure', () => {
    const set = typeset('abcdefgh', mono, 1.6);
    expect(set.lines.length).toBeGreaterThan(1);
    expect(set.lines.every((l) => l.width <= 1.6 + 1e-9)).toBe(true);
  });
});

describe('planTokens', () => {
  const set = typeset('ab cd\nef', mono, 10);

  it('makes one body per word in words mode', () => {
    const t = planTokens(set, 'words');
    expect(t.map((x) => x.glyphs.map((g) => g.ch).join(''))).toEqual(['ab', 'cd', 'ef']);
    expect(t.every((x) => x.wordStart)).toBe(true);
  });

  it('makes one body per glyph and marks word and line boundaries', () => {
    const t = planTokens(set, 'chain');
    expect(t).toHaveLength(6);
    expect(t.filter((x) => x.wordStart).map((x) => x.glyphs[0].ch)).toEqual(['a', 'c', 'e']);
    expect(t.filter((x) => x.lineStart).map((x) => x.glyphs[0].ch)).toEqual(['a', 'e']);
    expect(t.filter((x) => x.lineEnd).map((x) => x.glyphs[0].ch)).toEqual(['d', 'f']);
  });
});

describe('fitSize', () => {
  it('keeps the wanted size when the text fits', () => {
    expect(fitSize('short', mono, 1, 20, 10, 0).size).toBe(1);
  });

  it('shrinks long text until it fits the room height', () => {
    const long = 'lorem ipsum dolor sit amet '.repeat(12);
    const { size, set } = fitSize(long, mono, 1.5, 8, 6, 0);
    expect(size).toBeLessThan(1.5);
    expect(set.height * size).toBeLessThanOrEqual(6 * 0.74 + 1e-6);
  });
});
