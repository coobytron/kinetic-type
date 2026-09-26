import { describe, expect, it } from 'vitest';
import { orientationToGravity } from '../src/input/tilt';

function close(v: { x: number; y: number; z: number }, x: number, y: number, z: number) {
  expect(v.x).toBeCloseTo(x);
  expect(v.y).toBeCloseTo(y);
  expect(v.z).toBeCloseTo(z);
}

describe('orientationToGravity', () => {
  it('points down the screen when the phone is held upright', () => close(orientationToGravity(90, 0), 0, -1, 0));
  it('points into the screen when the phone lies flat', () => close(orientationToGravity(0, 0), 0, 0, -1));
  it('slides right when the right edge dips', () => close(orientationToGravity(0, 90), 1, 0, 0));
  it('follows landscape rotation', () => {
    // Phone turned counter-clockwise into landscape: its left edge is now the floor.
    close(orientationToGravity(0, -90, 90), 0, -1, 0);
    // And clockwise the other way.
    close(orientationToGravity(0, 90, 270), 0, -1, 0);
  });
  it('is always a unit vector', () => {
    for (const [b, g, a] of [[12, -40, 0], [70, 33, 90], [-20, 80, 180]]) {
      const v = orientationToGravity(b, g, a);
      expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1);
    }
  });
});
