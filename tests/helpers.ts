import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LoadedFont, parseFont } from '../src/type/fonts';

export function loadTestFont(pkgPath: string): Promise<LoadedFont> {
  const file = fileURLToPath(new URL(`../node_modules/@fontsource/${pkgPath}`, import.meta.url));
  const buf = readFileSync(file);
  return parseFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}
