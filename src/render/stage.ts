// Renderer, camera rig, lights and the "paper" the type sits on.
//
// The default view is a long-lens, dead-on camera so the composition first
// reads as a flat poster; orbiting reveals that every letter is a solid object.
// The floor and back wall are shadow catchers over a flat background colour, so
// the scene keeps the look of ink on paper while casting real soft shadows.

import {
  ACESFilmicToneMapping,
  BackSide,
  BoxGeometry,
  MeshBasicMaterial,
  SphereGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  NeutralToneMapping,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';

/**
 * A photographer's studio for reflections: a dim gradient cyclorama with a big
 * overhead softbox, two strip lights and a warm bounce card. High contrast is
 * what makes chrome read as chrome and gives enamel a crisp highlight line.
 */
function studioEnvironment(): Scene {
  const env = new Scene();
  const sphere = new SphereGeometry(50, 32, 16);
  const colors: number[] = [];
  const pos = sphere.getAttribute('position');
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / 50; // -1 (floor) … 1 (ceiling)
    c.setRGB(0.03, 0.03, 0.035).lerp(new Color(0.55, 0.56, 0.6), Math.max(0, (t + 0.25) / 1.25) ** 1.6);
    colors.push(c.r, c.g, c.b);
  }
  sphere.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  env.add(new Mesh(sphere, new MeshBasicMaterial({ vertexColors: true, side: BackSide })));
  const panel = (w: number, h: number, intensity: number, color: number, x: number, y: number, z: number, ry = 0, rx = 0) => {
    const m = new Mesh(new BoxGeometry(w, h, 0.2), new MeshBasicMaterial({ color: new Color(color).multiplyScalar(intensity) }));
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    env.add(m);
  };
  panel(24, 16, 3.2, 0xffffff, 0, 30, 6, 0, Math.PI / 2); // overhead softbox
  panel(5, 36, 2.6, 0xffffff, -26, 4, 10, Math.PI / 2.6); // key strip
  panel(4, 30, 1.8, 0xdfe8ff, 26, 2, -6, -Math.PI / 2.4); // cool rim strip
  panel(30, 8, 0.7, 0xf4f1ec, 0, -6, 34); // soft bounce behind camera
  return env;
}

export interface Quality {
  name: 'high' | 'low';
  maxDpr: number;
  minDpr: number;
  shadowMap: number;
  curveSegments: number;
  bevelSegments: number;
  antialias: boolean;
  /** Physics substep in seconds. */
  dt: number;
}

export const QUALITY: Record<Quality['name'], Quality> = {
  high: { name: 'high', maxDpr: 2, minDpr: 1, shadowMap: 2048, curveSegments: 7, bevelSegments: 2, antialias: true, dt: 1 / 120 },
  low: { name: 'low', maxDpr: 2, minDpr: 0.75, shadowMap: 1024, curveSegments: 5, bevelSegments: 1, antialias: true, dt: 1 / 60 },
};

export function pickQuality(requested: string | null): Quality {
  if (requested === 'high' || requested === 'low') return QUALITY[requested];
  const nav = navigator as Navigator & { deviceMemory?: number };
  const coarse = matchMedia('(pointer: coarse)').matches;
  const weak = (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) || (navigator.hardwareConcurrency ?? 8) <= 4;
  return coarse || weak ? QUALITY.low : QUALITY.high;
}

const FOV = 30;

/** Spherical orbit around the room centre with critically damped easing. */
export class CameraRig {
  theta = 0;
  phi = Math.PI / 2;
  radius = 20;
  private goal = { theta: 0, phi: Math.PI / 2, radius: 20 };
  home = 20;

  constructor(readonly camera: PerspectiveCamera) {}

  setHome(radius: number, snap = false) {
    const ratio = this.goal.radius / this.home;
    this.home = radius;
    this.goal.radius = radius * ratio;
    if (snap) this.radius = this.goal.radius;
  }

  orbit(dTheta: number, dPhi: number) {
    this.goal.theta = Math.max(-2.6, Math.min(2.6, this.goal.theta + dTheta));
    this.goal.phi = Math.max(0.18, Math.min(Math.PI * 0.62, this.goal.phi + dPhi));
  }

  zoom(factor: number) {
    this.goal.radius = Math.max(this.home * 0.35, Math.min(this.home * 2.6, this.goal.radius * factor));
  }

  reset() {
    this.goal = { theta: 0, phi: Math.PI / 2, radius: this.home };
  }

  get atHome() {
    return Math.abs(this.goal.theta) < 1e-3 && Math.abs(this.goal.phi - Math.PI / 2) < 1e-3 && Math.abs(this.goal.radius - this.home) < 1e-3;
  }

  update(dt: number) {
    const k = 1 - Math.exp(-dt * 9);
    this.theta += (this.goal.theta - this.theta) * k;
    this.phi += (this.goal.phi - this.phi) * k;
    this.radius += (this.goal.radius - this.radius) * k;
    const s = Math.sin(this.phi);
    this.camera.position.set(this.radius * s * Math.sin(this.theta), this.radius * Math.cos(this.phi), this.radius * s * Math.cos(this.theta));
    this.camera.lookAt(0, 0, 0);
  }
}

export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(FOV, 1, 0.5, 200);
  readonly rig = new CameraRig(this.camera);
  readonly tokens = new Group();
  readonly strings: LineSegments;
  readonly room = { w: 16, h: 10, d: 4 };
  private readonly key: DirectionalLight;
  private readonly fill: DirectionalLight;
  private dark = false;
  private print = true;
  private readonly hemi: HemisphereLight;
  private readonly floor: Mesh<PlaneGeometry, ShadowMaterial>;
  private readonly bg = new Color();
  private stringCapacity = 0;
  private sized = false;
  private dpr = 1;
  private frameTimes: number[] = [];
  /** Pause dynamic resolution (a canvas that changes size mid-recording breaks MediaRecorder). */
  holdResolution = false;
  private lastAdapt = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly quality: Quality,
  ) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: quality.antialias,
      alpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    // Neutral tone mapping keeps brand colours (the accent orange) true to their hex.
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.dpr = Math.min(window.devicePixelRatio || 1, quality.maxDpr);
    this.renderer.setPixelRatio(this.dpr);

    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(studioEnvironment(), 0.02).texture;
    this.scene.environmentIntensity = 1;
    pmrem.dispose();

    this.hemi = new HemisphereLight(0xffffff, 0xd8d2c8, 0.4);
    this.scene.add(this.hemi);

    this.key = new DirectionalLight(0xffffff, 1.7);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
    this.key.shadow.bias = -0.0008;
    this.key.shadow.normalBias = 0.045;
    this.key.shadow.radius = 4;
    this.scene.add(this.key, this.key.target);

    // Shadowless fill from the camera side, so faces toward the viewer read at their true colour.
    this.fill = new DirectionalLight(0xffffff, 0.9);
    this.fill.position.set(0, 2, 20);
    this.scene.add(this.fill);

    this.floor = new Mesh(new PlaneGeometry(1, 1), new ShadowMaterial({ opacity: 0.22, transparent: true }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor, this.tokens);

    const lineGeo = new BufferGeometry();
    this.strings = new LineSegments(lineGeo, new LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.75 }));
    this.strings.frustumCulled = false;
    this.scene.add(this.strings);
  }

  /**
   * The room fills the part of the screen the interface doesn't cover, so type
   * never lands under the panel or the dock. The canvas still spans the whole
   * window; a view offset slides the projection into the free rectangle.
   * Room size: ~10 units tall on landscape, ~7 wide on portrait.
   */
  resize(width: number, height: number, depth: number, insets = { top: 0, right: 0, bottom: 0 }) {
    const fw = Math.max(1, width - insets.right);
    const fh = Math.max(1, height - insets.top - insets.bottom);
    const aspect = fw / fh;
    const h = aspect >= 1 ? 10 : Math.min(20, 7 / aspect);
    const w = h * aspect;
    Object.assign(this.room, { w, h, d: depth });

    this.renderer.setSize(width, height, false);
    this.camera.aspect = aspect;
    this.camera.setViewOffset(fw, fh, 0, -insets.top, width, height);
    this.camera.updateProjectionMatrix();
    const tan = Math.tan(((FOV / 2) * Math.PI) / 180);
    // Frame the z = 0 plane plus a margin so letters resting at the front aren't clipped.
    const radius = ((h / 2) * 1.08) / tan + depth / 2;
    this.rig.setHome(radius, !this.sized);
    this.sized = true;

    this.floor.scale.set(w * 6, 80, 1);
    this.floor.position.set(0, -h / 2, 0);

    const sc = this.key.shadow.camera;
    const span = Math.max(w, h) * 0.75 + 2;
    Object.assign(sc, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 80 });
    sc.updateProjectionMatrix();
    this.key.position.set(-w * 0.18, h * 1.5, 9);
    this.key.target.position.set(0, -h * 0.3, 0);
  }

  setBackground(hex: string, dark: boolean) {
    this.bg.set(hex);
    this.scene.background = this.bg;
    // On dark paper, shadows read better lighter and the hemisphere dimmer.
    this.floor.material.opacity = dark ? 0.45 : 0.22;
    this.hemi.intensity = dark ? 0.35 : 0.4;
    this.dark = dark;
    this.applyToneMapping();
  }

  /**
   * Print finishes (ink, clay) render untone-mapped so a flat, front-facing
   * letter shows its exact hex; glossy finishes get highlight roll-off instead.
   */
  setPrintFinish(print: boolean) {
    this.print = print;
    this.applyToneMapping();
  }

  private applyToneMapping() {
    this.renderer.toneMapping = this.dark ? ACESFilmicToneMapping : this.print ? NoToneMapping : NeutralToneMapping;
  }

  setFloorVisible(v: boolean) {
    this.floor.visible = v;
  }

  setStringColor(hex: string) {
    (this.strings.material as LineBasicMaterial).color.set(hex);
  }

  /** Write rope segments (pairs of points). */
  setStrings(points: Vector3[]) {
    const geo = this.strings.geometry;
    if (points.length > this.stringCapacity) {
      this.stringCapacity = Math.max(64, points.length * 2);
      geo.setAttribute('position', new BufferAttribute(new Float32Array(this.stringCapacity * 3), 3));
    }
    const attr = geo.getAttribute('position') as BufferAttribute | undefined;
    if (!attr) return;
    points.forEach((p, i) => attr.setXYZ(i, p.x, p.y, p.z));
    attr.needsUpdate = true;
    geo.setDrawRange(0, points.length);
    this.strings.visible = points.length > 0;
  }

  render(dt: number) {
    this.rig.update(dt);
    this.renderer.render(this.scene, this.camera);
    this.adapt(dt);
  }

  /** Dynamic resolution: step the pixel ratio down under load, back up when there's headroom. */
  private adapt(dt: number) {
    if (this.holdResolution) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 45) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes.length = 0;
    const now = performance.now();
    if (now - this.lastAdapt < 1500) return;
    const max = Math.min(window.devicePixelRatio || 1, this.quality.maxDpr);
    let next = this.dpr;
    if (avg > 1 / 45 && this.dpr > this.quality.minDpr) next = Math.max(this.quality.minDpr, this.dpr - 0.25);
    else if (avg < 1 / 75 && this.dpr < max) next = Math.min(max, this.dpr + 0.25);
    if (next !== this.dpr) {
      this.dpr = next;
      this.lastAdapt = now;
      const size = this.renderer.getSize(new Vector2());
      this.renderer.setPixelRatio(next);
      this.renderer.setSize(size.x, size.y, false);
    }
  }

  get pixelRatio() {
    return this.dpr;
  }
}
