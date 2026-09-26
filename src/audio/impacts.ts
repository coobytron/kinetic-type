// Collision sound, synthesised (no samples). Each finish has its own voice:
// ink is a dry paper-block tock, enamel a bright click, chrome a short
// inharmonic ring, glass a high tink, clay a soft thud. Pitch follows size.

import type { Finish } from '../settings';

interface Voice {
  band: number;
  q: number;
  decay: number;
  partials: number[];
  partialDecay: number;
  lowpass: number;
}

const VOICES: Record<Finish, Voice> = {
  ink: { band: 1500, q: 2.2, decay: 0.05, partials: [], partialDecay: 0, lowpass: 6000 },
  enamel: { band: 2600, q: 3.5, decay: 0.045, partials: [3200], partialDecay: 0.06, lowpass: 9000 },
  chrome: { band: 3400, q: 6, decay: 0.05, partials: [1860, 2917, 4410], partialDecay: 0.22, lowpass: 12000 },
  glass: { band: 5200, q: 8, decay: 0.03, partials: [3150, 4700, 7100], partialDecay: 0.32, lowpass: 14000 },
  clay: { band: 520, q: 1.2, decay: 0.08, partials: [], partialDecay: 0, lowpass: 1400 },
};

export class ImpactAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private budget = 0;
  private lastRefill = 0;
  enabled = false;
  finish: Finish = 'ink';

  /** Create/resume the audio graph. Must run inside a user gesture on iOS. */
  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 6;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.7;
      this.master.connect(comp).connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 0.25);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** strength 0–1, size in world units (bigger = lower). */
  hit(strength: number, size: number) {
    if (!this.enabled || !this.ctx || !this.master || !this.noise || strength < 0.04) return;
    const now = this.ctx.currentTime;
    // Token bucket: ~28 voices/second max, so a collapsing pile doesn't become white noise.
    const t = performance.now();
    this.budget = Math.min(10, this.budget + ((t - this.lastRefill) / 1000) * 28);
    this.lastRefill = t;
    if (this.budget < 1) return;
    this.budget -= 1;

    const v = VOICES[this.finish];
    const pitch = Math.pow(1 / Math.max(0.3, size), 0.5) * (0.92 + Math.random() * 0.16);
    const gain = Math.min(1, strength * 1.4) ** 1.3 * 0.9;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = v.band * pitch;
    bp.Q.value = v.q;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = v.lowpass;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(gain, now + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, now + v.decay * (0.8 + strength));
    src.connect(bp).connect(lp).connect(env).connect(this.master);
    src.start(now, Math.random() * 0.1, v.decay * 2 + 0.05);

    for (const f of v.partials) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f * pitch;
      const pg = this.ctx.createGain();
      pg.gain.setValueAtTime(0, now);
      pg.gain.linearRampToValueAtTime(gain * 0.18, now + 0.002);
      pg.gain.exponentialRampToValueAtTime(0.0001, now + v.partialDecay);
      osc.connect(pg).connect(this.master);
      osc.start(now);
      osc.stop(now + v.partialDecay + 0.02);
    }
  }
}
