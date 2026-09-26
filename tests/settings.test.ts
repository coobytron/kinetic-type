import { describe, expect, it } from 'vitest';
import { DEFAULTS, PRESETS, RANGES, decodeSettings, encodeSettings, luminance, mulberry32, sanitize } from '../src/settings';

describe('settings', () => {
  it('clamps numbers, rejects bad enums and colours', () => {
    const s = sanitize({ size: 99, mode: 'nope', ink: 'red', gravity: '0.5', text: 42 });
    expect(s.size).toBe(RANGES.size.max);
    expect(s.mode).toBe(DEFAULTS.mode);
    expect(s.ink).toBe(DEFAULTS.ink);
    expect(s.gravity).toBe(0.5);
    expect(s.text).toBe(DEFAULTS.text);
  });

  it('round-trips through a share link, including unicode', () => {
    const s = sanitize({ ...DEFAULTS, text: 'Grüße — “type” ✺', mode: 'chain', accent: '#00FF88', seed: 1234 });
    expect(decodeSettings(encodeSettings(s))).toEqual({ ...s, accent: '#00ff88' });
  });

  it('keeps default links tiny and ignores garbage', () => {
    expect(encodeSettings(DEFAULTS).length).toBeLessThan(4);
    expect(decodeSettings('%%%')).toBeNull();
  });

  it('never puts an unshareable custom font in a link', () => {
    const s = sanitize({ ...DEFAULTS, font: 'custom' });
    expect(decodeSettings(encodeSettings(s))!.font).toBe(DEFAULTS.font);
  });

  it('ships presets that survive validation unchanged', () => {
    for (const p of PRESETS) {
      const applied = { ...DEFAULTS, ...p.patch };
      expect(sanitize(applied)).toEqual(applied);
    }
  });

  it('has a deterministic PRNG', () => {
    const a = mulberry32(9), b = mulberry32(9);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('computes relative luminance', () => {
    expect(luminance('#ffffff')).toBeCloseTo(1);
    expect(luminance('#000000')).toBeCloseTo(0);
  });
});
