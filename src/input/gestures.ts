// Pointer gestures on the canvas. One code path for mouse, pen and touch:
//
//   press a letter ........ grab it (every finger can hold its own letter)
//   press empty space ..... fan (blow type away from the pointer)
//   double-tap / click .... shockwave
//   two fingers ........... orbit (drag) and zoom (pinch)
//   right / shift drag .... orbit; wheel or trackpad pinch zooms

import { Vector2 } from 'three';

export interface GestureHost {
  /** Try to grab at a normalised device coordinate; returns true on a hit. */
  grab(id: number, ndc: Vector2): boolean;
  moveGrab(id: number, ndc: Vector2): void;
  endGrab(id: number): void;
  fan(ndc: Vector2 | null, client?: { x: number; y: number }): void;
  shockwave(ndc: Vector2, client: { x: number; y: number }): void;
  orbit(dxPx: number, dyPx: number): void;
  zoom(factor: number): void;
  hover(ndc: Vector2): boolean;
  interacted(): void;
}

type Role = 'grab' | 'fan' | 'orbit' | 'pinch' | 'idle';

interface PointerState {
  x: number;
  y: number;
  role: Role;
  type: string;
}

export class Gestures {
  private readonly pointers = new Map<number, PointerState>();
  private lastTap = { t: 0, x: 0, y: 0 };
  private pinchDist = 0;
  private readonly ndc = new Vector2();

  constructor(
    private readonly el: HTMLElement,
    private readonly host: GestureHost,
  ) {
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.up);
    el.addEventListener('lostpointercapture', this.up);
    el.addEventListener('wheel', this.wheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // Safari's proprietary pinch events would otherwise zoom the page.
    for (const t of ['gesturestart', 'gesturechange']) el.addEventListener(t, (e) => e.preventDefault());
  }

  private toNdc(x: number, y: number): Vector2 {
    const r = this.el.getBoundingClientRect();
    return this.ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }

  private touches() {
    return [...this.pointers.entries()].filter(([, p]) => p.type === 'touch' && p.role !== 'grab');
  }

  private readonly down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    this.el.setPointerCapture?.(e.pointerId);
    this.host.interacted();
    const p: PointerState = { x: e.clientX, y: e.clientY, role: 'idle', type: e.pointerType };
    this.pointers.set(e.pointerId, p);

    if (e.button === 2 || (e.pointerType === 'mouse' && (e.shiftKey || e.altKey))) {
      p.role = 'orbit';
      return;
    }

    // A second free finger turns both into a two-finger orbit/pinch.
    if (e.pointerType === 'touch') {
      const free = this.touches().filter(([id]) => id !== e.pointerId);
      if (free.length >= 1) {
        for (const [, o] of free) {
          if (o.role === 'fan') this.host.fan(null);
          o.role = 'pinch';
        }
        p.role = 'pinch';
        this.pinchDist = this.pinchSpan();
        return;
      }
    }

    const ndc = this.toNdc(e.clientX, e.clientY);
    if (this.host.grab(e.pointerId, ndc)) {
      p.role = 'grab';
      this.el.classList.add('grabbing');
      return;
    }

    const now = performance.now();
    const client = { x: e.clientX, y: e.clientY };
    if (now - this.lastTap.t < 320 && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 34) {
      this.host.shockwave(ndc, client);
      this.lastTap.t = 0;
    } else {
      this.lastTap = { t: now, ...client };
    }
    p.role = 'fan';
    this.host.fan(ndc, client);
  };

  private pinchSpan() {
    const t = this.touches().filter(([, p]) => p.role === 'pinch');
    if (t.length < 2) return 0;
    return Math.hypot(t[0][1].x - t[1][1].x, t[0][1].y - t[1][1].y);
  }

  private readonly move = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse') this.el.classList.toggle('over', this.host.hover(this.toNdc(e.clientX, e.clientY)));
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    switch (p.role) {
      case 'grab':
        this.host.moveGrab(e.pointerId, this.toNdc(e.clientX, e.clientY));
        break;
      case 'fan':
        this.host.fan(this.toNdc(e.clientX, e.clientY), { x: e.clientX, y: e.clientY });
        break;
      case 'orbit':
        this.host.orbit(dx, dy);
        break;
      case 'pinch': {
        const n = this.touches().filter(([, o]) => o.role === 'pinch').length || 1;
        this.host.orbit(dx / n, dy / n);
        const span = this.pinchSpan();
        if (this.pinchDist > 0 && span > 0) this.host.zoom(this.pinchDist / span);
        this.pinchDist = span;
        break;
      }
    }
  };

  private readonly up = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (p.role === 'grab') this.host.endGrab(e.pointerId);
    if (p.role === 'fan') this.host.fan(null);
    if (p.role === 'pinch') {
      // The remaining finger stays inert until lifted, so it doesn't suddenly fan.
      for (const o of this.pointers.values()) if (o.role === 'pinch') o.role = 'idle';
      this.pinchDist = 0;
    }
    if (![...this.pointers.values()].some((o) => o.role === 'grab')) this.el.classList.remove('grabbing');
  };

  private readonly wheel = (e: WheelEvent) => {
    e.preventDefault();
    this.host.interacted();
    // ctrlKey = trackpad pinch on macOS; its deltas are much smaller.
    const k = e.ctrlKey ? 0.01 : 0.0012;
    this.host.zoom(Math.exp(e.deltaY * k));
  };
}
