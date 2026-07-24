#!/usr/bin/env node
// build-delegations.mjs — how many recorded votes were cast by someone else.
//
// The Assemblée's open data tags every individual vote with `parDelegation`.
// A deputy who cannot attend may delegate their vote (Règlement art. 62,
// ordonnance n°58-1066); the delegate presses one button and TWO votes are
// recorded. So a ballot's "votants" count is not a count of people in the room,
// and any sentence built on it that says "present" is wrong.
//
// This is not a detail: in 2026 roughly one recorded vote in six is delegated.
// The figure has to be measured, not assumed, so the page can say what it means
// — "a pris part au vote" — instead of what it does not know.
//
// The normalised store drops the flag (it keeps per-group totals), so this
// reads the raw ZIP once per refresh and writes a small per-year summary.
//
//   node scripts/build-delegations.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iterateZipJson } from '../server/data/zip.mjs';
import { writeJsonAtomic } from '../server/data/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = path.join(ROOT, 'storage', 'raw', 'Scrutins.json.zip');
const OUT = path.join(ROOT, 'storage', 'index', 'delegations.json');
const log = (...a) => console.log(new Date().toISOString(), ...a);

const buf = fs.readFileSync(ZIP);
const byYear = new Map();
const arr = (x) => (!x ? [] : Array.isArray(x) ? x : [x]);

for (const doc of iterateZipJson(buf, (n) => n.endsWith('.json'))) {
  const s = doc?.json?.scrutin;
  const year = String(s?.dateScrutin ?? '').slice(0, 4);
  if (!/^\d{4}$/.test(year)) continue;

  // Counting on the serialised form rather than walking the tree: the flag sits
  // several levels down inside every group's vote lists, and the AN emits it
  // both as a JSON boolean and as a quoted string depending on the export.
  const j = JSON.stringify(s);
  const delegues = (j.match(/"parDelegation":"?true"?/g) ?? []).length;
  const propres = (j.match(/"parDelegation":"?false"?/g) ?? []).length;

  const acc = byYear.get(year) ?? {
    scrutins: 0, votes: 0, delegues: 0, parDepute: new Map(), parDeputeEnPersonne: new Map(),
  };
  acc.scrutins += 1;
  acc.votes += delegues + propres;
  acc.delegues += delegues;

  // Per deputy, how many of the year's ballots they took a position in.
  // Averaging per-ballot rates instead — which is what the API used to do —
  // gives a slightly different, slightly flattering number, because ballots
  // have different denominators as seats fall vacant and are filled. Counting
  // by person answers the question actually being asked.
  for (const g of arr(s.ventilationVotes?.organe?.groupes?.groupe)) {
    const d = g.vote?.decompteNominatif;
    if (!d) continue;
    for (const k of ['pours', 'contres', 'abstentions', 'nonVotants']) {
      for (const v of arr(d[k]?.votant)) {
        if (!v?.acteurRef) continue;
        acc.parDepute.set(v.acteurRef, (acc.parDepute.get(v.acteurRef) ?? 0) + 1);
        // The same count, minus the ballots someone else pressed the button
        // for. This is the closest this dataset gets to "the deputy was there".
        if (String(v.parDelegation) !== 'true') {
          acc.parDeputeEnPersonne.set(
            v.acteurRef, (acc.parDeputeEnPersonne.get(v.acteurRef) ?? 0) + 1,
          );
        }
      }
    }
  }
  byYear.set(year, acc);
}

const out = {};
for (const [year, a] of byYear) {
  const counts = [...a.parDepute.values()].sort((x, y) => x - y);
  const at = (p) => (counts.length ? counts[Math.floor((counts.length - 1) * p)] : 0);
  const enPersonne = [...a.parDeputeEnPersonne.values()].sort((x, y) => x - y);
  const { parDepute, parDeputeEnPersonne, ...rest } = a;
  out[year] = {
    ...rest,
    deputes: counts.length,
    // Mean and median ballots a deputy took part in. The median is reported
    // because the spread is extreme — from a handful to every single ballot —
    // and a mean alone would hide that.
    prisMoyenne: counts.length ? Math.round(counts.reduce((x, y) => x + y, 0) / counts.length) : 0,
    prisMediane: at(0.5),
    prisEnPersonneMoyenne: enPersonne.length
      ? Math.round(enPersonne.reduce((x, y) => x + y, 0) / enPersonne.length)
      : 0,
    // Share of RECORDED votes that were cast by a delegate, not the titular.
    partDelegation: a.votes ? a.delegues / a.votes : 0,
  };
}

// Atomic: a torn read here caches `{}` for a day, and the delegation figures
// quietly vanish from the page rather than failing loudly.
writeJsonAtomic(OUT, out);

const years = Object.keys(out).sort().reverse();
for (const y of years) {
  const a = out[y];
  log(`${y} : ${a.scrutins} scrutins · ${a.deputes} députés · pris moy. ${a.prisMoyenne} (dont ${a.prisEnPersonneMoyenne} en personne) · ${(a.partDelegation * 100).toFixed(1)} % par délégation`);
}
log(`✓ ${years.length} années → ${path.relative(ROOT, OUT)}`);
