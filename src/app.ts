// Orchestrates settings → type → bodies → pixels, and routes input/actions.

import { Group, Mesh, Plane, Raycaster, Vector2, Vector3, type Object3D } from 'three';
import { ImpactAudio } from './audio/impacts';
import { arSupported, buildGlb, buildSvg, buildUsdz, deliver, Recorder, renderPng, stamp } from './export/exporters';
import { Gestures } from './input/gestures';
import { requestTilt, TiltSensor, tiltSupported } from './input/tilt';
import { initPhysics, Sim } from './physics/sim';
import { glyphGeometry, evictFont, trimGeometryCache } from './render/geometry';
import { MaterialSet } from './render/materials';
import { pickQuality, Stage } from './render/stage';
import {
  changedKeys,
  decodeSettings,
  DEFAULTS,
  encodeSettings,
  luminance,
  MODES,
  mulberry32,
  PRESETS,
  REBUILD_KEYS,
  sanitize,
  type Settings,
} from './settings';
import type { Token, TokenGlyph } from './token';
import { FONTS, loadFont, parseFont, type LoadedFont } from './type/fonts';
import { fitSize, planTokens } from './type/layout';
import { UI } from './ui/ui';

const STORAGE_KEY = 'kinetic-type.v2';
const HOLD_MS = 850; // a beat to read the sentence before gravity takes it

export class App {
  settings: Settings;
  private readonly stage: Stage;
  private sim!: Sim;
  private font!: LoadedFont;
  private fontKey = '';
  private customFont: LoadedFont | null = null;
  private tokens: Token[] = [];
  private readonly meshToken = new WeakMap<Object3D, Token>();
  private mats: MaterialSet;
  private ui!: UI;
  private readonly audio = new ImpactAudio();
  private readonly recorder = new Recorder();
  private readonly tilt = new TiltSensor(() => this.explode());
  private tiltOn = false;
  private readonly raycaster = new Raycaster();
  private readonly grabPlanes = new Map<number, Plane>();
  private readonly ring = document.getElementById('ring')!;
  private readonly statsEl = document.getElementById('stats')!;
  private readonly hintEl = document.getElementById('hint')!;
  private rebuildTimer = 0;
  private saveTimer = 0;
  private holdUntil = 0;
  private last = performance.now();
  private acc = 0;
  private fps = 60;
  private lastStats = 0;
  private buildId = 0;
  private viewport = { w: 0, h: 0 };
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly tmpV = new Vector3();
  private readonly stringPoints: Vector3[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.settings = this.loadInitial();
    const params = new URLSearchParams(location.search);
    this.stage = new Stage(canvas, pickQuality(params.get('quality')));
    this.mats = new MaterialSet(this.settings.finish, this.settings.ink, this.settings.accent);
  }

  // ------------------------------------------------------------------ boot

  async start() {
    const physics = initPhysics();
    const firstFont = loadFont(FONTS.find((f) => f.id === this.settings.font) ?? FONTS[0]);
    await physics;
    this.sim = new Sim(this.stage.quality.dt);
    this.font = await firstFont;
    this.fontKey = this.settings.font === 'custom' ? 'inter' : this.settings.font;
    if (this.settings.font === 'custom') this.settings = { ...this.settings, font: 'inter' };

    this.ui = new UI(
      () => this.settings,
      (patch) => this.update(patch),
      this.actions(),
    );
    new Gestures(this.canvas, this.gestureHost());
    this.bindKeys();
    this.bindFontDrop();
    this.bindLifecycle();

    if (tiltSupported()) document.getElementById('tiltToggle')!.hidden = false;
    if (arSupported()) document.querySelectorAll<HTMLElement>('[data-action="ar"]').forEach((b) => (b.hidden = false));
    if (!Recorder.supported(this.canvas)) document.querySelectorAll<HTMLElement>('[data-record]').forEach((b) => (b.hidden = true));
    document.getElementById('tilt')!.addEventListener('change', (e) => this.setTilt((e.target as HTMLInputElement).checked));

    if (matchMedia('(max-width: 760px)').matches) document.body.classList.add('panel-hidden');
    this.syncPanelButton();
    this.applyLook();
    this.resize();
    this.sim.setParams(this.physicsParams());
    this.stage.setFloorVisible(this.settings.floor);
    this.rebuild();
    this.showHint();
    requestAnimationFrame(this.frame);
  }

  private loadInitial(): Settings {
    const hash = new URLSearchParams(location.hash.slice(1)).get('k');
    if (hash) {
      const s = decodeSettings(hash);
      if (s) return s;
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return sanitize(JSON.parse(raw));
    } catch {
      /* private mode, blocked storage */
    }
    return { ...DEFAULTS };
  }

  // -------------------------------------------------------------- settings

  update(patch: Partial<Settings>, opts: { immediate?: boolean } = {}) {
    const prev = this.settings;
    const next = sanitize({ ...prev, ...patch }, prev);
    const changed = changedKeys(prev, next);
    if (!changed.length) return;
    this.settings = next;

    if (changed.includes('font')) {
      void this.switchFont(next.font);
    } else if (changed.some((k) => REBUILD_KEYS.includes(k))) {
      clearTimeout(this.rebuildTimer);
      const delay = opts.immediate ? 0 : changed.includes('text') ? 220 : 40;
      this.rebuildTimer = window.setTimeout(() => this.rebuild(), delay);
    }
    if (changed.some((k) => k === 'finish' || k === 'ink' || k === 'accent')) this.rebuildMaterials();
    if (changed.includes('accentRatio') && !changed.includes('seed')) this.assignAccents();
    if (changed.some((k) => k === 'bg' || k === 'ink' || k === 'accent' || k === 'finish')) this.applyLook();
    if (changed.some((k) => ['gravity', 'wind', 'fan', 'bounce', 'friction', 'floor', 'flat'].includes(k))) {
      this.sim.setParams(this.physicsParams());
      if (changed.includes('flat')) this.resize(); // room depth differs
    }
    if (changed.includes('floor')) this.stage.setFloorVisible(next.floor);
    if (changed.includes('hang') && !changed.some((k) => REBUILD_KEYS.includes(k))) this.applyHangs();
    if (changed.includes('sound')) {
      this.audio.enabled = next.sound;
      if (next.sound) this.audio.unlock();
    }
    this.audio.finish = next.finish;
    this.persist();
  }

  private physicsParams() {
    const s = this.settings;
    return { gravity: s.gravity, wind: s.wind, fan: s.fan, bounce: s.bounce, friction: s.friction, floor: s.floor, flat: s.flat };
  }

  private persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
      } catch {
        /* ignore */
      }
      // Keep the address bar shareable without adding history entries.
      history.replaceState(null, '', `#k=${encodeSettings(this.settings)}`);
    }, 400);
  }

  private applyLook() {
    const s = this.settings;
    const dark = luminance(s.bg) < 0.2;
    document.body.dataset.theme = dark ? 'dark' : 'light';
    const root = document.documentElement.style;
    root.setProperty('--paper', s.bg);
    root.setProperty('--accent', s.accent);
    root.setProperty('--on-accent', luminance(s.accent) > 0.5 ? '#111111' : '#ffffff');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', s.bg);
    this.stage.setBackground(s.bg, dark);
    this.stage.setPrintFinish(s.finish === 'ink' || s.finish === 'clay');
    this.stage.setStringColor(s.ink);
  }

  private rebuildMaterials() {
    const old = this.mats;
    this.mats = new MaterialSet(this.settings.finish, this.settings.ink, this.settings.accent);
    this.assignAccents();
    old.dispose();
  }

  private assignAccents() {
    const rnd = mulberry32(this.settings.seed ^ 0x9e3779b9);
    for (const t of this.tokens) {
      t.accent = rnd() < this.settings.accentRatio;
      for (const g of t.glyphs) if (g.mesh) g.mesh.material = t.accent ? this.mats.accent : this.mats.ink;
    }
  }

  private async switchFont(id: Settings['font']) {
    const build = ++this.buildId;
    try {
      let font: LoadedFont;
      if (id === 'custom') {
        if (!this.customFont) throw new Error('No custom font loaded');
        font = this.customFont;
      } else {
        const entry = FONTS.find((f) => f.id === id)!;
        font = await loadFont(entry);
      }
      if (build !== this.buildId) return;
      this.font = font;
      this.fontKey = id === 'custom' ? `custom:${font.name}` : id;
      this.rebuild();
    } catch (e) {
      this.ui.toast(`Couldn’t load that font — ${(e as Error).message}`);
    }
  }

  async useFontFile(file: File) {
    if (/\.woff2$/i.test(file.name)) {
      this.ui.toast('WOFF2 isn’t supported yet — use TTF, OTF or WOFF');
      return;
    }
    try {
      const font = await parseFont(await file.arrayBuffer());
      if (this.customFont) evictFont(`custom:${this.customFont.name}`);
      this.customFont = font;
      const chip = document.getElementById('customFontChip')!;
      chip.hidden = false;
      chip.textContent = font.name;
      if (this.settings.font === 'custom') void this.switchFont('custom');
      else this.update({ font: 'custom' });
      this.ui.sync();
      this.ui.toast(`Set in ${font.name}`);
    } catch {
      this.ui.toast('That file doesn’t look like a font');
    }
  }

  // ----------------------------------------------------------------- build

  private roomDepth() {
    return this.settings.flat ? 3 : Math.max(3.2, this.settings.size * 3.4);
  }

  /** Screen space taken by the interface, so the room can avoid it. */
  private insets() {
    const body = document.body;
    if (body.classList.contains('hide-ui')) return { top: 0, right: 0, bottom: 0 };
    const phone = matchMedia('(max-width: 760px), (max-height: 520px) and (pointer: coarse)').matches;
    const panel = document.getElementById('panel')!;
    const bottomBar = document.querySelector<HTMLElement>('.bottom')!;
    const panelOpen = !body.classList.contains('panel-hidden');
    const right = !phone && panelOpen ? panel.offsetWidth + 24 : 0;
    // On phones the open sheet replaces the dock at the bottom of the screen.
    const bottom = phone && panelOpen ? panel.offsetHeight + 8 : Math.max(0, window.innerHeight - bottomBar.getBoundingClientRect().top + 4);
    const top = document.querySelector<HTMLElement>('.brand')!.getBoundingClientRect().bottom + 6;
    return { top, right, bottom };
  }

  /** Re-fit the room to the free screen area without resetting the type. */
  relayout() {
    this.stage.resize(window.innerWidth, window.innerHeight, this.roomDepth(), this.insets());
    this.sim.setRoom(this.stage.room.w, this.stage.room.h, this.stage.room.d);
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const prevW = this.stage.room.w;
    this.stage.resize(w, h, this.roomDepth(), this.insets());
    this.sim?.setRoom(this.stage.room.w, this.stage.room.h, this.stage.room.d);
    const orientationChanged = this.viewport.w > 0 && Math.abs(this.stage.room.w - prevW) / prevW > 0.15;
    this.viewport = { w, h };
    return orientationChanged;
  }

  rebuild() {
    const s = this.settings;
    this.sim.clear();
    this.stage.tokens.clear();
    this.tokens = [];

    const room = this.stage.room;
    const { size, set } = fitSize(s.text, this.font.metrics, s.size, room.w, room.h, s.tracking);
    const plans = planTokens(set, s.mode);
    const q = this.stage.quality;
    const ext = { depth: s.depth, bevel: s.bevel, curveSegments: q.curveSegments, bevelSegments: q.bevelSegments };
    const blockY = room.h * 0.06;
    const halfDepth = (s.depth / 2) * size;

    for (const plan of plans) {
      const glyphs = plan.glyphs.map((g) => ({ g, data: this.font.glyph(g.ch) }));
      // Ink bounds of the token, in em relative to the layout origin.
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const { g, data } of glyphs) {
        for (const b of data.boxes) {
          x0 = Math.min(x0, g.x + b.x0);
          x1 = Math.max(x1, g.x + b.x1);
          y0 = Math.min(y0, g.y + b.y0);
          y1 = Math.max(y1, g.y + b.y1);
        }
      }
      if (!Number.isFinite(x0)) continue;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;

      const boxes = glyphs.flatMap(({ g, data }) =>
        data.boxes.map((b) => ({
          cx: ((b.x0 + b.x1) / 2 + g.x - cx) * size,
          cy: ((b.y0 + b.y1) / 2 + g.y - cy) * size,
          hx: ((b.x1 - b.x0) / 2) * size,
          hy: ((b.y1 - b.y0) / 2) * size,
        })),
      );
      const home = new Vector3(cx * size, cy * size + blockY, 0);
      const body = this.sim.addBody({ boxes, halfDepth, home });

      const group = new Group();
      group.scale.setScalar(size);
      group.position.copy(home);
      const tglyphs: TokenGlyph[] = glyphs.map(({ g, data }) => {
        const geo = glyphGeometry(this.fontKey, data, ext);
        let mesh: Mesh | null = null;
        if (geo) {
          mesh = new Mesh(geo, this.mats.ink);
          mesh.position.set(g.x - cx, g.y - cy, 0);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          group.add(mesh);
        }
        return { data, ox: g.x - cx, oy: g.y - cy, mesh };
      });
      const token: Token = {
        group,
        body,
        glyphs: tglyphs,
        plan,
        accent: false,
        bounds: { x0: x0 - cx, y0: y0 - cy, x1: x1 - cx, y1: y1 - cy },
        size,
      };
      for (const g of tglyphs) if (g.mesh) this.meshToken.set(g.mesh, token);
      this.stage.tokens.add(group);
      this.tokens.push(token);
    }

    this.assignAccents();
    if (s.mode === 'chain') this.buildChains();
    this.applyHangs();

    // Hold the composition still for a beat so it can be read, then let go.
    this.sim.frozen = true;
    this.holdUntil = performance.now() + HOLD_MS;
    this.updateStats();
    this.canvas.setAttribute('aria-label', `3D kinetic type reading “${s.text}”, ${this.tokens.length} ${s.mode === 'words' ? 'words' : 'letters'}`);

    const suffix = `|${s.depth}|${s.bevel}|${q.curveSegments}|${q.bevelSegments}`;
    trimGeometryCache((k) => k.endsWith(suffix) || !k.startsWith(this.fontKey + '|'));
  }

  /** Top-left / top-right anchor points of a token in body-local world units. */
  private anchors(t: Token) {
    const inset = Math.min(0.06, (t.bounds.x1 - t.bounds.x0) * 0.2);
    return {
      left: new Vector3((t.bounds.x0 + inset) * t.size, t.bounds.y1 * t.size, 0),
      right: new Vector3((t.bounds.x1 - inset) * t.size, t.bounds.y1 * t.size, 0),
      top: new Vector3(0, t.bounds.y1 * t.size, 0),
    };
  }

  private buildChains() {
    for (let i = 0; i + 1 < this.tokens.length; i++) {
      const a = this.tokens[i];
      const b = this.tokens[i + 1];
      if (a.plan.line !== b.plan.line) continue;
      const aL = this.anchors(a).right;
      const bL = this.anchors(b).left;
      const length = aL.clone().add(a.body.home).distanceTo(bL.clone().add(b.body.home));
      this.sim.addChain(a.body, aL, b.body, bL, Math.max(0.02, length));
    }
  }

  private applyHangs() {
    this.sim.removeHangs();
    if (!this.settings.hang) return;
    const mode = this.settings.mode;
    const rnd = mulberry32(this.settings.seed + 17);
    if (mode === 'chain') {
      // Pin both ends of each line slightly inward so the string sags like bunting.
      const lines = new Map<number, Token[]>();
      for (const t of this.tokens) lines.set(t.plan.line, [...(lines.get(t.plan.line) ?? []), t]);
      for (const row of lines.values()) {
        const first = row[0];
        const last = row[row.length - 1];
        const span = last.body.home.x - first.body.home.x;
        const lift = first.size * 0.45;
        const la = this.anchors(first).left;
        const ra = this.anchors(last).right;
        const lw = la.clone().add(first.body.home).add(new Vector3(span * 0.025, lift, 0));
        const rw = ra.clone().add(last.body.home).add(new Vector3(-span * 0.025, lift, 0));
        this.sim.addHang(first.body, la, lw, lift);
        if (last !== first) this.sim.addHang(last.body, ra, rw, lift);
      }
      return;
    }
    for (const t of this.tokens) {
      if (mode === 'letters' && !t.plan.wordStart) continue;
      const a = this.anchors(t).top;
      const len = t.size * (0.5 + rnd() * 0.5);
      const w = a.clone().add(t.body.home).add(new Vector3((rnd() - 0.5) * 0.2 * t.size, len, 0));
      this.sim.addHang(t.body, a, w, len);
    }
  }

  // ------------------------------------------------------------------ loop

  private readonly frame = (now: number) => {
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.fps += (1 / Math.max(1e-3, dt) - this.fps) * 0.05;

    if (this.sim.frozen && now > this.holdUntil) this.sim.frozen = false;
    this.updateGravity();

    this.acc += dt;
    const step = this.sim.dt;
    let n = 0;
    while (this.acc >= step && n < 6) {
      this.sim.step(this.audio.enabled ? (i) => this.audio.hit(i.strength, i.body.radius) : undefined);
      this.acc -= step;
      n++;
    }
    if (n === 6) this.acc = 0;

    for (const t of this.tokens) {
      const p = t.body.rb.translation();
      const r = t.body.rb.rotation();
      t.group.position.set(p.x, p.y, p.z);
      t.group.quaternion.set(r.x, r.y, r.z, r.w);
    }
    this.updateStrings();
    this.stage.render(dt);

    if (this.recorder.recording) this.updateRecordLabel();
    if (now - this.lastStats > 500) {
      this.lastStats = now;
      this.updateStats();
    }
  };

  private updateGravity() {
    const g = this.tiltOn ? this.tilt.gravity : null;
    if (!g) {
      this.sim.down.set(0, -1, 0);
      return;
    }
    // Screen-space gravity → world, through the camera's current orientation.
    const q = this.stage.camera.quaternion;
    const right = new Vector3(1, 0, 0).applyQuaternion(q);
    const up = new Vector3(0, 1, 0).applyQuaternion(q);
    const back = new Vector3(0, 0, 1).applyQuaternion(q);
    this.sim.down.copy(right.multiplyScalar(g.x)).add(up.multiplyScalar(g.y)).add(back.multiplyScalar(g.z)).normalize();
    for (const b of this.sim.bodies) if (b.rb.isSleeping()) b.rb.wakeUp();
  }

  private updateStrings() {
    const pts = this.stringPoints;
    let i = 0;
    const put = (v: Vector3) => {
      if (!pts[i]) pts[i] = new Vector3();
      pts[i++].copy(v);
    };
    for (const r of this.sim.ropes) {
      if (r.a) put(this.sim.localToWorld(r.a, r.aLocal, this.tmpV));
      else put(r.aLocal);
      put(this.sim.localToWorld(r.b, r.bLocal, this.tmpV));
    }
    pts.length = i;
    this.stage.setStrings(pts);
  }

  private updateStats() {
    const s = this.settings;
    const fps = Math.round(this.fps);
    this.statsEl.textContent = `${this.tokens.length} bodies · ${s.mode} · ${this.font?.name ?? ''} · ${fps} fps`;
  }

  // ----------------------------------------------------------------- input

  private ndcRay(ndc: Vector2) {
    this.raycaster.setFromCamera(ndc, this.stage.camera);
    return this.raycaster.ray;
  }

  private viewPlanePoint(ndc: Vector2, through = new Vector3()): Vector3 | null {
    const n = this.stage.camera.getWorldDirection(new Vector3()).negate();
    const plane = new Plane().setFromNormalAndCoplanarPoint(n, through);
    return this.ndcRay(ndc).intersectPlane(plane, new Vector3());
  }

  private pickToken(ndc: Vector2) {
    this.raycaster.setFromCamera(ndc, this.stage.camera);
    const hit = this.raycaster.intersectObjects(this.stage.tokens.children, true)[0];
    if (!hit) return null;
    const token = this.meshToken.get(hit.object);
    return token ? { token, point: hit.point } : null;
  }

  private gestureHost() {
    return {
      grab: (id: number, ndc: Vector2) => {
        const hit = this.pickToken(ndc);
        if (!hit) return false;
        const n = this.stage.camera.getWorldDirection(new Vector3()).negate();
        this.grabPlanes.set(id, new Plane().setFromNormalAndCoplanarPoint(n, hit.point));
        this.sim.beginGrab(id, hit.token.body, hit.point);
        this.syncAssemble();
        return true;
      },
      moveGrab: (id: number, ndc: Vector2) => {
        const plane = this.grabPlanes.get(id);
        if (!plane) return;
        const p = this.ndcRay(ndc).intersectPlane(plane, new Vector3());
        if (p) this.sim.moveGrab(id, p);
      },
      endGrab: (id: number) => {
        this.grabPlanes.delete(id);
        this.sim.endGrab(id);
      },
      fan: (ndc: Vector2 | null, client?: { x: number; y: number }) => {
        if (!ndc || this.settings.fan <= 0) {
          this.sim.fanPoint = null;
          this.ring.classList.remove('on');
          return;
        }
        this.sim.frozen = false;
        this.sim.fanPoint = this.viewPlanePoint(ndc);
        if (client) {
          this.ring.style.left = `${client.x}px`;
          this.ring.style.top = `${client.y}px`;
          this.ring.classList.remove('shock');
          this.ring.classList.add('on');
        }
      },
      shockwave: (ndc: Vector2, client: { x: number; y: number }) => {
        const p = this.viewPlanePoint(ndc);
        if (!p) return;
        this.sim.explode(p, 0.9, 7);
        this.syncAssemble();
        this.ring.style.left = `${client.x}px`;
        this.ring.style.top = `${client.y}px`;
        this.ring.classList.remove('on', 'shock');
        void this.ring.offsetWidth; // restart the animation
        this.ring.classList.add('shock');
      },
      orbit: (dx: number, dy: number) => this.stage.rig.orbit(-dx * 0.006, -dy * 0.006),
      zoom: (f: number) => this.stage.rig.zoom(f),
      hover: (ndc: Vector2) => !!this.pickToken(ndc),
      interacted: () => {
        this.hideHint();
        if (this.settings.sound) this.audio.unlock();
      },
    };
  }

  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('textarea, input, select, dialog[open]') || e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      const act = this.actions();
      if (k === ' ') {
        e.preventDefault();
        act.explode();
      } else if (k === 'a') act.assemble();
      else if (k === 'r') act.rebuild();
      else if (k === 'c') act.camera();
      else if (k === 'h') act.hide();
      else if (k === 'f') this.update({ flat: !this.settings.flat });
      else if (k === 'm') this.update({ mode: MODES[(MODES.indexOf(this.settings.mode) + 1) % MODES.length] });
      else if (k === 'p') act.png();
      else if (k === 'v') act.record();
      else if (k === '?' || k === '/') act.help();
      else if (k === 'escape') this.closeMenu();
      else if (/^[1-9]$/.test(k) && PRESETS[Number(k) - 1]) this.applyPreset(PRESETS[Number(k) - 1].id);
      else return;
      this.ui.sync();
      this.hideHint();
    });
  }

  private bindFontDrop() {
    const overlay = document.getElementById('drop')!;
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      depth++;
      overlay.classList.add('on');
    });
    window.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        overlay.classList.remove('on');
      }
    });
    window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      overlay.classList.remove('on');
      const file = e.dataTransfer?.files[0];
      if (file) void this.useFontFile(file);
    });
    document.getElementById('fontFile')!.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (file) void this.useFontFile(file);
      input.value = '';
    });
  }

  private bindLifecycle() {
    let t = 0;
    const onResize = () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        if (this.resize()) this.rebuild();
      }, 120);
    };
    window.addEventListener('resize', onResize);
    screen.orientation?.addEventListener?.('change', onResize);
    document.addEventListener('visibilitychange', () => {
      this.last = performance.now();
      this.acc = 0;
    });
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ui.toast('Graphics were reset — reloading…', 4000);
      setTimeout(() => location.reload(), 1200);
    });
    document.addEventListener('pointerdown', (e) => {
      const menu = document.getElementById('exportMenu')!;
      if (!menu.hidden && !(e.target as HTMLElement).closest('#exportMenu, #exportBtn')) this.closeMenu();
    });
  }

  // --------------------------------------------------------------- actions

  private explode() {
    this.sim.explode(undefined, this.reducedMotion ? 0.55 : 1);
    this.syncAssemble();
    if (this.settings.sound) this.audio.unlock();
  }

  private applyPreset(id: string) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    this.update(p.patch, { immediate: true });
    this.stage.rig.reset();
    this.ui.sync();
    this.ui.toast(`${p.label} — ${p.hint}`);
  }

  private syncAssemble() {
    const on = this.sim.assembling;
    document.getElementById('assembleBtn')!.setAttribute('aria-pressed', String(on));
    const label = document.querySelector('#assembleBtn span');
    if (label) label.textContent = on ? 'Release' : 'Assemble';
  }

  private syncPanelButton() {
    const open = !document.body.classList.contains('panel-hidden');
    document.getElementById('tuneBtn')!.setAttribute('aria-expanded', String(open));
  }

  private closeMenu() {
    document.getElementById('exportMenu')!.hidden = true;
    document.getElementById('exportBtn')!.setAttribute('aria-expanded', 'false');
  }

  private async setTilt(on: boolean) {
    const input = document.getElementById('tilt') as HTMLInputElement;
    if (on) {
      const res = await requestTilt();
      if (res !== 'granted') {
        input.checked = false;
        this.ui.toast(res === 'denied' ? 'Motion access was declined — enable it in Settings › Safari' : 'Tilt isn’t available here');
        return;
      }
      this.tilt.start();
      this.tiltOn = true;
      this.sim.frozen = false;
      this.ui.toast('Tilt on — gravity follows your phone. Shake to explode.');
    } else {
      this.tilt.stop();
      this.tiltOn = false;
    }
  }

  private async exportAction(kind: 'png' | 'pngAlpha' | 'svg' | 'glb' | 'ar') {
    this.closeMenu();
    const base = `kinetic-type-${stamp()}`;
    try {
      if (kind === 'png' || kind === 'pngAlpha') {
        const blob = await renderPng(this.stage, 2, kind === 'pngAlpha');
        const r = await deliver(blob, `${base}.png`);
        if (r !== 'cancelled') this.ui.toast(r === 'shared' ? 'Shared' : 'PNG saved');
      } else if (kind === 'svg') {
        this.updateStrings();
        const svg = buildSvg(
          this.tokens,
          this.stage.camera,
          window.innerWidth,
          window.innerHeight,
          { bg: this.settings.bg, ink: this.settings.ink, accent: this.settings.accent },
          this.settings.depth,
          this.settings.mode === 'chain' || this.settings.hang ? this.stringPoints : [],
          this.settings.text,
        );
        await deliver(new Blob([svg], { type: 'image/svg+xml' }), `${base}.svg`);
        this.ui.toast('SVG saved — every glyph is an outline');
      } else if (kind === 'glb') {
        this.ui.toast('Building 3D file…');
        await deliver(await buildGlb(this.tokens), `${base}.glb`);
        this.ui.toast('GLB saved');
      } else if (kind === 'ar') {
        this.ui.toast('Preparing AR…', 6000);
        const blob = await buildUsdz(this.tokens);
        this.offerAr(blob);
      }
    } catch (e) {
      this.ui.toast(`Export failed — ${(e as Error).message}`, 4000);
    }
  }

  /** AR Quick Look needs a real tap on an <a rel="ar">, so hand one over. */
  private offerAr(blob: Blob) {
    const menu = document.getElementById('exportMenu')!;
    menu.querySelector('.ar-link')?.remove();
    const a = document.createElement('a');
    a.rel = 'ar';
    a.href = URL.createObjectURL(blob);
    a.className = 'ar-link';
    a.setAttribute('role', 'menuitem');
    a.innerHTML = '<button type="button" tabindex="-1">Open in AR <small>tap</small></button><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
    menu.prepend(a);
    menu.hidden = false;
    this.ui.toast('Ready — tap “Open in AR”', 4000);
  }

  private async toggleRecord() {
    const btns = document.querySelectorAll<HTMLElement>('[data-record]');
    if (this.recorder.recording) {
      const { blob, ext } = await this.recorder.stop();
      this.stage.holdResolution = false;
      btns.forEach((b) => {
        b.classList.remove('rec');
        const s = b.querySelector('span');
        if (s) s.textContent = 'Rec';
        else b.textContent = 'Record';
      });
      if (!blob.size) {
        this.ui.toast('This browser recorded an empty video — try Safari or Chrome');
        return;
      }
      const r = await deliver(blob, `kinetic-type-${stamp()}.${ext}`);
      if (r !== 'cancelled') this.ui.toast(`Video saved (${ext.toUpperCase()})`);
      return;
    }
    try {
      this.stage.holdResolution = true;
      this.recorder.start(this.canvas);
      btns.forEach((b) => b.classList.add('rec'));
      this.ui.toast('Recording — press again to stop');
    } catch (e) {
      this.stage.holdResolution = false;
      this.ui.toast(`Recording isn’t available — ${(e as Error).message}`);
    }
  }

  private updateRecordLabel() {
    const t = this.recorder.elapsed;
    if (t > 60) {
      void this.toggleRecord();
      return;
    }
    const label = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    document.querySelectorAll<HTMLElement>('[data-record]').forEach((b) => {
      const s = b.querySelector('span');
      if (s) s.textContent = label;
      else b.textContent = `Stop ${label}`;
    });
  }

  private actions(): Record<string, (el?: HTMLElement) => void> {
    const presetActions = Object.fromEntries(PRESETS.map((p) => [`preset:${p.id}`, () => this.applyPreset(p.id)]));
    return {
      ...presetActions,
      explode: () => this.explode(),
      assemble: () => {
        this.sim.frozen = false;
        this.sim.assemble(!this.sim.assembling);
        this.syncAssemble();
      },
      rebuild: () => {
        this.rebuild();
        this.syncAssemble();
      },
      shuffle: () => {
        this.update({ seed: (Math.random() * 2 ** 31) | 0 }, { immediate: true });
      },
      camera: () => this.stage.rig.reset(),
      help: () => {
        this.closeMenu();
        (document.getElementById('help') as HTMLDialogElement).showModal();
      },
      hide: () => {
        document.body.classList.toggle('hide-ui');
        if (document.body.classList.contains('hide-ui')) this.closeMenu();
        this.relayout();
      },
      tune: () => {
        document.body.classList.toggle('panel-hidden');
        this.syncPanelButton();
        this.relayout();
      },
      exportMenu: (el) => {
        const menu = document.getElementById('exportMenu')!;
        if (!menu.hidden) return this.closeMenu();
        menu.hidden = false;
        const r = el!.getBoundingClientRect();
        const mw = menu.offsetWidth;
        const mh = menu.offsetHeight;
        menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.left + r.width / 2 - mw / 2))}px`;
        menu.style.top = `${Math.max(8, r.top - mh - 10)}px`;
        el!.setAttribute('aria-expanded', 'true');
        menu.querySelector<HTMLElement>('button:not([hidden])')?.focus();
      },
      png: () => void this.exportAction('png'),
      pngAlpha: () => void this.exportAction('pngAlpha'),
      svg: () => void this.exportAction('svg'),
      glb: () => void this.exportAction('glb'),
      ar: () => void this.exportAction('ar'),
      record: () => void this.toggleRecord(),
      link: async () => {
        this.closeMenu();
        const url = `${location.origin}${location.pathname}#k=${encodeSettings(this.settings)}`;
        try {
          if (matchMedia('(pointer: coarse)').matches && navigator.share) await navigator.share({ url, title: 'Kinetic Type' });
          else {
            await navigator.clipboard.writeText(url);
            this.ui.toast('Link copied — it recreates this composition');
          }
        } catch {
          /* dismissed */
        }
      },
    };
  }

  // ------------------------------------------------------------------ hint

  private hintTimer = 0;
  private showHint() {
    const touch = matchMedia('(pointer: coarse)').matches;
    this.hintEl.textContent = touch
      ? 'Drag letters · hold to blow · double-tap to burst · two fingers to orbit'
      : 'Drag letters · hold to blow · double-click to burst · right-drag to orbit · Space explodes · A reassembles';
    this.hintTimer = window.setTimeout(() => this.hideHint(), 9000);
  }

  private hideHint() {
    clearTimeout(this.hintTimer);
    this.hintEl.classList.add('gone');
  }
}
