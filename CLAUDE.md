# Kinetic Type — notes for agents

3D physics typography web app. Vite + TypeScript + three.js + Rapier (WASM) + opentype.js. Static site deployed to GitHub Pages. The 2024 original lives untouched at `public/v1/index.html`.

## Commands

- `npm run dev` — dev server
- `npm test` — vitest (pure modules only: outline, gpos kerning, layout, settings, tilt)
- `npm run build` — `tsc --noEmit` + `vite build`; run before every push
- `npm run preview` — serve `dist/`

## Map

- `src/app.ts` orchestrates: `update(patch)` diffs `Settings`, then rebuilds type (keys in `REBUILD_KEYS`) or applies live changes (materials, physics params, hangs, look).
- `src/settings.ts` — single serialisable `Settings`; always pass external input through `sanitize()`. Presets are patches. Share links = base64url JSON of non-default values.
- `src/type/` — fonts → glyph outlines (`outline.ts`), kerning (`gpos.ts`), typesetting (`layout.ts`). Everything is in em; the app scales to world units.
- `src/physics/sim.ts` — Rapier wrapper. Bodies are compounds of cuboids from `rasterizeBoxes`. Forces are impulses per fixed substep.
- `src/render/stage.ts` — renderer, `CameraRig`, studio env, shadows, dynamic resolution, `resize(w, h, depth, insets)`.
- `index.html` holds the UI markup; `src/ui/ui.ts` binds `data-setting`, `data-choice`, `data-action` attributes.

## Conventions

- Keep modules that can be pure, pure, and test them.
- New controls: add markup with the data attributes; add the key to `Settings`, `DEFAULTS`, `RANGES` (if numeric) and `sanitize`.
- Colours: ink/clay render with `NoToneMapping` so hex is exact; don't reintroduce a global tone mapper for them.
- Touch: 44 px targets, `touch-action` set per element, inputs ≥16 px font on phones, safe-area insets.
- Verify visually: build, `vite preview`, and screenshot with Playwright (Chromium is preinstalled; use SwiftShader flags `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`). `window.kinetic` exposes the app instance for scripted checks.
