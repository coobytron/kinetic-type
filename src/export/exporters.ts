// Everything that leaves the app: images, vectors, 3D, AR, video, links.

import { Box3, Group, Matrix4, Mesh, Vector3, type Camera, type Scene } from 'three';
import type { Stage } from '../render/stage';
import type { Token } from '../token';

export function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const touch = () => matchMedia('(pointer: coarse)').matches;

/**
 * Hand a file to the user. On phones this opens the share sheet (Save Image,
 * AirDrop, Messages…); on desktop it downloads.
 */
export async function deliver(blob: Blob, filename: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([blob], filename, { type: blob.type });
  if (touch() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Kinetic Type' });
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return 'downloaded';
}

/** Render at a higher resolution than the screen and read it back. */
export async function renderPng(stage: Stage, scale = 2, transparent = false): Promise<Blob> {
  const r = stage.renderer;
  const prevRatio = r.getPixelRatio();
  const w = r.domElement.clientWidth || window.innerWidth;
  const h = r.domElement.clientHeight || window.innerHeight;
  const maxEdge = Math.min(8192, r.capabilities.maxTextureSize);
  const ratio = Math.min((window.devicePixelRatio || 1) * scale, maxEdge / Math.max(w, h));
  const bg = stage.scene.background;
  try {
    r.setPixelRatio(ratio);
    r.setSize(w, h, false);
    if (transparent) {
      stage.scene.background = null;
      r.setClearColor(0x000000, 0);
    }
    r.render(stage.scene, stage.camera);
    return await new Promise<Blob>((res, rej) => r.domElement.toBlob((b) => (b ? res(b) : rej(new Error('Canvas export failed'))), 'image/png'));
  } finally {
    stage.scene.background = bg;
    r.setPixelRatio(prevRatio);
    r.setSize(w, h, false);
    r.render(stage.scene, stage.camera);
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/**
 * True vector export: each glyph's front face is projected through the live
 * camera, so the SVG matches the screen and every letter is an editable path
 * (not a <text> element that depends on installed fonts).
 */
export function buildSvg(
  tokens: Token[],
  camera: Camera,
  width: number,
  height: number,
  colors: { bg: string; ink: string; accent: string },
  depth: number,
  strings: Vector3[],
  text: string,
): string {
  const v = new Vector3();
  const camPos = new Vector3();
  camera.getWorldPosition(camPos);
  const order = tokens
    .map((t) => ({ t, d: t.group.getWorldPosition(new Vector3()).distanceTo(camPos) }))
    .sort((a, b) => b.d - a.d);
  const px = (p: Vector3) => {
    v.copy(p).project(camera);
    return `${(((v.x + 1) / 2) * width).toFixed(2)} ${(((1 - v.y) / 2) * height).toFixed(2)}`;
  };
  const paths: string[] = [];
  const front = new Vector3();
  for (const { t } of order) {
    const fill = t.accent ? colors.accent : colors.ink;
    const d: string[] = [];
    for (const g of t.glyphs) {
      if (!g.mesh) continue;
      g.mesh.updateWorldMatrix(true, false);
      const m: Matrix4 = g.mesh.matrixWorld;
      for (const c of g.data.contours) {
        const pts = c.points.map((p) => px(front.set(p.x, p.y, depth / 2).applyMatrix4(m)));
        d.push(`M${pts.join('L')}Z`);
      }
    }
    if (d.length) paths.push(`<path fill="${fill}" d="${d.join('')}"/>`);
  }
  const lines: string[] = [];
  for (let i = 0; i + 1 < strings.length; i += 2) lines.push(`M${px(strings[i])}L${px(strings[i + 1])}`);
  const rope = lines.length ? `\n  <path fill="none" stroke="${colors.ink}" stroke-width="1" stroke-opacity="0.75" d="${lines.join('')}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <title>${esc(text)}</title>
  <desc>Kinetic Type — glyph outlines projected from the 3D scene.</desc>
  <rect width="100%" height="100%" fill="${colors.bg}"/>${rope}
  ${paths.join('\n  ')}
</svg>`;
}

/** A detached copy of the type, scaled to a real-world size and sitting on y = 0. */
function exportGroup(tokens: Token[], targetWidth: number): Group {
  const root = new Group();
  root.name = 'KineticType';
  const inner = new Group();
  for (const t of tokens) {
    t.group.updateWorldMatrix(true, true);
    const g = t.group.clone(true);
    g.name = t.glyphs.map((x) => x.data.ch).join('');
    t.group.matrixWorld.decompose(g.position, g.quaternion, g.scale);
    inner.add(g);
  }
  const box = new Box3().setFromObject(inner);
  const size = box.getSize(new Vector3());
  const s = targetWidth / Math.max(1e-3, size.x);
  inner.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  root.scale.setScalar(s);
  root.add(inner);
  root.updateWorldMatrix(true, true);
  return root;
}

export async function buildGlb(tokens: Token[]): Promise<Blob> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const group = exportGroup(tokens, 1.2);
  const data = await new GLTFExporter().parseAsync(group, { binary: true });
  return new Blob([data as ArrayBuffer], { type: 'model/gltf-binary' });
}

/** AR Quick Look: Safari on iPhone/iPad (iPadOS reports itself as a Mac with touch). */
export function arSupported(): boolean {
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return apple && document.createElement('a').relList.supports('ar');
}

export async function buildUsdz(tokens: Token[]): Promise<Blob> {
  const { USDZExporter } = await import('three/examples/jsm/exporters/USDZExporter.js');
  // Desk scale: the composition comes out about 60 cm wide.
  const group = exportGroup(tokens, 0.6);
  group.traverse((o) => {
    if ((o as Mesh).isMesh) (o as Mesh).castShadow = true;
  });
  const data = await new USDZExporter().parseAsync(group as unknown as Scene);
  return new Blob([data as BlobPart], { type: 'model/vnd.usdz+zip' });
}

/** Canvas → video. Safari records MP4, Chromium/Firefox WebM. */
export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private started = 0;
  mime = '';

  static supported(canvas: HTMLCanvasElement) {
    return typeof MediaRecorder !== 'undefined' && typeof canvas.captureStream === 'function';
  }

  get recording() {
    return this.rec?.state === 'recording';
  }

  get elapsed() {
    return this.recording ? (performance.now() - this.started) / 1000 : 0;
  }

  start(canvas: HTMLCanvasElement) {
    // MP4 on Apple devices (it saves straight to Photos); WebM elsewhere, where
    // some Chromium builds claim MP4 support without shipping an H.264 encoder.
    const apple = /iPhone|iPad|Macintosh/.test(navigator.userAgent) && /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent);
    const mp4 = ['video/mp4;codecs=avc1', 'video/mp4'];
    const webm = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const types = apple ? [...mp4, ...webm] : [...webm, ...mp4];
    this.mime = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    const stream = canvas.captureStream(60);
    const pixels = canvas.width * canvas.height;
    this.rec = new MediaRecorder(stream, {
      mimeType: this.mime || undefined,
      videoBitsPerSecond: Math.min(24e6, Math.max(6e6, pixels * 6)),
    });
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
    this.started = performance.now();
  }

  stop(): Promise<{ blob: Blob; ext: string }> {
    return new Promise((resolve) => {
      const rec = this.rec!;
      rec.onstop = () => {
        const type = (rec.mimeType || this.mime || 'video/webm').split(';')[0];
        resolve({ blob: new Blob(this.chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' });
        rec.stream.getTracks().forEach((t) => t.stop());
        this.rec = null;
      };
      rec.stop();
    });
  }
}

