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

The bundle defaults to `origin/main` without changing the checkout. Set `YOGURT_APP_REF` to another local commit when needed. There are no archived-source overrides. Its manifest records the app commit, source overrides, source files and output hashes. `SITE_URL` changes the local origin used by the still exporter; `CHROME_BIN` changes its browser executable. The exporter uses headless Chrome directly, not Electron or Playwright.

`timeline.mjs` owns the 39-second hero sequence. `bridge.mjs` provides the in-memory app bridge and drives the editor and cursor. Native capabilities are disabled and updates stay idle in the browser-only fixture. `fragments.tsx` renders the three How it works surfaces. The walkthrough mounts the selected scene when it enters view. Summary uses the app’s SummaryWaiting and editor, and Ask uses AskConversation. Reduced motion uses themed stills from those same components. Rebundle and export the stills together when the app changes. `frame.css` styles only the isolated frames. Page layout stays in `public/marketing/site.css`.

The Vite-only `renderer` directory is excluded from Next's typecheck: its `@app` imports are resolved from the archived app source by `bundle.mjs`.

## Project activity

The site build reads the repository count, dated stargazers and published stable releases from the GitHub API. The Site workflow passes its read token to this build step. Dated stars are deduplicated by account and grouped by hour. Only times and counts are stored. The release bars use the last seven UTC dates including the build date.

The build writes a validated snapshot to `.next/cache/activity.json` before generating the static homepage. If an API request fails, the build can reuse the most recent cached snapshot or the checked-in `content/activity.json`. If only dated stars are unavailable, the chart keeps its dated series while the totals and releases refresh. After load, the browser checks GitHub for stars and the latest published stable release, caching successful or failed checks for an hour. A complete release list also updates the total. At 100 releases the browser uses the latest-release endpoint and the build supplies the total. The chart and weekday bars use the build snapshot. The browser calculates the release age locally. To refresh the checked-in fallback, run `pnpm --dir site site:stars` with the GitHub CLI signed in.
