# Galaxy Code landing page

`index.html` is the public landing page. The interactive app preview in `demo/index.html`
uses the actual React components and styles from `src/renderer/src`, with sample
projects and an in-memory implementation of the Electron API in `source/demo.tsx`.
No credentials or local project data are used. Agent responses and terminal commands are demonstrations; UI controls use the
same components as the desktop app. New browser tabs start blank and load entered
HTTP(S) addresses in an iframe. Websites that disallow embedding through CSP or
X-Frame-Options cannot be displayed by a static GitHub Pages site.

## Rebuild the preview

From the repository root, with its npm dependencies installed:

```sh
npx vite build --config docs/source/vite.config.ts
```

The output is written only to `docs/demo/`. Commit `docs/` including the built
bundle, CSS, and worker assets. The repository currently ignores this directory,
so add it explicitly with `git add -f docs` when publishing.

## GitHub Pages

Set the repository's Pages source to **Deploy from a branch**, branch `main`,
folder `/docs`. All runtime URLs are relative, so the site works under
`https://galaxysj.github.io/galaxy-code/` without a server or build workflow.
`demo/index.html` uses a classic script so the main preview also opens from `file://`;
Monaco editor workers require HTTP(S), as on GitHub Pages.

For local HTTP preview:

```sh
python3 -m http.server 8765 --directory docs
```
