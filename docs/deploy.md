# Deploying MemeLabV3

Single source of truth for how this project ships. GitHub Pages is already configured — this is the operational reference, not a setup guide.

- **Repo:** `TheMemeticist/MemeLabV3`, branch `main`
- **Live site:** https://thememeticist.github.io/MemeLabV3/
- **Trigger:** every push to `main`

## How it works

Pages is set to **Source: GitHub Actions** (Settings → Pages). The only deploy workflow is `.github/workflows/deploy.yml`. It runs `npm ci` → `typecheck` → `test` → `npm run build` with `VITE_BASE: /MemeLabV3/`, then uploads `dist/` as the Pages artifact. A run takes under two minutes.

`dist/` is gitignored and rebuilt by the workflow. Never commit it.

## Ship

Commit identity, the required overrides, and the push flow are in the **`memelab-git` skill** — use it rather than raw git. In short:

```bash
cd app
git status --short                    # confirm no node_modules/ or dist/ staged
npm run typecheck && npm run test     # the workflow will run these anyway; fail fast locally
# commit via the memelab-git skill, then:
git push origin main
gh run watch -R TheMemeticist/MemeLabV3 --exit-status
```

## Verify a deploy actually landed

A green workflow run is not proof the site is right — check what's actually served:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://thememeticist.github.io/MemeLabV3/
```

Then confirm the served `index.html` references `/MemeLabV3/assets/index-*.js` — **not** `/src/main.ts`. Source paths in the served HTML mean an unbuilt tree got uploaded.

To reproduce the production build locally:

```bash
VITE_BASE=/MemeLabV3/ npm run build && npm run preview
```

## Failure modes, in order of likelihood

**Assets 404 and the page is blank.** `VITE_BASE` doesn't match the repo name. For a project page it must be `/MemeLabV3/` — both slashes matter. For a user/org page (`<username>.github.io`) it would be `/`.

**Never re-add `static.yml`.** A second workflow by that name — the GitHub template with `path: '.'` — once broke the site. It uploaded the raw unbuilt repo root as the Pages artifact and raced `deploy.yml` on the shared `concurrency: group: pages`. The served `index.html` then pointed at `/src/main.ts` and 404'd into a blank page. If you ever see two Pages workflows, delete `static.yml`. Only `deploy.yml` deploys.

**typecheck or test fails in CI.** The workflow gates on both, so a red run means the code is broken, not the deploy. Fix and push; the workflow reruns itself.

**Push succeeded, site unchanged.** Check the Actions tab for a queued or skipped run, and confirm Settings → Pages still reads *Source: GitHub Actions*.
