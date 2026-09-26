// Minimal OpenType GPOS pair-kerning reader (LookupType 2, and 2 wrapped in
// LookupType 9 extensions). opentype.js skips extension lookups, which is where
// modern fonts such as Inter keep their class kerning, so without this most
// pairs (To, AV, Ty…) would be set loose.
//
// Semantics follow HarfBuzz: every lookup of the 'kern' feature contributes;
// within a lookup the first subtable that applies wins. A format 1 subtable
// applies only when the pair is listed; format 2 applies whenever the first
// glyph is covered.

export type KernFn = (left: number, right: number) => number;

interface Sub {
  coverage: (g: number) => number;
  apply: (covIndex: number, left: number, right: number) => number | null;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Locate (and if needed decompress) a table in a TTF/OTF/WOFF file. */
async function findTable(buffer: ArrayBuffer, tag: string): Promise<DataView | null> {
  const v = new DataView(buffer);
  const sig = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
  if (sig === 'wOFF') {
    const n = v.getUint16(12);
    for (let i = 0; i < n; i++) {
      const p = 44 + i * 20;
      const t = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
      if (t !== tag) continue;
      const offset = v.getUint32(p + 4);
      const comp = v.getUint32(p + 8);
      const orig = v.getUint32(p + 12);
      const raw = new Uint8Array(buffer, offset, comp);
      const data = comp < orig ? await inflate(raw) : raw.slice();
      return new DataView(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
  }
  if (sig === 'wOF2') return null; // Brotli + transformed tables: not supported
  const n = v.getUint16(4);
  for (let i = 0; i < n; i++) {
    const p = 12 + i * 16;
    const t = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
    if (t === tag) return new DataView(buffer, v.getUint32(p + 8), v.getUint32(p + 12));
  }
  return null;
}

function coverage(d: DataView, off: number): (g: number) => number {
  const format = d.getUint16(off);
  const count = d.getUint16(off + 2);
  if (format === 1) {
    const glyphs = new Map<number, number>();
    for (let i = 0; i < count; i++) glyphs.set(d.getUint16(off + 4 + i * 2), i);
    return (g) => glyphs.get(g) ?? -1;
  }
  const ranges: [number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    const p = off + 4 + i * 6;
    ranges.push([d.getUint16(p), d.getUint16(p + 2), d.getUint16(p + 4)]);
  }
  return (g) => {
    for (const [s, e, idx] of ranges) if (g >= s && g <= e) return idx + g - s;
    return -1;
  };
}

function classDef(d: DataView, off: number): (g: number) => number {
  const format = d.getUint16(off);
  if (format === 1) {
    const start = d.getUint16(off + 2);
    const count = d.getUint16(off + 4);
    return (g) => (g >= start && g < start + count ? d.getUint16(off + 6 + (g - start) * 2) : 0);
  }
  const count = d.getUint16(off + 2);
  const ranges: [number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    const p = off + 4 + i * 6;
    ranges.push([d.getUint16(p), d.getUint16(p + 2), d.getUint16(p + 4)]);
  }
  return (g) => {
    for (const [s, e, c] of ranges) if (g >= s && g <= e) return c;
    return 0;
  };
}

const bits = (n: number) => {
  let c = 0;
  for (; n; n &= n - 1) c++;
  return c;
};

/** Byte size of a ValueRecord and the offset of xAdvance within it (or -1). */
function valueLayout(format: number) {
  return { size: bits(format) * 2, xAdvance: format & 0x0004 ? bits(format & 0x0003) * 2 : -1 };
}

function pairPos(d: DataView, off: number): Sub | null {
  const format = d.getUint16(off);
  const cov = coverage(d, off + d.getUint16(off + 2));
  const vf1 = valueLayout(d.getUint16(off + 4));
  const vf2 = valueLayout(d.getUint16(off + 6));
  const read = (p: number) => (vf1.xAdvance >= 0 ? d.getInt16(p + vf1.xAdvance) : 0);
  if (format === 1) {
    const recSize = 2 + vf1.size + vf2.size;
    return {
      coverage: cov,
      apply: (ci, _l, right) => {
        const set = off + d.getUint16(off + 10 + ci * 2);
        const n = d.getUint16(set);
        // Pairs are sorted by second glyph.
        let lo = 0, hi = n - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const p = set + 2 + mid * recSize;
          const g = d.getUint16(p);
          if (g === right) return read(p + 2);
          if (g < right) lo = mid + 1;
          else hi = mid - 1;
        }
        return null;
      },
    };
  }
  if (format === 2) {
    const c1 = classDef(d, off + d.getUint16(off + 8));
    const c2 = classDef(d, off + d.getUint16(off + 10));
    const class2Count = d.getUint16(off + 14);
    const recSize = vf1.size + vf2.size;
    return {
      coverage: cov,
      apply: (_ci, left, right) => {
        const k2 = c2(right);
        if (k2 >= class2Count) return 0;
        return read(off + 16 + (c1(left) * class2Count + k2) * recSize);
      },
    };
  }
  return null;
}

export async function readKerning(buffer: ArrayBuffer): Promise<KernFn | null> {
  try {
    const d = await findTable(buffer, 'GPOS');
    if (!d) return null;
    const featureList = d.getUint16(6);
    const lookupList = d.getUint16(8);

    const kernLookups = new Set<number>();
    const fCount = d.getUint16(featureList);
    for (let i = 0; i < fCount; i++) {
      const p = featureList + 2 + i * 6;
      const tag = String.fromCharCode(d.getUint8(p), d.getUint8(p + 1), d.getUint8(p + 2), d.getUint8(p + 3));
      if (tag !== 'kern') continue;
      const f = featureList + d.getUint16(p + 4);
      const n = d.getUint16(f + 2);
      for (let j = 0; j < n; j++) kernLookups.add(d.getUint16(f + 4 + j * 2));
    }

    const lookups: Sub[][] = [];
    for (const index of [...kernLookups].sort((a, b) => a - b)) {
      const l = lookupList + d.getUint16(lookupList + 2 + index * 2);
      const type = d.getUint16(l);
      const n = d.getUint16(l + 4);
      const subs: Sub[] = [];
      for (let j = 0; j < n; j++) {
        let st = l + d.getUint16(l + 6 + j * 2);
        if (type === 9) {
          if (d.getUint16(st + 2) !== 2) continue;
          st += d.getUint32(st + 4);
        } else if (type !== 2) continue;
        const sub = pairPos(d, st);
        if (sub) subs.push(sub);
      }
      if (subs.length) lookups.push(subs);
    }
    if (!lookups.length) return null;

    return (left, right) => {
      let total = 0;
      for (const subs of lookups) {
        for (const s of subs) {
          const ci = s.coverage(left);
          if (ci < 0) continue;
          const v = s.apply(ci, left, right);
          if (v !== null) {
            total += v;
            break;
          }
        }
      }
      return total;
    };
  } catch {
    return null;
  }
}
