#!/usr/bin/env node
// daily.mjs — the whole freshness pipeline, one entry point for cron.
//
// The app is public, so nothing user-facing may trigger server work: no refresh
// button, no on-demand sync. Freshness is this script's job.
//
//   1. pull the Assemblée's open data (ETag-cached — a no-op when unchanged)
//   2. map dossiers to the documents they produced (so a new bill is fetchable)
//   3. read any bill not yet read, and cache what it sets up
//   4. generate the SVG for any ballot that appeared since last run
//
// Exits non-zero on failure so cron mail and the watchdog surface it, and logs
// a one-line summary either way.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fssync from 'node:fs';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function step(name, script, args = [], timeout = 900_000) {
  const t0 = Date.now();
  try {
    const { stdout } = await execFileP(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      cwd: ROOT,
    });
    const last = stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
    log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(0)}s) ${last}`);
    return true;
  } catch (e) {
    log(`✗ ${name} — ${String(e.message).slice(0, 200)}`);
    return false;
  }
}

log('— pipeline quotidienne —');

// The data pull must succeed before anything downstream is worth running: with
// a stale index, pregeneration would just re-confirm what is already on disk.
const refreshed = await step('open data', 'refresh-data.mjs');
if (!refreshed) {
  log('✗ arrêt : sans données à jour, la suite n’aurait rien de neuf à produire');
  process.exit(1);
}

// The dossier → document map has to be rebuilt before the texts are read: a
// ballot on a brand-new bill has no entry yet, and without one the bill is
// simply invisible to the next step.
const okTextes = await step('index des textes', 'build-textes-index.mjs');
// Deputy pages are rebuilt from the two raw archives; runs BEFORE the sitemap
// so /depute/* URLs announce today's roster, not yesterday's.
const okDeputes = await step('députés', 'build-deputes.mjs');
// The sitemap is what tells crawlers a new page exists; a silent failure means
// fresh ballots never get indexed. Surface it like any other site-facing step.
const okSitemap = await step('sitemap', 'build-sitemap.mjs');

// Share of recorded votes cast by a delegate. Measured, never assumed: it is
// what stops the page from calling a participation rate a presence rate.
const okDeleg = await step('délégations', 'build-delegations.mjs');

// Read the bills. Idempotent and keyed by document, so the steady-state cost is
// the one or two new texts of the day, not the 73 of the year. Deliberately NOT
// fatal: a page without its "texte en clair" is still a correct page, whereas
// stopping here would also block the SVGs.
await step('textes de loi', 'build-consequences.mjs', ['--concurrency', '2'], 1_800_000);

// Skips every ballot whose SVG already exists, so the steady-state cost is the
// handful published that day.
const generated = await step('svg', 'pregenerate.mjs', ['--concurrency', '3']);

// Every step that produces something the site reads must be able to fail the
// run. Reporting "✓ pipeline ok" while the text index and the delegation counts
// silently failed is worse than no report: it is a green light for stale data.
// Reading the bills is the deliberate exception — a page without its "texte en
// clair" is still a correct page.
const ok = okTextes && okDeputes && okSitemap && okDeleg && generated;
// The site's own share image: the latest ballot's card, copied to a stable
// path. Crawlers cache og:image aggressively and need a URL that does not move,
// but a preview showing a vote from six months ago is worse than none.
//
// Written to storage/, not dist/ — `vite build` empties dist/, so anything the
// pipeline puts there vanishes at the next front-end change. nginx serves it
// from storage/ under the same public URL.
try {
  const { getScrutin, loadIndex } = await import('../server/data/index.mjs');
  const { payloadHash } = await import('../server/data/cardhash.mjs');
  const ix = await loadIndex();
  const last = [...(ix.docs ?? [])].sort((a, b) => b.numero - a.numero)[0];
  const s2 = last && getScrutin(last.numero);
  if (s2) {
    // pregenerate writes the SVG only (rasters are made on demand by the
    // server), so on a run that published a new ballot there is no -share.png
    // to copy yet: the home og:image would lag until a visitor happened to
    // fetch that card's PNG. Rasterise the latest ballot here so the stable
    // share image always reflects the newest vote in the current design.
    const PY = process.env.SCRUTIN_PY || '/home/ubuntu/.venvs/hemicycle/bin/python';
    const RENDERER = path.join(ROOT, 'render', 'render_card.py');
    const hash = payloadHash(s2);
    const dir = path.join(ROOT, 'storage', 'cards', String(s2.legislature), String(s2.numero), hash);
    fssync.mkdirSync(dir, { recursive: true });
    const payloadFile = path.join(dir, 'payload.json');
    fssync.writeFileSync(payloadFile, JSON.stringify(s2));
    // No --svg-only: this pass must emit the rasters. Content-hash caching makes
    // it a near no-op when the ballot and template are unchanged.
    await execFileP(PY, [RENDERER, '--in', payloadFile, '--outdir', dir], {
      timeout: 120_000, maxBuffer: 8 * 1024 * 1024, cwd: ROOT,
    });
    fssync.rmSync(payloadFile, { force: true });
    const found = fssync.readdirSync(dir).find((f) => f.endsWith('-share.png'));
    if (found) {
      fssync.copyFileSync(path.join(dir, found), path.join(ROOT, 'storage', 'share.png'));
      log(`✓ image de partage ← scrutin n°${s2.numero}`);
    } else {
      log('✗ image de partage — aucun -share.png après rendu');
    }
  }
} catch (e) {
  log('✗ image de partage —', String(e.message).slice(0, 100));
}

log(ok ? '✓ pipeline ok' : '✗ pipeline incomplète');
process.exit(ok ? 0 : 1);
