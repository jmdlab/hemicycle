# Hemicycle

> One French National Assembly vote → one 16:9 image ready to paste into a social post, plus a short neutral text; a public product at hemicycle.app, no account, no auth.

**Status:** live · **Last verified:** 2026-09-21

This file is the entry point for any AI model or engineer taking over this project.
It is written to be publishable: no secrets, no internal topology, no personal data.
Anything marked `<LIKE_THIS>` is a deployment-specific value; it is not part of this
repository. `README.md` (French) is the product and front-end reference;
this file is the operational entry point.

## What it does
- One text field accepts a vote number, a bill reference, or a plain-language subject.
- The API resolves it to candidate votes; a single confident match renders directly,
  otherwise the user picks one.
- The render produces an SVG card (canonical), a 4K PNG master, a share-size PNG and a
  preview, a short neutral post text, and the official source link (kept outside the text).
- Every card passes an arithmetic QA against the source figures; on failure **nothing**
  copyable is shown.
- Public pages per vote (SEO, Open Graph image), a "latest votes" feed, suggestions, and a
  plain-language "what the text changes" section built from the bill itself.

## Stack
Front: Vite + React + strict TypeScript + Tailwind, design tokens from one stylesheet. Server:
Node ESM, Express. Render layer: Python (cairosvg + Pillow) in a virtualenv, called as a
subprocess. Data: the Assembly's open-data archives. Optional LLM pass through a headless
CLI wrapper that is external to this repository (`SCRUTIN_CLAUDE_CLI`), guarded by a
deterministic neutrality validator. systemd unit with hardening drop-ins.

## The state machine
`src/App.tsx` holds a single `Phase` union (`src/lib/types.ts`), no router:

```
idle → resolving ─┬─ one candidate, score ≥ 0.85 ──► rendering ─► done
                  ├─ several / low score ─► choosing ─► rendering ─► done
                  └─ none ─► empty
any step ─► qaFailed (HTTP 422)  |  error (retryable or not)
```
Deep links `?n=<number>` and `?q=<query>` are read on mount and written back with
`history.replaceState`. Every request is aborted after 120 s. The number/reference path
must stay a **single action**: never add a confirmation screen for a confident match.

## Directory map
| Path | Role |
|---|---|
| `src/` | SPA; component-by-component table in `README.md` |
| `server/index.mjs` | Express app; the public API surface |
| `server/data/` | Index loading, search, normalisation, QA, card hash, store (has its own README) |
| `server/{tweet,neutrality,plain,explain,summarize,consequence,texte,loi}.mjs` | Text generation and its validators |
| `server/{seo,depute,remuneration}.mjs` | Public pages, member data, reference figures |
| `render/` | Python card renderer, rasteriser, overflow check, fonts, theme |
| `scripts/daily.mjs` | The whole freshness pipeline, single cron entry point |
| `scripts/backfill-consequences.mjs` | Catch-up reader for bills missing their "what changes" section |
| `scripts/{refresh-data,build-*,pregenerate}.mjs` | Pipeline steps called by `daily.mjs` |
| `scripts/prune-rasters.mjs` | Raster cache pruning |
| `scripts/setup-venv.sh`, `scripts/fonts.sh` | One-time render environment setup |
| `deploy.sh`, `deploy/` | Deploy script; unit, hardening drop-ins, proxy snippets |
| `storage/` | All runtime data (see Data and state) |

## Run locally
```bash
npm install && (cd server && npm install)
bash scripts/setup-venv.sh          # system cairo/pango libs + Python venv
node scripts/daily.mjs              # first run: downloads open data, builds every index
(cd server && npm start)            # API on <PORT_HEMICYCLE>
npm run dev                         # Vite, proxies the API and storage prefixes
```
Everything runs without secrets: the LLM pass is off unless `SCRUTIN_LLM=on`.

## Build
`npm run build` (= `tsc && vite build`). TypeScript is strict with `noUnusedLocals`,
`noUnusedParameters`, `noUncheckedIndexedAccess`; the build must pass with zero errors.
`dist/` is gitignored here.

## Deploy
`./deploy.sh`: install (front, server) → build → restart `hemicycle.service` → test and
reload the proxy → request the health route locally. Verify with
`GET /api/hemicycle/health`. Roll back: check out the previous commit, run the script again.
A fresh deployment must run `scripts/daily.mjs` once, because derived indexes are not in git.

## Configuration
| Variable | Purpose | Required by | If missing |
|---|---|---|---|
| `PORT` | Listen port | `server/index.mjs` | built-in default |
| `SCRUTIN_SITE` | Public base URL for canonical links and sitemap | `server/seo.mjs`, sitemap script | the public domain |
| `SCRUTIN_SINCE` | Start date of the daily window | `scripts/build-consequences.mjs`, daily | 1 January of the current year |
| `SCRUTIN_PY` | Python interpreter of the render venv | `server/index.mjs`, `scripts/daily.mjs` | built-in absolute venv path |
| `SCRUTIN_LLM` | `on` enables the optional model pass | `server/index.mjs`, `server/tweet.mjs` | deterministic text only |
| `SCRUTIN_CLAUDE_CLI` | Path of the headless LLM CLI wrapper | text modules | built-in absolute path |

See `server/.env.example`.

## Data and state
- `storage/raw/` — raw open-data archives. **The only non-derivable input.** They can be
  re-downloaded only while the upstream site stays up, and they contain members' contact
  details, so they are never committed.
- `storage/index/`, `storage/deputes/`, `storage/share.png`, `storage/sitemap.xml` —
  derived, rebuilt every night, gitignored on purpose (a checkout would otherwise revert
  them to a stale version and trip the freshness probe).
- `storage/cards/` — SVG is canonical and never pruned; PNG/WebP are derivatives.
- Per-document caches of the "what changes" text are the backfill's state: a cached
  reference is skipped, a failure is logged and retried in the next batch.

## Scheduled jobs
| Job | Schedule (UTC) | Script | Lock | Log |
|---|---|---|---|---|
| Daily freshness pipeline | `25 6 * * *` | `scripts/daily.mjs` | shared lock, **waiting** (`flock -w`) | `logs/daily.log` |
| Backfill | `40 1-23/2 * * *` | `scripts/backfill-consequences.mjs`, run under a memory/time limiter | same lock, **non-blocking** (`flock -n`): yields to the daily | `logs/backfill-consequences.log` |
| Raster pruning | `40 4 * * 0` | `scripts/prune-rasters.mjs` | none | `logs/prune.log` |
| Raw-source cold backup | monthly | deployment-specific; not part of this repository | — | — |

- The daily runs, in order: open data → bill index → members → sitemap → delegations →
  bill reading (concurrency 2) → SVG pre-generation (concurrency 3).
- The backfill sweeps the **whole** index, not just the daily window, concurrency 1,
  bounded batch (`--limit`, default 25). It is a safety net, not a permanent workload.
- The shared lock exists so the two jobs never read bills at the same time.
- Pruning deletes rasters not served for `--days` (default 30) and caps the cache at
  `--max-mb` (default 500); a pruned raster is rebuilt from its SVG on the next request.
- The monthly backup keeps a few compressed copies of `storage/raw/` only — deliberately
  not the regenerable rest.

## Health checks
`GET /api/hemicycle/health`. For freshness, monitor the generated-at stamp of
`storage/index/meta.json`: it must move every day. External monitoring is
deployment-specific; not part of this repository.

## Things a new model gets wrong
The three known traps from the README:
1. **Safari clipboard.** `ClipboardItem` must receive a *promise* of a blob. Awaiting the
   `fetch()` before constructing it makes iOS drop the blob and paste nothing. See
   `src/lib/clipboard.ts`.
2. **`credentials: "same-origin"`** on the image fetch is kept on purpose even though the
   site is public and has no auth. Do not "simplify" it away.
3. **Three image sizes, three uses.** Display `preview` (1280×720), copy `pngShare`
   (2048×1152, under the social network's size cap and clipboard-safe on iOS), download
   only the 4K master. Swapping them breaks paste or wastes bandwidth.

And four operational ones:
4. **Committing derived indexes.** See Data and state — it breaks live freshness.
5. **Putting the source link in the post text.** House convention: the text goes alone,
   the source goes as a reply; the DOM keeps them in separate blocks with separate copy buttons.
6. **Showing a card when QA fails.** A card built on unverified arithmetic is a fake.
   No image, no text, no download; explain expected vs obtained and link the source.
7. **Leaving `SCRUTIN_LLM=on` from a dev shell.** The deterministic path is the default in
   production; model output must always pass `server/neutrality.mjs`.

## Known gaps
- Long-running pipeline steps are bounded by per-step timeouts.
- **A clone does not build on its own yet**: `src/index.css` imports its design-token stylesheet from a path outside this repository, and two defaults (`SCRUTIN_PY`, `SCRUTIN_CLAUDE_CLI`) are machine-specific absolute paths. Vendor the stylesheet and make both settings mandatory before publishing a release.
- `README.md` covers the two routes a front-end needs; the rest are documented in code.
- An untracked `pnpm-lock.yaml` sits beside the tracked `package-lock.json`; `deploy.sh` uses npm.
- The raw backup and its schedule live outside this repository, so a clone alone does not
  reveal them.
- No automated tests; correctness rests on the runtime QA and `render/check_overflow.py`.

## How to update this file
Hand-written. Route count: `grep -cE "^app\.(get|post)" server/index.mjs`. Schedules are
those of the reference deployment. Correct facts here rather than in a side document.
