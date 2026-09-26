// Rigid-body world (Rapier, compiled to WASM). Each token is a dynamic body made
// of the cuboids from its glyph rasterisation; the room is a fixed body with six
// thick walls. Forces (wind, fan, grab, assemble) are applied as impulses per
// fixed substep so behaviour does not depend on the display's refresh rate.

import type { Collider, ImpulseJoint, RigidBody, World } from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';

export const GRAVITY = 9.81 * 2.2; // letters are ~1 unit tall; real g feels floaty at that scale

const groups = (member: number, filter: number) => (member << 16) | filter;
const TOKEN = groups(0b01, 0b11);
const GHOST = groups(0b01, 0b10); // collides with walls only (used while assembling)
const WALL = groups(0b10, 0b01);

export interface BoxSpec {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
}

export interface BodySpec {
  boxes: BoxSpec[];
  halfDepth: number;
  home: Vector3;
  /** Initial velocity kick, e.g. for scattered spawns. */
  spin?: Vector3;
}

export interface Params {
  gravity: number;
  wind: number;
  fan: number;
  bounce: number;
  friction: number;
  floor: boolean;
  flat: boolean;
}

export interface Impact {
  body: SimBody;
  /** 0–1 loudness estimate. */
  strength: number;
}

export class SimBody {
  assembling = false;
  mass = 1;
  constructor(
    readonly rb: RigidBody,
    readonly home: Vector3,
    readonly homeRot: Quaternion,
    readonly radius: number,
  ) {}
}

interface Grab {
  body: SimBody;
  local: Vector3;
  target: Vector3;
}

export interface Rope {
  a: SimBody | null;
  /** Local anchor on a (or the world point when a is null). */
  aLocal: Vector3;
  b: SimBody;
  bLocal: Vector3;
  joint: ImpulseJoint;
  fixed?: RigidBody;
  kind: 'chain' | 'hang';
}

const tmpV = new Vector3();
const tmpV2 = new Vector3();
const tmpQ = new Quaternion();
const tmpQ2 = new Quaternion();

// Rapier (~0.8 MB gzipped, WASM inlined) is loaded as its own chunk so the page,
// fonts and renderer can start in parallel with it.
type RapierApi = typeof import('@dimforge/rapier3d-compat').default;
let RAPIER: RapierApi;
let rapierReady: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  rapierReady ??= import('@dimforge/rapier3d-compat').then(async (m) => {
    await m.default.init();
    RAPIER = m.default;
  });
  return rapierReady;
}

export class Sim {
  readonly world: World;
  readonly bodies: SimBody[] = [];
  readonly ropes: Rope[] = [];
  private readonly queue: InstanceType<RapierApi['EventQueue']>;
  private readonly byCollider = new Map<number, SimBody>();
  private walls: RigidBody | null = null;
  private readonly grabs = new Map<number, Grab>();
  private time = 0;

  room = { w: 16, h: 10, d: 4 };
  params: Params = { gravity: 1, wind: 0, fan: 0.5, bounce: 0.35, friction: 0.6, floor: true, flat: false };
  /** Unit "down" vector; replaced by the device's real down when tilt is on. */
  down = new Vector3(0, -1, 0);
  fanPoint: Vector3 | null = null;
  fanRadius = 4.5;
  /** Freeze the world (used for the short "read it first" beat after building). */
  frozen = false;

  constructor(dt: number) {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.queue = new RAPIER.EventQueue(true);
    this.world.timestep = dt;
  }

  get dt() {
    return this.world.timestep;
  }

  // ---------------------------------------------------------------- room

  setRoom(w: number, h: number, d: number) {
    this.room = { w, h, d };
    if (this.walls) this.world.removeRigidBody(this.walls);
    const rb = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const t = 4;
    const wall = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) =>
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz).setCollisionGroups(WALL).setFriction(0.8),
        rb,
      );
    // Without a floor there is no ceiling either: type falls (or rises) through and is recycled.
    if (this.params.floor) {
      wall(0, -h / 2 - t, 0, w, t, d + t);
      wall(0, h / 2 + t, 0, w, t, d + t);
    }
    wall(-w / 2 - t, 0, 0, t, h * 2, d + t);
    wall(w / 2 + t, 0, 0, t, h * 2, d + t);
    wall(0, 0, -d / 2 - t, w, h * 2, t);
    wall(0, 0, d / 2 + t, w, h * 2, t);
    this.walls = rb;
    // Pull anything the resize left outside back in.
    for (const b of this.bodies) this.contain(b, true);
  }

  // -------------------------------------------------------------- bodies

  addBody(spec: BodySpec): SimBody {
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spec.home.x, spec.home.y, spec.home.z)
      .setCcdEnabled(true)
      .setLinearDamping(0.08)
      .setAngularDamping(0.25)
      .setCanSleep(true);
    const rb = this.world.createRigidBody(desc);
    let r = 0;
    for (const b of spec.boxes) {
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(b.hx, b.hy, spec.halfDepth)
          .setTranslation(b.cx, b.cy, 0)
          .setDensity(8)
          .setRestitution(this.params.bounce)
          .setFriction(this.params.friction)
          .setCollisionGroups(TOKEN)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS),
        rb,
      );
      r = Math.max(r, Math.hypot(Math.abs(b.cx) + b.hx, Math.abs(b.cy) + b.hy));
    }
    const body = new SimBody(rb, spec.home.clone(), new Quaternion(), r);
    body.mass = rb.mass();
    for (let i = 0; i < rb.numColliders(); i++) {
      const c = rb.collider(i);
      this.byCollider.set(c.handle, body);
      c.setContactForceEventThreshold(body.mass * GRAVITY * 4);
    }
    if (spec.spin) rb.setAngvel(spec.spin, true);
    this.applyFlat(body);
    this.bodies.push(body);
    return body;
  }

  clear() {
    for (const rope of this.ropes) if (rope.fixed) this.world.removeRigidBody(rope.fixed);
    this.ropes.length = 0;
    for (const b of this.bodies) this.world.removeRigidBody(b.rb);
    this.bodies.length = 0;
    this.byCollider.clear();
    this.grabs.clear();
  }

  /** Rope between two bodies (chain mode). Length is the distance at rest, so the chain starts taut. */
  addChain(a: SimBody, aLocal: Vector3, b: SimBody, bLocal: Vector3, length: number) {
    const joint = this.world.createImpulseJoint(RAPIER.JointData.rope(length, aLocal, bLocal), a.rb, b.rb, true);
    joint.setContactsEnabled(true);
    this.ropes.push({ a, aLocal: aLocal.clone(), b, bLocal: bLocal.clone(), joint, kind: 'chain' });
  }

  /** Hang a body from a fixed world point. */
  addHang(b: SimBody, bLocal: Vector3, world: Vector3, length: number) {
    const fixed = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(world.x, world.y, world.z));
    const joint = this.world.createImpulseJoint(RAPIER.JointData.rope(length, { x: 0, y: 0, z: 0 }, bLocal), fixed, b.rb, true);
    this.ropes.push({ a: null, aLocal: world.clone(), b, bLocal: bLocal.clone(), joint, fixed, kind: 'hang' });
  }

  removeHangs() {
    for (let i = this.ropes.length - 1; i >= 0; i--) {
      const r = this.ropes[i];
      if (r.kind !== 'hang') continue;
      if (r.fixed) this.world.removeRigidBody(r.fixed);
      this.ropes.splice(i, 1);
    }
    for (const b of this.bodies) b.rb.wakeUp();
  }

  // --------------------------------------------------------------- params

  setParams(p: Params) {
    const prev = this.params;
    this.params = { ...p };
    if (prev.bounce !== p.bounce || prev.friction !== p.friction) {
      for (const b of this.bodies) {
        for (let i = 0; i < b.rb.numColliders(); i++) {
          const c = b.rb.collider(i);
          c.setRestitution(p.bounce);
          c.setFriction(p.friction);
        }
        b.rb.wakeUp();
      }
    }
    if (prev.floor !== p.floor) this.setRoom(this.room.w, this.room.h, this.room.d);
    if (prev.flat !== p.flat) for (const b of this.bodies) this.applyFlat(b);
    for (const b of this.bodies) b.rb.wakeUp();
  }

  /** Flat = constrained to the poster plane: x/y translation and z rotation only. */
  private applyFlat(b: SimBody) {
    const rb = b.rb;
    if (this.params.flat) {
      const t = rb.translation();
      const q = rb.rotation();
      const yaw = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
      tmpQ.setFromAxisAngle(tmpV.set(0, 0, 1), yaw);
      rb.setTranslation({ x: t.x, y: t.y, z: 0 }, true);
      rb.setRotation(tmpQ, true);
      const v = rb.linvel();
      rb.setLinvel({ x: v.x, y: v.y, z: 0 }, true);
      const w = rb.angvel();
      rb.setAngvel({ x: 0, y: 0, z: w.z }, true);
      rb.setEnabledTranslations(true, true, false, true);
      rb.setEnabledRotations(false, false, true, true);
    } else {
      rb.setEnabledTranslations(true, true, true, true);
      rb.setEnabledRotations(true, true, true, true);
    }
  }

  // -------------------------------------------------------------- actions

  explode(center = new Vector3(0, -this.room.h * 0.15, 0), strength = 1, radius = Infinity) {
    this.assemble(false);
    this.frozen = false;
    for (const b of this.bodies) {
      const t = b.rb.translation();
      tmpV.set(t.x - center.x, t.y - center.y, t.z - center.z);
      const dist = tmpV.length();
      if (dist > radius) continue;
      if (dist < 1e-3) tmpV.set(Math.random() - 0.5, 1, Math.random() - 0.5);
      tmpV.normalize();
      const falloff = radius === Infinity ? 0.65 + 0.35 * Math.exp(-dist / 4) : 1 - dist / radius;
      const dv = 16 * strength * falloff;
      const up = 5 * strength * falloff;
      b.rb.applyImpulse({ x: tmpV.x * dv * b.mass, y: (tmpV.y * dv + up) * b.mass, z: tmpV.z * dv * 0.6 * b.mass }, true);
      const spin = 9 * strength * falloff;
      b.rb.setAngvel(
        { x: this.params.flat ? 0 : (Math.random() - 0.5) * spin, y: this.params.flat ? 0 : (Math.random() - 0.5) * spin, z: (Math.random() - 0.5) * spin },
        true,
      );
    }
  }

  get assembling() {
    return this.bodies.some((b) => b.assembling);
  }

  /** Fly every body back to its typeset pose and hold it there (true), or let go (false). */
  assemble(on: boolean) {
    for (const b of this.bodies) this.setAssembling(b, on);
  }

  private setAssembling(b: SimBody, on: boolean) {
    if (b.assembling === on) return;
    b.assembling = on;
    b.rb.setGravityScale(on ? 0 : 1, true);
    for (let i = 0; i < b.rb.numColliders(); i++) b.rb.collider(i).setCollisionGroups(on ? GHOST : TOKEN);
    b.rb.wakeUp();
  }

  // ---------------------------------------------------------------- grabs

  pick(collider: Collider): SimBody | undefined {
    return this.byCollider.get(collider.handle);
  }

  beginGrab(id: number, body: SimBody, worldPoint: Vector3) {
    this.setAssembling(body, false);
    this.frozen = false;
    const t = body.rb.translation();
    const r = body.rb.rotation();
    tmpQ.set(r.x, r.y, r.z, r.w).invert();
    const local = worldPoint.clone().sub(tmpV.set(t.x, t.y, t.z)).applyQuaternion(tmpQ);
    this.grabs.set(id, { body, local, target: worldPoint.clone() });
    body.rb.setAngularDamping(3);
  }

  moveGrab(id: number, target: Vector3) {
    this.grabs.get(id)?.target.copy(target);
  }

  endGrab(id: number) {
    const g = this.grabs.get(id);
    if (!g) return;
    this.grabs.delete(id);
    if (![...this.grabs.values()].some((o) => o.body === g.body)) g.body.rb.setAngularDamping(0.25);
  }

  isGrabbed(body: SimBody) {
    for (const g of this.grabs.values()) if (g.body === body) return true;
    return false;
  }

  grabPoint(id: number, out: Vector3): Vector3 | null {
    const g = this.grabs.get(id);
    if (!g) return null;
    return this.localToWorld(g.body, g.local, out);
  }

  localToWorld(body: SimBody, local: Vector3, out: Vector3): Vector3 {
    const t = body.rb.translation();
    const r = body.rb.rotation();
    return out.copy(local).applyQuaternion(tmpQ2.set(r.x, r.y, r.z, r.w)).add(tmpV2.set(t.x, t.y, t.z));
  }

  // ----------------------------------------------------------------- step

  step(onImpact?: (i: Impact) => void) {
    if (this.frozen) return;
    const dt = this.dt;
    this.time += dt;
    const p = this.params;
    const g = GRAVITY * p.gravity;
    this.world.gravity = { x: this.down.x * g, y: this.down.y * g, z: this.params.flat ? 0 : this.down.z * g };

    for (const b of this.bodies) {
      const rb = b.rb;
      if (b.assembling) {
        this.steerHome(b);
        continue;
      }
      const t = rb.translation();
      if (p.wind !== 0) {
        // Gusts: slow, position-dependent swell so the wind reads as weather, not a constant push.
        const gust = 0.65 + 0.35 * Math.sin(this.time * 0.9 + t.y * 0.7) + 0.2 * Math.sin(this.time * 2.3 + t.x * 0.4);
        const a = p.wind * 26 * gust * dt * b.mass;
        rb.applyImpulse({ x: a, y: Math.abs(a) * 0.08, z: 0 }, true);
      }
      if (this.fanPoint && p.fan > 0) {
        tmpV.set(t.x - this.fanPoint.x, t.y - this.fanPoint.y, t.z - this.fanPoint.z);
        const dist = Math.max(0.35, tmpV.length());
        if (dist < this.fanRadius) {
          const a = p.fan * 120 * (1 - dist / this.fanRadius) * dt * b.mass;
          tmpV.divideScalar(dist);
          rb.applyImpulse({ x: tmpV.x * a, y: tmpV.y * a, z: tmpV.z * a }, true);
        }
      }
      this.contain(b, false);
    }

    for (const grab of this.grabs.values()) {
      const rb = grab.body.rb;
      const wp = this.localToWorld(grab.body, grab.local, tmpV);
      const desired = tmpV2.copy(grab.target).sub(wp).multiplyScalar(16);
      const max = 34;
      if (desired.lengthSq() > max * max) desired.setLength(max);
      const vp = rb.velocityAtPoint({ x: wp.x, y: wp.y, z: wp.z });
      const m = grab.body.mass * 0.45;
      // Also cancel this substep's gravity so a held letter doesn't sag below the finger.
      const gx = -this.world.gravity.x * dt * grab.body.mass;
      const gy = -this.world.gravity.y * dt * grab.body.mass;
      const gz = -this.world.gravity.z * dt * grab.body.mass;
      rb.applyImpulseAtPoint(
        { x: (desired.x - vp.x) * m + gx, y: (desired.y - vp.y) * m + gy, z: (desired.z - vp.z) * m + gz },
        { x: wp.x, y: wp.y, z: wp.z },
        true,
      );
    }

    this.world.step(this.queue);

    if (onImpact) {
      this.queue.drainContactForceEvents((e) => {
        const a = this.byCollider.get(e.collider1());
        const b = this.byCollider.get(e.collider2());
        const body = a ?? b;
        if (!body) return;
        const strength = Math.min(1, e.maxForceMagnitude() / (body.mass * GRAVITY * 60));
        onImpact({ body, strength });
      });
    } else {
      this.queue.clear();
    }
  }

  /** Velocity-level steering: robust regardless of mass, and never overshoots wildly. */
  private steerHome(b: SimBody) {
    const rb = b.rb;
    const t = rb.translation();
    const v = rb.linvel();
    tmpV.set(b.home.x - t.x, b.home.y - t.y, b.home.z - t.z).multiplyScalar(7);
    if (tmpV.lengthSq() > 30 * 30) tmpV.setLength(30);
    const k = 0.22;
    rb.setLinvel({ x: v.x + (tmpV.x - v.x) * k, y: v.y + (tmpV.y - v.y) * k, z: v.z + (tmpV.z - v.z) * k }, true);

    const r = rb.rotation();
    tmpQ.set(r.x, r.y, r.z, r.w).invert().premultiply(b.homeRot); // home * current⁻¹
    if (tmpQ.w < 0) tmpQ.set(-tmpQ.x, -tmpQ.y, -tmpQ.z, -tmpQ.w);
    const angle = 2 * Math.acos(Math.min(1, tmpQ.w));
    const s = Math.sqrt(Math.max(0, 1 - tmpQ.w * tmpQ.w));
    const w = rb.angvel();
    const target = s > 1e-4 ? tmpV2.set(tmpQ.x / s, tmpQ.y / s, tmpQ.z / s).multiplyScalar(angle * 7) : tmpV2.set(0, 0, 0);
    rb.setAngvel({ x: w.x + (target.x - w.x) * k, y: w.y + (target.y - w.y) * k, z: w.z + (target.z - w.z) * k }, true);
  }

  /**
   * Keep bodies in the room. With no floor, type that leaves through the bottom
   * (or the top, under negative gravity) re-enters from the opposite side at a
   * random distance off-screen, so a continuous rain never falls in lockstep.
   */
  private contain(b: SimBody, force: boolean) {
    const rb = b.rb;
    const t = rb.translation();
    const { w, h, d } = this.room;
    const margin = b.radius * 2 + 1.5;
    const below = t.y < -h / 2 - margin;
    const above = t.y > h / 2 + margin + (this.params.floor ? 0 : h);
    const escaped = Math.abs(t.x) > w / 2 + 3 || Math.abs(t.z) > d / 2 + 3;
    if (!below && !above && !escaped) {
      if (force) {
        const x = Math.max(-w / 2 + b.radius, Math.min(w / 2 - b.radius, t.x));
        const y = this.params.floor ? Math.max(-h / 2 + b.radius, Math.min(h / 2 - b.radius, t.y)) : t.y;
        if (x !== t.x || y !== t.y) rb.setTranslation({ x, y, z: t.z }, true);
      }
      return;
    }
    const x = (Math.random() - 0.5) * (w - b.radius * 2);
    const z = this.params.flat ? 0 : (Math.random() - 0.5) * Math.max(0, d - b.radius * 2);
    const fallingDown = this.world.gravity.y <= 0;
    const offscreen = b.radius + 0.5 + Math.random() * h * 0.6;
    const y = this.params.floor || escaped ? 0 : fallingDown ? h / 2 + offscreen : -h / 2 - offscreen;
    rb.setTranslation({ x, y, z }, true);
    rb.setLinvel({ x: 0, y: fallingDown ? -2 : 2, z: 0 }, true);
    if (!this.params.flat) rb.setAngvel({ x: Math.random() - 0.5, y: Math.random() - 0.5, z: Math.random() - 0.5 }, true);
  }

  dispose() {
    this.clear();
    this.queue.free();
    this.world.free();
  }
}
