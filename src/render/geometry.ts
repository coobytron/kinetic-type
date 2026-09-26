import { BufferGeometry, ExtrudeGeometry } from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GlyphData } from '../type/fonts';

export interface ExtrudeOptions {
  depth: number;
  bevel: number;
  curveSegments: number;
  bevelSegments: number;
}

const cache = new Map<string, BufferGeometry | null>();

/**
 * Extruded, bevelled glyph at 1 em, centred on z. Cached per font/glyph/options.
 * Normals are creased at 35°: curved sides shade smoothly, cap edges stay crisp.
 */
export function glyphGeometry(fontKey: string, glyph: GlyphData, o: ExtrudeOptions): BufferGeometry | null {
  const key = `${fontKey}|${glyph.ch}|${o.depth}|${o.bevel}|${o.curveSegments}|${o.bevelSegments}`;
  if (cache.has(key)) return cache.get(key)!;
  let geo: BufferGeometry | null = null;
  if (glyph.shapes.length) {
    const bevel = Math.min(o.bevel, o.depth * 0.3);
    const core = Math.max(0.004, o.depth - 2 * bevel);
    const ext = new ExtrudeGeometry(glyph.shapes, {
      depth: core,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: o.bevelSegments,
      curveSegments: o.curveSegments,
    });
    ext.translate(0, 0, -core / 2);
    geo = toCreasedNormals(ext, (35 * Math.PI) / 180);
    if (geo !== ext) ext.dispose();
    geo.computeBoundingSphere();
  }
  cache.set(key, geo);
  return geo;
}

/** Drop cached geometry for a font (e.g. a replaced custom font). */
export function evictFont(fontKey: string) {
  for (const [k, g] of cache) {
    if (k.startsWith(fontKey + '|')) {
      g?.dispose();
      cache.delete(k);
    }
  }
}

/** Bound the cache when depth/bevel sliders generate many variants. */
export function trimGeometryCache(keep: (key: string) => boolean) {
  for (const [k, g] of cache) {
    if (!keep(k)) {
      g?.dispose();
      cache.delete(k);
    }
  }
}
