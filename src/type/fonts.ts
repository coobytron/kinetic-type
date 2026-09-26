// Font registry and per-glyph cache. Fonts ship as WOFF from @fontsource and are
// parsed in the browser with opentype.js, so every glyph is available as a real
// outline (not a canvas bitmap) for extrusion, physics and SVG export.

import opentype, { type Font } from 'opentype.js';
import type { Shape } from 'three';
import type { FontId } from '../settings';
import type { Metrics } from './layout';
import { readKerning, type KernFn } from './gpos';
import { contourBounds, rasterizeBoxes, toContours, toShapes, type Box2, type Contour } from './outline';

import interUrl from '@fontsource/inter/files/inter-latin-900-normal.woff?url';
import archivoUrl from '@fontsource/archivo-black/files/archivo-black-latin-400-normal.woff?url';
import dmSerifUrl from '@fontsource/dm-serif-display/files/dm-serif-display-latin-400-normal.woff?url';
import instrumentUrl from '@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff?url';
import spaceMonoUrl from '@fontsource/space-mono/files/space-mono-latin-700-normal.woff?url';

export interface FontEntry {
  id: FontId;
  label: string;
  url?: string;
}

export const FONTS: FontEntry[] = [
  { id: 'inter', label: 'Inter Black', url: interUrl },
  { id: 'archivo', label: 'Archivo Black', url: archivoUrl },
  { id: 'dmserif', label: 'DM Serif', url: dmSerifUrl },
  { id: 'instrument', label: 'Instrument', url: instrumentUrl },
  { id: 'spacemono', label: 'Space Mono', url: spaceMonoUrl },
];

export interface GlyphData {
  ch: string;
  advance: number;
  contours: Contour[];
  shapes: Shape[];
  /** Physics boxes in em, y-up, relative to the glyph origin on the baseline. */
  boxes: Box2[];
  bounds: Box2 | null;
}

export class LoadedFont {
  readonly glyphs = new Map<string, GlyphData>();
  private readonly kerns = new Map<string, number>();
  readonly metrics: Metrics;
  readonly name: string;

  constructor(
    readonly font: Font,
    kern: KernFn | null = null,
  ) {
    const upm = font.unitsPerEm;
    const os2 = font.tables.os2;
    const cap = os2?.sCapHeight ? os2.sCapHeight / upm : this.glyphBounds('H')?.y1 ?? 0.72;
    const n = font.names.windows ?? font.names.macintosh ?? font.names.unicode ?? (font.names as unknown as { fullName?: Record<string, string>; fontFamily?: Record<string, string> });
    this.name = n?.fullName?.en ?? n?.fontFamily?.en ?? 'Custom font';
    const lineHeight = Math.max(1.0, ((font.ascender - font.descender) / upm) * 0.92);
    this.metrics = {
      advance: (ch) => this.glyph(ch).advance,
      kern: (a, b) => {
        const key = a + b;
        let v = this.kerns.get(key);
        if (v === undefined) {
          try {
            const l = font.charToGlyph(a).index;
            const r = font.charToGlyph(b).index;
            v = (kern ? kern(l, r) : font.getKerningValue(font.charToGlyph(a), font.charToGlyph(b))) / upm;
          } catch {
            v = 0;
          }
          this.kerns.set(key, v);
        }
        return v;
      },
      space: (font.charToGlyph(' ').advanceWidth ?? upm * 0.25) / upm,
      lineHeight,
      capHeight: cap,
    };
  }

  private glyphBounds(ch: string) {
    return contourBounds(toContours(this.font.charToGlyph(ch).getPath(0, 0, 1).commands));
  }

  glyph(ch: string): GlyphData {
    let g = this.glyphs.get(ch);
    if (!g) {
      const glyph = this.font.charToGlyph(ch);
      const contours = toContours(glyph.getPath(0, 0, 1).commands);
      g = {
        ch,
        advance: (glyph.advanceWidth ?? this.font.unitsPerEm * 0.5) / this.font.unitsPerEm,
        contours,
        shapes: toShapes(contours),
        boxes: rasterizeBoxes(contours),
        bounds: contourBounds(contours),
      };
      this.glyphs.set(ch, g);
    }
    return g;
  }
}

const cache = new Map<string, Promise<LoadedFont>>();

export async function parseFont(buffer: ArrayBuffer): Promise<LoadedFont> {
  const font = opentype.parse(buffer);
  return new LoadedFont(font, await readKerning(buffer));
}

export function loadFont(entry: FontEntry): Promise<LoadedFont> {
  if (!entry.url) return Promise.reject(new Error(`No source for font ${entry.id}`));
  let p = cache.get(entry.url);
  if (!p) {
    p = fetch(entry.url)
      .then((r) => {
        if (!r.ok) throw new Error(`Font request failed (${r.status})`);
        return r.arrayBuffer();
      })
      .then(parseFont);
    p.catch(() => cache.delete(entry.url!));
    cache.set(entry.url, p);
  }
  return p;
}
