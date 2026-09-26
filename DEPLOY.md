# Deploying Kinetic Type

## GitHub Pages

1. In the repo: **Settings → Pages → Source: GitHub Actions**.
2. Push to `main`. The workflow in `.github/workflows/static.yml` installs, tests, builds and publishes `dist/`.

The site will be at `https://<user>.github.io/kinetic-type/`. The build uses relative paths, so it works from a project sub-path or an iframe.

## Embed in Squarespace (or any site)

Use a Code Block. The `allow` list matters: `accelerometer` and `gyroscope` let **Tilt** work inside the iframe on iPhone, `xr-spatial-tracking` covers AR, and `clipboard-write` lets **Copy link** work.

```html
<div class="kinetic-type-frame">
  <iframe
    src="https://<user>.github.io/kinetic-type/"
    title="Kinetic Type — 3D physics typography"
    loading="eager"
    allow="fullscreen; accelerometer; gyroscope; xr-spatial-tracking; clipboard-write; web-share"
  ></iframe>
</div>

<style>
  .kinetic-type-frame {
    width: 100vw;
    height: 100vh;
    height: 100dvh;
    margin-left: calc(50% - 50vw);
    overflow: hidden;
    background: #f6f4ef;
  }
  .kinetic-type-frame iframe { width: 100%; height: 100%; border: 0; display: block; }
</style>
```

Deep links work in the `src` too: open the app, set up a composition, use **Copy link**, and paste that URL as the iframe `src` to embed that exact piece.
