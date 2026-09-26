// Turns font outlines into two things:
//  1. THREE.Shape[] (with holes) for extruded, bevelled render geometry.
//  2. A small set of axis-aligned boxes that approximate the glyph for physics.
//
// Physics on a convex hull makes an "L" behave like a triangle and an "O" like a
// disc with no hole. Instead each glyph is rasterised on a coarse grid (nonzero
// winding, so it works for TrueType and CFF outlines alike) and the filled cells
// are greedily merged into rectangles. The result is a compound collider that
// actually has the letter's silhouette, at a cost of a handful of cuboids.

import { Path, Shape, ShapeUtils, Vector2 } from 'three';

export type PathCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' };

export interface Contour {
  /** Commands in y-up em space, starting with an M. */
  commands: PathCommand[];
  /** Flattened polygon, used for winding, containment and rasterising. */
  points: Vector2[];
  /** Signed area (positive = counter-clockwise in y-up space). */
  area: number;
}

export interface Box2 {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const EPS = 1e-9;

/** Split opentype path commands (y-down) into y-up contours with flattened points. */
export function toContours(commands: readonly PathCommand[], flipY = true): Contour[] {
  const s = flipY ? -1 : 1;
  const out: Contour[] = [];
  let cmds: PathCommand[] = [];
  let pts: Vector2[] = [];
  let cx = 0;
  let cy = 0;

  const flush = () => {
    if (pts.length >= 3) {
      // Drop an explicit closing point that duplicates the start.
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS) pts.pop();
      if (pts.length >= 3) {
        const area = ShapeUtils.area(pts);
        if (Math.abs(area) > 1e-7) out.push({ commands: cmds, points: pts, area });
      }
    }
    cmds = [];
    pts = [];
  };

  for (const c of commands) {
    switch (c.type) {
      case 'M':
        flush();
        cx = c.x;
        cy = c.y * s;
        cmds.push({ type: 'M', x: cx, y: cy });
        pts.push(new Vector2(cx, cy));
        break;
      case 'L': {
        const x = c.x;
        const y = c.y * s;
        if (Math.abs(x - cx) < EPS && Math.abs(y - cy) < EPS) break; // zero-length segment
        cmds.push({ type: 'L', x, y });
        pts.push(new Vector2(x, y));
        cx = x;
        cy = y;
        break;
      }
      case 'Q': {
        const x1 = c.x1, y1 = c.y1 * s, x = c.x, y = c.y * s;
        cmds.push({ type: 'Q', x1, y1, x, y });
        for (let i = 1; i <= 6; i++) {
          const t = i / 6, u = 1 - t;
          pts.push(new Vector2(u * u * cx + 2 * u * t * x1 + t * t * x, u * u * cy + 2 * u * t * y1 + t * t * y));
        }
        cx = x;
        cy = y;
        break;
      }
      case 'C': {
        const x1 = c.x1, y1 = c.y1 * s, x2 = c.x2, y2 = c.y2 * s, x = c.x, y = c.y * s;
        cmds.push({ type: 'C', x1, y1, x2, y2, x, y });
        for (let i = 1; i <= 8; i++) {
          const t = i / 8, u = 1 - t;
          const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
          pts.push(new Vector2(a * cx + b * x1 + d * x2 + e * x, a * cy + b * y1 + d * y2 + e * y));
        }
        cx = x;
        cy = y;
        break;
      }
      case 'Z':
        flush();
        break;
    }
  }
  flush();
  return out;
}

export function pointInPolygon(p: Vector2, poly: readonly Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Nonzero winding number of p against all contours. */
export function winding(x: number, y: number, contours: readonly Contour[]): number {
  let w = 0;
  for (const c of contours) {
    const poly = c.points;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j], b = poly[i];
      if (a.y <= y) {
        if (b.y > y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) > 0) w++;
      } else if (b.y <= y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) < 0) w--;
    }
  }
  return w;
}

function trace(target: Path, commands: readonly PathCommand[]) {
  for (const c of commands) {
    if (c.type === 'M') target.moveTo(c.x, c.y);
    else if (c.type === 'L') target.lineTo(c.x, c.y);
    else if (c.type === 'Q') target.quadraticCurveTo(c.x1, c.y1, c.x, c.y);
    else if (c.type === 'C') target.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y);
  }
}

/**
 * Group contours into shapes with holes. Fonts wind outer contours one way and
 * counters the other; which way depends on the format, so the direction of the
 * largest contour is taken as "solid". Each hole is attached to the smallest
 * solid that contains it.
 */
export function toShapes(contours: readonly Contour[]): Shape[] {
  if (contours.length === 0) return [];
  const largest = contours.reduce((a, b) => (Math.abs(b.area) > Math.abs(a.area) ? b : a));
  const solidSign = Math.sign(largest.area);
  const solids = contours.filter((c) => Math.sign(c.area) === solidSign);
  const holes = contours.filter((c) => Math.sign(c.area) !== solidSign);

  const shapes = new Map<Contour, Shape>();
  for (const s of solids) {
    const shape = new Shape();
    trace(shape, s.commands);
    shapes.set(s, shape);
  }
  for (const h of holes) {
    const probe = h.points[0];
    let parent: Contour | null = null;
    for (const s of solids) {
      if (pointInPolygon(probe, s.points) && (!parent || Math.abs(s.area) < Math.abs(parent.area))) parent = s;
    }
    if (parent) {
      const path = new Path();
      trace(path, h.commands);
      shapes.get(parent)!.holes.push(path);
    } else {
      // An oddly wound contour that sits on its own: treat it as ink.
      const shape = new Shape();
      trace(shape, h.commands);
      shapes.set(h, shape);
    }
  }
  return [...shapes.values()];
}

export function contourBounds(contours: readonly Contour[]): Box2 | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of contours) {
    for (const p of c.points) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/**
 * Approximate the filled area of a glyph with axis-aligned rectangles.
 * @param cell target grid cell size in em
 * @param tolerance how many cells a run may wander and still merge with the
 *   rectangle above it (keeps diagonal strokes from exploding into one box per row)
 */
export function rasterizeBoxes(contours: readonly Contour[], cell = 0.07, tolerance = 1): Box2[] {
  const b = contourBounds(contours);
  if (!b) return [];
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const cols = Math.max(1, Math.round(w / cell));
  const rows = Math.max(1, Math.round(h / cell));
  const cw = w / cols;
  const ch = h / rows;

  interface Open { c0: number; c1: number; lastC0: number; lastC1: number; r0: number; r1: number; w0: number }
  const boxes: Box2[] = [];
  let open: Open[] = [];
  const close = (o: Open) =>
    boxes.push({ x0: b.x0 + o.c0 * cw, x1: b.x0 + o.c1 * cw, y0: b.y0 + o.r0 * ch, y1: b.y0 + o.r1 * ch });

  for (let r = 0; r < rows; r++) {
    const y = b.y0 + (r + 0.5) * ch;
    const runs: [number, number][] = [];
    let start = -1;
    for (let c = 0; c <= cols; c++) {
      const filled = c < cols && winding(b.x0 + (c + 0.5) * cw, y, contours) !== 0;
      if (filled && start < 0) start = c;
      if (!filled && start >= 0) {
        runs.push([start, c]);
        start = -1;
      }
    }
    const next: Open[] = [];
    for (const [c0, c1] of runs) {
      const i = open.findIndex(
        (o) =>
          Math.abs(o.lastC0 - c0) <= tolerance &&
          Math.abs(o.lastC1 - c1) <= tolerance &&
          Math.max(o.c1, c1) - Math.min(o.c0, c0) <= o.w0 + 2 * tolerance,
      );
      if (i >= 0) {
        const o = open.splice(i, 1)[0];
        o.c0 = Math.min(o.c0, c0);
        o.c1 = Math.max(o.c1, c1);
        o.lastC0 = c0;
        o.lastC1 = c1;
        o.r1 = r + 1;
        next.push(o);
      } else {
        next.push({ c0, c1, lastC0: c0, lastC1: c1, r0: r, r1: r + 1, w0: c1 - c0 });
      }
    }
    open.forEach(close);
    open = next;
  }
  open.forEach(close);

  // Tiny glyphs (a period at a coarse grid) can miss every cell centre.
  return boxes.length ? boxes : [b];
}
