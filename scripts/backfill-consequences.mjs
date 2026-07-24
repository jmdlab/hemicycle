#!/usr/bin/env node
// backfill-consequences.mjs — read the bills the daily window never covers.
//
// daily.mjs builds "Ce que le texte change" only for documents whose ballots
// fall inside SCRUTIN_SINCE (current year by default). Ballots older than that
// are served by the same pages but their bill was never read. This walks the
// FULL index — newest ballots first, since those are the ones bill pages link
// prominently — and fills the same per-document cache with the same
// makeConsequence() call: same prompt, same neutrality gate, same anchoring
// check. Nothing here generates content; this script only decides WHICH
// document to read next.
//
// Resumable by construction: the cache IS the state. A cached ref is skipped
// (including cached refusals — a refusal is an answer), an item that fails is
// logged and retried on the next run, and a run can be killed at any point
// without losing anything but the item in flight.
//
// Deliberately gentle: concurrency 1, a pause after every model call, and a
// small per-run batch. The nightly pipeline stays the primary producer; this
// is the broom behind it.
//
//   node scripts/backfill-consequences.mjs [--limit N] [--sleep SECS]
//                                          [--since YYYY-MM-DD]

import { loadIndex, getScrutin } from '../server/data/index.mjs';
import { textRefFor } from '../server/texte.mjs';
import { makeConsequence, readCachedByRef } from '../server/consequence.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const LIMIT = Math.max(1, Number(opt('--limit', 25)));
const SLEEP_MS = Math.max(0, Number(opt('--sleep', 10))) * 1000;
// Full history by default — covering what the daily window does not is the point.
const SINCE = opt('--since', '2000-01-01');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ix = await loadIndex();

// One representative ballot per document, newest ballot first: bill pages
// surface their latest scrutins, so a recent gap is worth more than an old one.
const byRef = new Map();
const docs = [...ix.docs].sort(
  (a, b) => String(b.date).localeCompare(String(a.date)) || b.numero - a.numero,
);
for (const d of docs) {
  if (String(d.date) < SINCE) continue;
  const s = getScrutin(d.numero);
  const ref = s ? textRefFor(s.dossierRef) : null;
  if (ref && !byRef.has(ref)) byRef.set(ref, s);
}

const targets = [];
for (const [ref, s] of byRef) {
  if (!(await readCachedByRef(ref))) targets.push([ref, s]);
}

log(`backfill : ${byRef.size} documents dans l'index, ${targets.length} sans cache, lot de ${Math.min(LIMIT, targets.length)}`);

let done = 0;
let withText = 0;
let empty = 0;
let failed = 0;

for (const [ref, s] of targets.slice(0, LIMIT)) {
  try {
    const r = await makeConsequence(s);
    done += 1;
    if (r.mecanisme) {
      withText += 1;
      log(`  ✓ ${ref} (scrutin n°${s.numero}, ${s.date}) — mécanisme en cache`);
    } else {
      empty += 1;
      log(`  · ${ref} (scrutin n°${s.numero}, ${s.date}) — ${r.reason ?? 'vide'}`);
    }
  } catch (e) {
    // Logged and skipped — the cache has no entry, so the next run retries it.
    // One bad document must never block the loop.
    failed += 1;
    log(`  ✗ ${ref} (scrutin n°${s.numero}) — ${String(e.message).slice(0, 120)}`);
  }
  await sleep(SLEEP_MS);
}

const left = Math.max(0, targets.length - LIMIT);
log(`✓ lot terminé : ${done} lus · ${withText} avec mécanisme · ${empty} sans · ${failed} en échec · reste ${left}`);
// Non-zero only when the run produced nothing but failures — a partial batch
// with a few misses is a normal night, not an alert.
process.exit(failed > 0 && done === 0 ? 1 : 0);
