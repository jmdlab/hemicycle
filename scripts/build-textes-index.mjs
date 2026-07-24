#!/usr/bin/env node
// build-textes-index.mjs — map each dossier to the AN documents it produced.
//
// The scrutin payload carries a dossierRef; the dossier carries `texteAssocie`
// references like PIONANR5L17B2591. Those refs are what let us fetch the actual
// bill: everything downstream — the mechanism a text puts in place, and what
// follows from it — has to be read from the text itself rather than inferred
// from a title, or it is guesswork wearing a citation.
//
// Emits storage/index/textes.json: { "DLR5L17N54085": ["PRJLANR5L17B2632", …] }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iterateZipJson } from '../server/data/zip.mjs';
import { writeJsonAtomic } from '../server/data/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = path.join(ROOT, 'storage', 'raw', 'Dossiers_Legislatifs.json.zip');
const OUT = path.join(ROOT, 'storage', 'index', 'textes.json');
const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Every `texteAssocie` anywhere in the acts tree, in document order. */
function collectRefs(node, out = []) {
  if (Array.isArray(node)) {
    for (const x of node) collectRefs(x, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'texteAssocie' && typeof v === 'string') out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

const buf = fs.readFileSync(ZIP);
const map = {};
let dossiers = 0, withRefs = 0;

for (const doc of iterateZipJson(buf, (n) => n.endsWith('.json'))) {
  const d = doc?.json?.dossierParlementaire;
  if (!d?.uid) continue;
  dossiers += 1;
  const refs = [...new Set(collectRefs(d.actesLegislatifs))];
  if (refs.length) {
    map[d.uid] = refs;
    withRefs += 1;
  }
}

// Atomic: the running service reads this file on every mtime change, and a
// half-written index would throw on the next request that needs a bill.
writeJsonAtomic(OUT, map);
const total = Object.values(map).reduce((a, r) => a + r.length, 0);
log(`✓ ${dossiers} dossiers · ${withRefs} avec textes · ${total} références → ${path.relative(ROOT, OUT)}`);
