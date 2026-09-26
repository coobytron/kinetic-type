// Minimal typings for the parts of opentype.js this project uses.
declare module 'opentype.js' {
  import type { PathCommand } from './outline';

  export interface Path {
    commands: PathCommand[];
  }

  export interface Glyph {
    index: number;
    name: string | null;
    unicode?: number;
    advanceWidth?: number;
    getPath(x: number, y: number, fontSize: number): Path;
  }

  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    names: Record<string, { fontFamily?: Record<string, string>; fullName?: Record<string, string> } | undefined>;
    tables: { os2?: { sCapHeight?: number; sxHeight?: number } };
    charToGlyph(ch: string): Glyph;
    hasChar(ch: string): boolean;
    getKerningValue(left: Glyph, right: Glyph): number;
  }

  const opentype: {
    parse(buffer: ArrayBuffer): Font;
  };
  export default opentype;
}
