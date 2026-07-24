#!/usr/bin/env node
// pregenerate.mjs — warm the card cache for the ballots people actually share.
//
// Rendering is only ~1.3 s, so this is not about latency alone: it means the
// first visitor to ask for a well-known vote gets it instantly instead of
// waiting, and it surfaces render failures here rather than in front of a user.
//
// Only the SVG is generated: 12 KB against ~880 KB for the raster set, so the
// FULL corpus costs ~100 MB instead of ~7 GB and there is no reason to restrict
// the scope any more. Rasters are derived on first request (~1.2 s) and are
// disposable — pruning them never loses anything.
//
//   node scripts/pregenerate.mjs [--final-only] [--limit N] [--concurrency N]

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIndex, getScrutin, verify } from '../server/data/index.mjs';
import { payloadHash } from '../server/data/cardhash.mjs';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARDS = path.join(ROOT, 'storage', 'cards');
const PY = process.env.SCRUTIN_PY || '/home/ubuntu/.venvs/hemicycle/bin/python';
const RENDERER = path.join(ROOT, 'render', 'render_card.py');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};

const FINAL_ONLY = flag('--final-only');
const LIMIT = opt('--limit', Infinity);
const CONCURRENCY = Math.max(1, Math.min(4, opt('--concurrency', 2)));

const log = (...a) => console.log(new Date().toISOString(), ...a);

const ix = await loadIndex();
const targets = [...ix.docs]
  .filter((d) => (FINAL_ONLY ? d.final : true))
  .sort((a, b) => b.numero - a.numero)
  .slice(0, LIMIT === Infinity ? undefined : LIMIT);

log(`pregenerate SVG: ${targets.length} scrutins (${FINAL_ONLY ? 'votes solennels' : 'tous'}), concurrence ${CONCURRENCY}`);

let done = 0, skipped = 0, failed = 0, qaRefused = 0;
const t0 = Date.now();

async function one(d) {
  // Skip the QA-refused ones without burning a request: they render nothing by
  // design, and a 422 here is expected rather than an error.
  const full = getScrutin(d.numero);
  if (!full) { skipped += 1; return; }
  if (!verify(full).ok) { qaRefused += 1; return; }

  // Shared TEMPLATE_VERSION-aware key: a design bump changes every hash, so
  // the whole corpus regenerates on the next run instead of being skipped.
  const hash = payloadHash(full);
  const dir = path.join(CARDS, String(full.legislature), String(full.numero), hash);
  try {
    const already = fssync.existsSync(dir)
      && (await fs.readdir(dir)).some((f) => f.endsWith('-card.svg'));
    if (already) { skipped += 1; return; }

    await fs.mkdir(dir, { recursive: true });
    const payloadFile = path.join(dir, 'payload.json');
    await fs.writeFile(payloadFile, JSON.stringify(full));
    await execFileP(PY, [RENDERER, '--in', payloadFile, '--outdir', dir, '--svg-only'],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    // The payload is renderer input only; nothing reads it afterwards and
    // keeping one per card costs 26 MB across the corpus.
    await fs.unlink(payloadFile).catch(() => {});
    done += 1;
    if (done % 250 === 0) log(`  … ${done}/${targets.length}`);
  } catch (e) {
    failed += 1;
    if (failed <= 5) log(`  ✗ n°${d.numero} ${e.message.slice(0, 80)}`);
  }
}

const queue = [...targets];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const d = queue.shift();
      if (d) await one(d);
    }
  }),
);

const secs = ((Date.now() - t0) / 1000).toFixed(0);
log(`✓ ${done} SVG générés · ${skipped} déjà présents · ${qaRefused} refusés au QA · ${failed} en échec · ${secs}s`);
process.exit(failed > targets.length * 0.1 ? 1 : 0);
