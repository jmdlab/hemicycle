#!/usr/bin/env node
/**
 * Rebuild storage/ from the Assemblée nationale bulk open data.
 *
 * Idempotent and safe to re-run: downloads are skipped when the remote
 * ETag/Last-Modified is unchanged, normalized records are rewritten in place,
 * and the indexes are written atomically so a reader never sees a half-built
 * file. Designed for a nightly cron:
 *
 *   25 6 * * * /usr/bin/node /home/ubuntu/www/denis.me/hemicycle/scripts/daily.mjs >> logs/daily.log 2>&1
 *
 * Flags:
 *   --force        re-download even if unchanged
 *   --skip-download  use the ZIPs already in storage/raw
 *   --quiet        summary only
 *
 * There is deliberately no per-scrutin HTTP fetching: the AN exposes no
 * per-scrutin JSON endpoint (…/scrutins/8429.json answers 200 with an HTML
 * body), so the bulk ZIP is the only correct source.
 */

import fs from 'node:fs';
import path from 'node:path';

import { PATHS, ensureDirs, readJson, writeJsonAtomic } from '../server/data/store.mjs';
import { iterateZip } from '../server/data/zip.mjs';
import { buildGroupRegistry } from '../server/data/groups.mjs';
import { normalize } from '../server/data/normalize.mjs';
import { buildSearchIndex } from '../server/data/search.mjs';
import { buildLawIndex } from '../server/data/law.mjs';
import { verify } from '../server/data/qa.mjs';
import { extractBill } from '../server/data/text.mjs';

const BASE = 'https://data.assemblee-nationale.fr/static/openData/repository/17';
const SOURCES = [
  { key: 'scrutins', file: 'Scrutins.json.zip', url: `${BASE}/loi/scrutins/Scrutins.json.zip` },
  {
    key: 'dossiers',
    file: 'Dossiers_Legislatifs.json.zip',
    url: `${BASE}/loi/dossiers_legislatifs/Dossiers_Legislatifs.json.zip`,
  },
  {
    key: 'organes',
    file: 'AMO10_deputes_actifs_mandats_actifs_organes.json.zip',
    url: `${BASE}/amo/deputes_actifs_mandats_actifs_organes/AMO10_deputes_actifs_mandats_actifs_organes.json.zip`,
  },
];

const argv = new Set(process.argv.slice(2));
const FORCE = argv.has('--force');
const SKIP_DOWNLOAD = argv.has('--skip-download');
const QUIET = argv.has('--quiet');

const t0 = Date.now();
const log = (...a) => {
  if (!QUIET) console.log(...a);
};
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

/**
 * Download unless the cached validators say the remote is unchanged.
 * House rule: every external sync is cached, never re-pulled blindly.
 */
async function sync(source, manifest) {
  const dest = path.join(PATHS.raw, source.file);
  const cached = manifest[source.key];
  const exists = fs.existsSync(dest);

  if (SKIP_DOWNLOAD) {
    if (!exists) throw new Error(`--skip-download but ${dest} is missing`);
    log(`  · ${source.file}: using local copy`);
    return { ...cached, changed: false, path: dest };
  }

  if (exists && cached && !FORCE) {
    try {
      const head = await fetch(source.url, { method: 'HEAD' });
      const etag = head.headers.get('etag');
      const lastModified = head.headers.get('last-modified');
      if ((etag && etag === cached.etag) || (lastModified && lastModified === cached.lastModified)) {
        log(`  · ${source.file}: unchanged (${etag || lastModified}), skipping download`);
        return { ...cached, changed: false, path: dest };
      }
    } catch (err) {
      log(`  · ${source.file}: HEAD failed (${err.message}), downloading anyway`);
    }
  }

  const res = await fetch(source.url);
  if (!res.ok) throw new Error(`${source.url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // Write via a temp file so an interrupted run cannot leave a truncated ZIP.
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);

  log(`  · ${source.file}: downloaded ${(buf.length / 1048576).toFixed(1)} MB`);
  return {
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    bytes: buf.length,
    fetchedAt: new Date().toISOString(),
    changed: true,
    path: dest,
  };
}

async function main() {
  ensureDirs();
  log(`▸ scrutin refresh — ${new Date().toISOString()}`);

  // 1. Sync the three archives ------------------------------------------------
  const manifest = readJson(PATHS.cacheManifest, {});
  const files = {};
  for (const source of SOURCES) {
    const result = await sync(source, manifest);
    files[source.key] = result.path;
    const { changed, path: _p, ...persist } = result;
    manifest[source.key] = { ...persist, url: source.url };
  }

  // 2. Group identities from AMO10 -------------------------------------------
  const organes = [];
  for (const entry of iterateZip(fs.readFileSync(files.organes), (n) => n.includes('/organe/'))) {
    const rec = JSON.parse(entry.read().toString('utf8')).organe;
    if (rec && rec.codeType === 'GP') organes.push(rec);
  }
  const groupRegistry = buildGroupRegistry(organes);
  log(`  · groupes politiques: ${organes.length} depuis AMO10 (+ alias épinglés)`);

  // 3. Dossiers: titles for display, promulgations for the law index ----------
  const dossierTitres = Object.create(null);
  const dossiers = [];
  for (const entry of iterateZip(
    fs.readFileSync(files.dossiers),
    (n) => n.includes('/dossierParlementaire/'),
  )) {
    const d = JSON.parse(entry.read().toString('utf8')).dossierParlementaire;
    if (!d || !d.uid) continue;
    dossierTitres[d.uid] = (d.titreDossier && d.titreDossier.titre) || null;
    dossiers.push(d);
  }
  log(`  · dossiers législatifs: ${dossiers.length}`);

  // 4. Normalize every scrutin ------------------------------------------------
  const records = [];
  const scrutinsByDossier = Object.create(null);
  const bills = Object.create(null);
  let written = 0;
  let unchanged = 0;
  const qaFailures = Object.create(null);
  let failingScrutins = 0;

  for (const entry of iterateZip(fs.readFileSync(files.scrutins), (n) => n.endsWith('.json'))) {
    const raw = JSON.parse(entry.read().toString('utf8'));
    const rec = normalize(raw, { groupRegistry, dossierTitres });
    records.push(rec);

    if (rec.dossierRef) {
      (scrutinsByDossier[rec.dossierRef] || (scrutinsByDossier[rec.dossierRef] = [])).push(rec.numero);
    }

    const bill = extractBill(rec.titre);
    if (bill) (bills[bill] || (bills[bill] = [])).push(rec.numero);

    const qa = verify(rec);
    if (!qa.ok) {
      failingScrutins++;
      for (const c of qa.checks) if (!c.ok) qaFailures[c.id] = (qaFailures[c.id] || 0) + 1;
    }

    // Skip the write when the content is byte-identical: a nightly run then
    // touches only the handful of new ballots.
    const dest = path.join(PATHS.normalized, `${rec.numero}.json`);
    const next = JSON.stringify(rec);
    let prev = null;
    try {
      prev = fs.readFileSync(dest, 'utf8');
    } catch {
      /* new record */
    }
    if (prev === next) {
      unchanged++;
    } else {
      fs.writeFileSync(dest, next);
      written++;
    }
  }

  records.sort((a, b) => a.numero - b.numero);
  log(`  · scrutins normalisés: ${records.length} (${written} écrits, ${unchanged} inchangés)`);

  // 5. Indexes ----------------------------------------------------------------
  const searchIndex = buildSearchIndex(records);
  const laws = buildLawIndex(dossiers, scrutinsByDossier);
  const lawsWithBallot = Object.values(laws).filter((l) => l.scrutins.length).length;

  const effectifs = Object.create(null);
  let adoptes = 0;
  for (const r of records) {
    effectifs[r.effectif] = (effectifs[r.effectif] || 0) + 1;
    if (r.sort === 'adopté') adoptes++;
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    legislature: 17,
    scrutins: records.length,
    adoptes,
    rejetes: records.length - adoptes,
    finalVotes: searchIndex.docs.filter((d) => d.final).length,
    bills: Object.keys(bills).length,
    laws: Object.keys(laws).length,
    lawsWithBallot,
    dossiers: dossiers.length,
    groupes: organes.length,
    dateRange: records.length ? [records[0].date, records[records.length - 1].date] : null,
    effectifDistribution: effectifs,
    qa: {
      scrutinsChecked: records.length,
      failingScrutins,
      failuresByGate: qaFailures,
    },
    sources: SOURCES.map((s) => s.url),
  };

  writeJsonAtomic(PATHS.searchIndex, searchIndex);
  writeJsonAtomic(PATHS.laws, laws);
  writeJsonAtomic(PATHS.bills, bills);
  writeJsonAtomic(PATHS.meta, meta);
  writeJsonAtomic(PATHS.cacheManifest, manifest);

  // 6. Summary ----------------------------------------------------------------
  const dates = meta.dateRange || [];
  log(`  · index: ${Object.keys(searchIndex.postings).length} termes, ${meta.bills} textes, ${meta.finalVotes} votes solennels`);
  log(`  · lois promulguées: ${meta.laws} (${lawsWithBallot} rattachées à un scrutin)`);
  log(
    failingScrutins === 0
      ? '  · QA: 0 échec sur toutes les portes'
      : `  · QA: ${failingScrutins} scrutin(s) en échec ${JSON.stringify(qaFailures)}`,
  );
  console.log(
    `✓ scrutin refresh ok — ${records.length} scrutins (${dates[0]} → ${dates[1]}), ` +
      `${meta.laws} lois, ${failingScrutins} échec(s) QA, ${since()}`,
  );
}

main().catch((err) => {
  console.error(`✗ scrutin refresh failed: ${err.stack || err.message}`);
  process.exit(1);
});
