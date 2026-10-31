#!/usr/bin/env node
// backfill-amendements-contexte.mjs — write « Ce que l'amendement change ».
//
// Walks the amendment ballots and fills storage/amendements-contexte/ through
// makeContexte() (server/amendement.mjs: one AN file per amendment, a sonnet
// pass, the neutrality / figures / anchoring gates). The bill being debated now
// goes first (PRIORITY, the PLF 2027 on 31/10/2026), then every other ballot,
// newest first.
//
// Resumable: the cache is the state. A cached answer is skipped (a refusal is
// an answer; a « not yet published » is asked again after 12 h), a failure is
// logged and retried next run.
//
// Short by design: the poll waits at most 10 min for the shared cron lock, so a
// run stops at --deadline (12 min) whatever is left. After a run that wrote
// something, the search index is rebuilt so « taxe Go » finds its ballot.
//
//   node scripts/backfill-amendements-contexte.mjs [--limit N] [--sleep SECS]
//        [--deadline MIN] [--dossier DLR…] [--numero N] [--force] [--dry]

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, readJson, writeJsonAtomic } from '../server/data/store.mjs';
import { buildSearchIndex } from '../server/data/search.mjs';
import { amendementRefs } from '../server/data/amendements.mjs';
import { makeContexte, motsPourRecherche } from '../server/amendement.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const LIMIT = Math.max(1, Number(opt('--limit', 20)));
const SLEEP_MS = Math.max(0, Number(opt('--sleep', 4))) * 1000;
const DEADLINE = Date.now() + Math.max(1, Number(opt('--deadline', 12))) * 60_000;
const PRIORITY = opt('--dossier', 'DLR5L17N54629'); // projet de loi de finances pour 2027
const ONLY = opt('--numero', null);
const FORCE = args.includes('--force');
const DRY = args.includes('--dry');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function allRecords() {
  const out = [];
  for (const f of fs.readdirSync(PATHS.normalized)) {
    if (!/^\d+\.json$/.test(f)) continue;
    const r = readJson(path.join(PATHS.normalized, f), null);
    if (r?.numero) out.push(r);
  }
  return out.sort((a, b) => a.numero - b.numero);
}

async function main() {
  const records = allRecords();
  const amendBallots = records.filter((r) => r.dossierRef && amendementRefs(r.titre).nums.size > 0);
  let queue = [
    ...amendBallots.filter((r) => r.dossierRef === PRIORITY).reverse(),
    ...amendBallots.filter((r) => r.dossierRef !== PRIORITY).reverse(),
  ];
  if (ONLY) queue = amendBallots.filter((r) => String(r.numero) === ONLY);
  log(`▸ ${amendBallots.length} scrutins sur amendement · file ${queue.length} · limite ${LIMIT}`);

  const tally = { ok: 0, absent: 0, ecarte: 0, erreur: 0, cached: 0, hors: 0 };
  let calls = 0;
  for (const s of queue) {
    if (calls >= LIMIT || Date.now() > DEADLINE) break;
    if (DRY) { log(`  · ${s.numero}`); calls++; continue; }
    const r = await makeContexte(s, { force: FORCE });
    tally[r.status] = (tally[r.status] ?? 0) + 1;
    if (r.status === 'cached' || r.status === 'hors') continue;
    calls++;
    log(`  ${r.status === 'ok' ? '✓' : '·'} ${s.numero} ${r.status}${r.reason ? ` — ${r.reason}` : ''}`);
    if (SLEEP_MS) await sleep(SLEEP_MS);
  }

  if (tally.ok > 0) {
    writeJsonAtomic(PATHS.searchIndex, buildSearchIndex(records, motsPourRecherche));
    log('  · index de recherche reconstruit');
  }
  log(`✓ ok ${tally.ok} · absent ${tally.absent} · écarté ${tally.ecarte} · erreur ${tally.erreur} · déjà fait ${tally.cached}`);
  return tally.erreur > 0 && tally.ok === 0 ? 1 : 0;
}

main().then((c) => process.exit(c), (e) => { log(`✗ ${e.stack || e.message}`); process.exit(1); });
