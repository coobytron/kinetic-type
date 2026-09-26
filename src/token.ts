import type { Group, Mesh } from 'three';
import type { SimBody } from './physics/sim';
import type { GlyphData } from './type/fonts';
import type { TokenPlan } from './type/layout';

export interface TokenGlyph {
  data: GlyphData;
  /** Offset of the glyph origin (baseline, left) from the token origin, in em. */
  ox: number;
  oy: number;
  mesh: Mesh | null;
}

/** One physical piece of type: a word or a letter. */
export interface Token {
  group: Group;
  body: SimBody;
  glyphs: TokenGlyph[];
  plan: TokenPlan;
  accent: boolean;
  /** Ink bounds in token-local em. */
  bounds: { x0: number; y0: number; x1: number; y1: number };
  /** World units per em for this build. */
  size: number;
}
