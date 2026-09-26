import { describe, expect, it } from 'vitest';
import { rasterizeBoxes, toContours, winding, type PathCommand } from '../src/type/outline';
import { loadTestFont } from './helpers';

const inter = await loadTestFont('inter/files/inter-latin-900-normal.woff');
const serif = await loadTestFont('dm-serif-display/files/dm-serif-display-latin-400-normal.woff');

function covered(boxes: { x0: number; y0: number; x1: number; y1: number }[], x: number, y: number) {
  return boxes.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
}

describe('glyph outlines', () => {
  it('flips opentype y-down commands into y-up contours', () => {
    const square: PathCommand[] = [
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 1, y: 0 },
      { type: 'L', x: 1, y: -1 },
      { type: 'L', x: 0, y: -1 },
      { type: 'Z' },
    ];
    const [c] = toContours(square);
    expect(c.points.every((p) => p.y >= 0)).toBe(true);
    expect(Math.abs(c.area)).toBeCloseTo(1);
  });

  it('gives O a counter and i two separate parts', () => {
    for (const font of [inter, serif]) {
      const o = font.glyph('O');
      expect(o.shapes).toHaveLength(1);
      expect(o.shapes[0].holes).toHaveLength(1);
      const i = font.glyph('i');
      expect(i.shapes).toHaveLength(2);
      expect(i.shapes.every((s) => s.holes.length === 0)).toBe(true);
    }
  });

  it('handles counters in B and 8 for both TrueType-style and CFF-style winding', () => {
    expect(inter.glyph('B').shapes[0].holes).toHaveLength(2);
    expect(serif.glyph('8').shapes[0].holes).toHaveLength(2);
  });

  it('uses nonzero winding for inside tests', () => {
    const o = inter.glyph('O');
    const b = o.bounds!;
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    expect(winding(cx, cy, o.contours)).toBe(0); // the counter
    expect(winding(b.x0 + 0.04, cy, o.contours)).not.toBe(0); // the stroke
  });
});

describe('physics boxes', () => {
  it('keeps the counter of an O open', () => {
    const o = inter.glyph('O');
    const b = o.bounds!;
    expect(covered(o.boxes, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)).toBe(false);
    expect(covered(o.boxes, b.x0 + 0.05, (b.y0 + b.y1) / 2)).toBe(true);
  });

  it('keeps an L concave', () => {
    const l = inter.glyph('L');
    const b = l.bounds!;
    // Top-right of an L is empty, bottom-left is ink.
    expect(covered(l.boxes, b.x1 - 0.05, b.y1 - 0.05)).toBe(false);
    expect(covered(l.boxes, b.x0 + 0.05, b.y0 + 0.05)).toBe(true);
  });

  it('stays cheap: a sentence averages under a dozen boxes per glyph', () => {
    const chars = [...'Hi, I’m an Art Director utilizing AI to create tooling.'].filter((c) => c.trim());
    const total = chars.reduce((n, c) => n + inter.glyph(c).boxes.length, 0);
    expect(total / chars.length).toBeLessThan(12);
  });

  it('falls back to the bounding box for glyphs smaller than a cell', () => {
    const [c] = toContours([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 0.01, y: 0 },
      { type: 'L', x: 0.01, y: -0.01 },
      { type: 'L', x: 0, y: -0.01 },
      { type: 'Z' },
    ]);
    const boxes = rasterizeBoxes([c], 0.07);
    expect(boxes).toHaveLength(1);
  });
});

describe('font metrics', () => {
  it('reads GPOS kerning that opentype.js misses', () => {
    expect(inter.metrics.kern('T', 'o')).toBeLessThan(0);
    expect(inter.metrics.kern('A', 'V')).toBeLessThan(0);
    expect(serif.metrics.kern('A', 'V')).toBeLessThan(0);
    expect(inter.metrics.kern('o', 'o')).toBe(0);
  });

  it('reads the family name from the name table', () => {
    expect(inter.name).toBe('Inter Black');
  });
});
