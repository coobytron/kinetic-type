import { Color, MeshPhysicalMaterial } from 'three';
import type { Finish } from '../settings';

/** Physically based finishes. Each token uses the ink or the accent variant. */
export function makeMaterial(finish: Finish, hex: string): MeshPhysicalMaterial {
  const color = new Color(hex);
  const m = new MeshPhysicalMaterial({ color });
  switch (finish) {
    case 'ink':
      // Printed ink: matte and deep; low specular so blacks stay black and the accent stays on-hex.
      Object.assign(m, { roughness: 0.7, metalness: 0, envMapIntensity: 0.35, specularIntensity: 0.15 });
      break;
    case 'enamel':
      Object.assign(m, { roughness: 0.4, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 0.9 });
      break;
    case 'chrome':
      Object.assign(m, { roughness: 0.08, metalness: 1, envMapIntensity: 1.6 });
      break;
    case 'glass':
      Object.assign(m, {
        roughness: 0.04,
        metalness: 0,
        transmission: 1,
        thickness: 0.35,
        ior: 1.5,
        envMapIntensity: 1.1,
        attenuationColor: color.clone(),
        attenuationDistance: 0.6,
        specularIntensity: 1,
      });
      m.color.lerp(new Color(1, 1, 1), 0.6);
      break;
    case 'clay':
      Object.assign(m, { roughness: 0.92, metalness: 0, sheen: 0.3, sheenRoughness: 0.8, sheenColor: color.clone().lerp(new Color(1, 1, 1), 0.5), envMapIntensity: 0.4 });
      break;
  }
  return m;
}

export class MaterialSet {
  ink: MeshPhysicalMaterial;
  accent: MeshPhysicalMaterial;
  constructor(
    public finish: Finish,
    inkHex: string,
    accentHex: string,
  ) {
    this.ink = makeMaterial(finish, inkHex);
    this.accent = makeMaterial(finish, accentHex);
  }

  dispose() {
    this.ink.dispose();
    this.accent.dispose();
  }
}
