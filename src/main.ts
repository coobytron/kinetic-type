import './styles.css';
import { App } from './app';

function fatal(message: string) {
  document.getElementById('fatalMsg')!.textContent = message;
  document.getElementById('fatal')!.hidden = false;
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

if (!webglAvailable()) {
  fatal('WebGL 2 is turned off or unsupported on this device.');
} else {
  const app = new App(document.getElementById('stage') as HTMLCanvasElement);
  app.start().catch((e: unknown) => {
    console.error(e);
    fatal(`Something went wrong while starting: ${(e as Error).message ?? e}`);
  });
  // Handy for poking at the scene from the console.
  (window as unknown as { kinetic: App }).kinetic = app;
}
