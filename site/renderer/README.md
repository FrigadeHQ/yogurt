# Marketing demo source

These fixtures drive the app's real renderer in an isolated browser frame. They do not open a microphone, read local data or call native APIs. The website deploys the checked-in bundle and stills; its `build` command does not rebuild the app.

From the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir site install --frozen-lockfile --ignore-workspace
pnpm --dir site site:bundle
pnpm --dir site dev --hostname 127.0.0.1 --port 43933
# In another terminal, with the site running:
pnpm --dir site site:stills
pnpm --dir site test
pnpm --dir site build
```

The bundle defaults to `origin/main` without changing the checkout. Set `YOGURT_APP_REF` to another local commit when needed. The approved wordmark change from `bd3d73d` and ring change from `1e1c0d0` are applied to the archived source. Its manifest records the app commit, source overrides, source files and output hashes. `SITE_URL` changes the local origin used by the still exporter; `CHROME_BIN` changes its browser executable. The exporter uses headless Chrome directly, not Electron or Playwright.

`timeline.mjs` owns the 39-second hero sequence. `bridge.mjs` provides the in-memory app bridge and drives the editor and cursor. `fragments.tsx` renders the three How it works surfaces. Desktop fragments animate; phone and reduced-motion layouts use the completed exports. `frame.css` styles only the isolated frames. Page layout stays in `public/marketing/site.css`.

The Vite-only `renderer` directory is excluded from Next's typecheck: its `@app` imports are resolved from the archived app source by `bundle.mjs`.
