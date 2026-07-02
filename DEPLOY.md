# Deploying Kinetic Type to GitHub Pages

## 1. Create a GitHub repo

Suggested repo name:

```text
kinetic-type
```

## 2. Push from Terminal

From inside this folder:

```bash
git init
git add .
git commit -m "Add Kinetic Type physics typography app"
git branch -M main
gh repo create kinetic-type --public --source=. --remote=origin --push
```

If the repo already exists:

```bash
git remote add origin https://github.com/YOUR_USERNAME/kinetic-type.git
git push -u origin main
```

## 3. Enable GitHub Pages

In GitHub:

1. Open the repo
2. Go to **Settings**
3. Go to **Pages**
4. Source: **Deploy from a branch**
5. Branch: **main**
6. Folder: **/ root**
7. Save

Your URL will look like:

```text
https://YOUR_USERNAME.github.io/kinetic-type/
```

## 4. Embed in Squarespace

Use a Code Block with this iframe:

```html
<div class="portfolio-tool-frame">
  <iframe
    src="https://YOUR_USERNAME.github.io/kinetic-type/"
    title="Kinetic Type"
    loading="eager"
    allow="fullscreen"
  ></iframe>
</div>

<style>
  .portfolio-tool-frame {
    width: 100vw;
    height: 100vh;
    margin-left: calc(50% - 50vw);
    overflow: hidden;
    background: #f6f4ef;
  }

  .portfolio-tool-frame iframe {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
  }
</style>
```
