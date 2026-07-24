#!/usr/bin/env node
// build-consequences.mjs — read every bill in scope, once.
//
// Work is per DOCUMENT, not per ballot: the 3,487 ballots of 2026 rest on 73
// distinct texts, one of which carries 422 of them. So this fetches each bill
// once, reads its enacting articles, and caches what the text sets up plus what
// follows from it — shared by every ballot on that text.
//
// Idempotent: an already-cached document is skipped, so this is safe to run
// from cron and safe to resume after an interruption.
//
//   node scripts/build-consequences.mjs [--since YYYY-MM-DD] [--concurrency N]
//                                       [--limit N] [--force]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIndex, getScrutin } from '../server/data/index.mjs';
import { textRefFor } from '../server/texte.mjs';
import { makeConsequence, readCachedByRef } from '../server/consequence.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

// Same source as the server (server/index.mjs SINCE): otherwise an operator
// widening SCRUTIN_SINCE extends the page scope but never builds the mechanisms.
const SINCE = opt('--since', process.env.SCRUTIN_SINCE ?? `${new Date().getFullYear()}-01-01`);
const CONCURRENCY = Math.max(1, Math.min(3, Number(opt('--concurrency', 2))));
const LIMIT = Number(opt('--limit', Infinity));
const FORCE = flag('--force');

const log = (...a) => console.log(new Date().toISOString(), ...a);

const ix = await loadIndex();
const inScope = ix.docs.filter((d) => String(d.date) >= SINCE);

// One representative ballot per document — reading the bill is the same work
// whichever ballot asked for it.
const byRef = new Map();
for (const d of inScope) {
  const s = getScrutin(d.numero);
  const ref = s ? textRefFor(s.dossierRef) : null;
  if (ref && !byRef.has(ref)) byRef.set(ref, s);
}

let targets = [...byRef.entries()];
if (!FORCE) {
  const kept = [];
  for (const [ref, s] of targets) {
    if (!(await readCachedByRef(ref))) kept.push([ref, s]);
  }
  targets = kept;
}
targets = targets.slice(0, LIMIT === Infinity ? undefined : LIMIT);

log(`conséquences : ${byRef.size} documents depuis ${SINCE}, ${targets.length} à traiter, concurrence ${CONCURRENCY}`);

let done = 0, withText = 0, empty = 0, failed = 0;
const t0 = Date.now();
const queue = [...targets];

await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      const [ref, s] = item;
      try {
        const r = await makeConsequence(s, { force: FORCE });
        done += 1;
        if (r.mecanisme) withText += 1;
        else { empty += 1; if (empty <= 8) log(`  · ${ref} — ${r.reason ?? 'vide'}`); }
        if (done % 10 === 0) log(`  … ${done}/${targets.length} (${withText} avec mécanisme)`);
      } catch (e) {
        failed += 1;
        log(`  ✗ ${ref} — ${String(e.message).slice(0, 120)}`);
      }
    }
  }),
);

const mins = ((Date.now() - t0) / 60000).toFixed(1);
log(`✓ ${done} documents lus · ${withText} avec mécanisme · ${empty} sans · ${failed} en échec · ${mins} min`);
process.exit(failed > targets.length * 0.2 ? 1 : 0);
