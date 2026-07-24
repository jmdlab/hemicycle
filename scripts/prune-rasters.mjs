#!/usr/bin/env node
// prune-rasters.mjs — drop raster derivatives that have not been served lately.
//
// The SVG is the canonical artefact and is never pruned (12 KB each, ~100 MB for
// the whole corpus). PNG and WebP are pure derivatives: each costs ~870 KB and
// takes ~1.2 s to rebuild from its SVG, so deleting a cold one loses nothing but
// a second on the next request. Without this the raster cache grows without
// bound as more cards get viewed.
//
//   node scripts/prune-rasters.mjs [--days N] [--max-mb N] [--dry-run]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d;
};

const DAYS = opt('--days', 30);
const MAX_MB = opt('--max-mb', 500);
const DRY = flag('--dry-run');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARDS = path.join(ROOT, 'storage', 'cards');
const RASTER = /\.(png|webp)$/;
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function walk(dir, out = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (RASTER.test(e.name)) {
      const st = await fs.stat(p);
      // atime tracks reads (relatime updates it once a day, which is precise
      // enough for a 30-day window); mtime is the write time and would keep a
      // popular old card looking cold.
      out.push({ p, bytes: st.size, atime: st.atimeMs });
    }
  }
  return out;
}

const files = await walk(CARDS);
const totalMb = files.reduce((a, f) => a + f.bytes, 0) / 1024 / 1024;
const cutoff = Date.now() - DAYS * 86400_000;

let doomed = files.filter((f) => f.atime < cutoff);

// Even inside the window, stay under the size ceiling — coldest first.
if (totalMb > MAX_MB) {
  const keep = new Set(doomed.map((f) => f.p));
  const rest = files.filter((f) => !keep.has(f.p)).sort((a, b) => a.atime - b.atime);
  let mb = totalMb - doomed.reduce((a, f) => a + f.bytes, 0) / 1024 / 1024;
  for (const f of rest) {
    if (mb <= MAX_MB) break;
    doomed.push(f);
    mb -= f.bytes / 1024 / 1024;
  }
}

const freed = doomed.reduce((a, f) => a + f.bytes, 0) / 1024 / 1024;
log(`rasters: ${files.length} fichiers, ${totalMb.toFixed(0)} Mo · à purger ${doomed.length} (${freed.toFixed(0)} Mo)`);

if (!DRY) {
  let n = 0;
  for (const f of doomed) {
    try { await fs.unlink(f.p); n += 1; } catch { /* already gone */ }
  }
  // A stale result.json would claim rasters that no longer exist.
  const stale = new Set(doomed.map((f) => path.dirname(f.p)));
  for (const d of stale) {
    try { await fs.unlink(path.join(d, 'result.json')); } catch { /* none */ }
  }
  log(`✓ ${n} supprimés, ${freed.toFixed(0)} Mo libérés (les SVG sont intacts)`);
} else {
  log('(dry-run, rien supprimé)');
}
