// Device tilt → gravity. On a phone, "down" follows the real world: tilt the
// screen and the type slides; lay it flat and it falls away from you.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const RAD = Math.PI / 180;

/**
 * Unit gravity vector in screen space (x right, y up, z toward the viewer)
 * from DeviceOrientationEvent beta/gamma (degrees) and screen orientation angle.
 * Derived from the W3C Z-X'-Y'' Euler convention: g = Rᵀ · (0, 0, -1).
 */
export function orientationToGravity(beta: number, gamma: number, screenAngle = 0): Vec3 {
  const b = beta * RAD;
  const g = gamma * RAD;
  const dx = Math.cos(b) * Math.sin(g);
  const dy = -Math.sin(b);
  const dz = -Math.cos(b) * Math.cos(g);
  const a = screenAngle * RAD;
  return {
    x: dx * Math.cos(a) - dy * Math.sin(a),
    y: dx * Math.sin(a) + dy * Math.cos(a),
    z: dz,
  };
}

export type TiltPermission = 'granted' | 'denied' | 'unsupported';

interface OrientationCtor {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

export function tiltSupported(): boolean {
  return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window && matchMedia('(pointer: coarse)').matches;
}

/** Must be called from a user gesture on iOS. */
export async function requestTilt(): Promise<TiltPermission> {
  if (!tiltSupported()) return 'unsupported';
  const ctor = window.DeviceOrientationEvent as unknown as OrientationCtor;
  const motion = (window as unknown as { DeviceMotionEvent?: OrientationCtor }).DeviceMotionEvent;
  try {
    if (typeof ctor.requestPermission === 'function') {
      const res = await ctor.requestPermission();
      if (res !== 'granted') return 'denied';
      // Shake-to-explode needs motion too; failure here is not fatal.
      await motion?.requestPermission?.().catch(() => 'denied');
    }
    return 'granted';
  } catch {
    return 'denied';
  }
}

export class TiltSensor {
  gravity: Vec3 | null = null;
  private lastShake = 0;
  private readonly onOrient = (e: DeviceOrientationEvent) => {
    if (e.beta == null || e.gamma == null) return;
    const angle = screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0;
    const g = orientationToGravity(e.beta, e.gamma, angle);
    // Light smoothing so sensor noise doesn't jitter resting letters.
    this.gravity = this.gravity
      ? { x: this.gravity.x * 0.7 + g.x * 0.3, y: this.gravity.y * 0.7 + g.y * 0.3, z: this.gravity.z * 0.7 + g.z * 0.3 }
      : g;
  };
  private readonly onMotion = (e: DeviceMotionEvent) => {
    const a = e.acceleration;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    const mag = Math.hypot(a.x, a.y, a.z);
    const now = performance.now();
    if (mag > 17 && now - this.lastShake > 900) {
      this.lastShake = now;
      this.onShake();
    }
  };

  constructor(private readonly onShake: () => void) {}

  start() {
    window.addEventListener('deviceorientation', this.onOrient);
    window.addEventListener('devicemotion', this.onMotion);
  }

  stop() {
    window.removeEventListener('deviceorientation', this.onOrient);
    window.removeEventListener('devicemotion', this.onMotion);
    this.gravity = null;
  }
}
