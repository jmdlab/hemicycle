#!/usr/bin/env node
/**
 * Floor amendments → storage/amendements/<DLR dossier>.json (slim records, see server/data/amendements.mjs).
 *
 * The AN archive is ~350 MB; we read it with HTTP Range requests: the tail, the central directory (~17 MB),
 * then only floor (séance) entries whose CRC-32 changed since the last run. A run where the archive did not
 * move costs one HEAD. State: storage/index/amendements-state.json (validators + CRC per amendment).
 *
 * The AN's cache nodes may serve different copies: every range must carry the ETag of the first answer
 * (and not be older than the HEAD), otherwise it is retried. `--force` ignores the HEAD check.
 * Run by daily.mjs and by poll.mjs when only this archive changed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PATHS, readJson, writeJsonAtomic } from '../server/data/store.mjs';
import { NO_CACHE, freshUrl, isNewer } from '../server/data/sources.mjs';
import {
  AMENDEMENTS_URL,
  readEocd,
  parseCentralDirectory,
  parseEntryName,
  isSeanceEntry,
  planRanges,
  inflateEntry,
  slimAmendement,
} from '../server/data/amendements.mjs';

export const AMENDEMENTS_DIR = path.join(PATHS.storage, 'amendements');
export const STATE_FILE = path.join(PATHS.index, 'amendements-state.json');
// Largest classic EOCD (22 B + 65 535 B comment) + the zip64 locator (20 B) and zip64 record (56 B) before it.
const TAIL = 65_557 + 76;
const DLR_RE = /^DLR[0-9A-Z]+$/;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function head() {
  try {
    const res = await fetch(freshUrl(AMENDEMENTS_URL), { method: 'HEAD', headers: NO_CACHE, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const v = { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
    return v.etag || v.lastModified ? v : null; // no validator = unknown, not « newer »
  } catch {
    return null;
  }
}

/** Range reader pinned to one copy of the archive. */
function reader(minLastModified, deadline) {
  let pinned = null;
  const stats = { requests: 0, bytes: 0 };
  const left = () => deadline - Date.now();
  async function range(start, end) {
    let lastErr = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await sleep(Math.min(2000 * attempt, Math.max(0, left())));
      if (left() <= 0) throw new Error('délai dépassé');
      stats.requests++;
      let res;
      try {
        res = await fetch(AMENDEMENTS_URL, {
          headers: { Range: `bytes=${start}-${end}` },
          signal: AbortSignal.timeout(Math.min(180_000, left())),
        });
      } catch (err) {
        lastErr = err;
        continue;
      }
      const etag = res.headers.get('etag');
      if (!etag || etag.startsWith('W/')) {
        await res.body?.cancel();
        throw new Error('archive sans ETag fort : impossible de lire des plages cohérentes');
      }
      const lm = Date.parse(res.headers.get('last-modified') || '');
      const stale = Number.isFinite(minLastModified) && Number.isFinite(lm) && lm < minLastModified;
      if (res.status !== 206 || stale || (pinned && etag !== pinned.etag)) {
        lastErr = new Error(`HTTP ${res.status}${stale ? ' (copie ancienne)' : ''}${pinned && etag !== pinned.etag ? ' (autre ETag)' : ''}`);
        await res.body?.cancel();
        continue;
      }
      // Content-Range must be exactly the bytes asked for (clipped at the end of the file), of the pinned size.
      const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') || '');
      const [from, to, total] = cr ? cr.slice(1).map(Number) : [];
      if (!cr || from !== start || to !== Math.min(end, total - 1) || (pinned && total !== pinned.total)) {
        lastErr = new Error(`Content-Range inattendu : ${res.headers.get('content-range')}`);
        await res.body?.cancel();
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== to - from + 1) {
        lastErr = new Error(`plage courte ${buf.length}/${to - from + 1}`);
        continue;
      }
      if (!pinned) pinned = { etag, lastModified: res.headers.get('last-modified'), total };
      stats.bytes += buf.length;
      return buf;
    }
    throw new Error(`plage ${start}-${end} : ${lastErr?.message ?? 'échec'}`);
  }
  return { range, stats, pinned: () => pinned };
}

function readDossier(dlr) {
  return readJson(path.join(AMENDEMENTS_DIR, `${dlr}.json`), null)?.amendements ?? [];
}

/** `deadline` (ms from now): the whole run gives up past it (poll holds the shared cron lock). */
export async function refresh({ force = false, deadline = 30 * 60_000 } = {}) {
  const until = Date.now() + deadline;
  const state = readJson(STATE_FILE, {});
  const remote = await head();
  if (!force && !isNewer(remote, state.source)) {
    log(`· amendements : rien de neuf${remote ? '' : ' (HEAD en échec)'}`);
    return { changed: false };
  }

  const r = reader(Date.parse(remote?.lastModified || ''), until);
  const first = await r.range(0, 0);
  void first;
  const total = r.pinned().total;
  if (!Number.isFinite(total) || total < TAIL) throw new Error(`taille d'archive inattendue : ${total}`);
  const tailStart = total - TAIL;
  const eocd = readEocd(await r.range(tailStart, total - 1), tailStart);
  const entries = parseCentralDirectory(await r.range(eocd.cdOffset, eocd.cdOffset + eocd.cdSize - 1));
  if (entries.length !== eocd.total) throw new Error(`répertoire incomplet : ${entries.length}/${eocd.total}`);

  // Floor entries by dossier; a dossier is rebuilt when any of its entries is new, changed or gone.
  const oldCrc = state.crc ?? {};
  const byDossier = new Map();
  const crc = {};
  for (const e of entries) {
    if (!isSeanceEntry(e.name)) continue;
    const p = parseEntryName(e.name);
    if (!DLR_RE.test(p.dossier)) continue;
    e.uid = p.uid;
    e.dossier = p.dossier;
    crc[p.uid] = e.crc;
    if (!byDossier.has(p.dossier)) byDossier.set(p.dossier, []);
    byDossier.get(p.dossier).push(e);
  }
  const fetchList = [];
  const touched = new Set();
  for (const [dlr, list] of byDossier) {
    // A dossier file lost or cut short since the last run is refetched whatever the CRCs say.
    const have = new Set(readDossier(dlr).map((a) => a.uid));
    const changedHere = list.filter((e) => oldCrc[e.uid] !== e.crc || !have.has(e.uid));
    if (changedHere.length) touched.add(dlr);
    fetchList.push(...changedHere);
  }
  const gone = new Set(Object.keys(oldCrc).filter((uid) => !(uid in crc)));
  for (const f of fs.existsSync(AMENDEMENTS_DIR) ? fs.readdirSync(AMENDEMENTS_DIR) : []) {
    if (!/^DLR[0-9A-Z]+\.json$/.test(f)) {
      if (/\.tmp/.test(f)) fs.rmSync(path.join(AMENDEMENTS_DIR, f), { force: true }); // left by a crashed atomic write
      continue;
    }
    const dlr = f.replace(/\.json$/, '');
    if (!byDossier.has(dlr)) touched.add(dlr); // dossier vanished from the archive
    else if (gone.size && readDossier(dlr).some((a) => gone.has(a.uid))) touched.add(dlr);
  }

  // Fetch the changed entries, a few large ranges at a time.
  const fresh = new Map();
  const broken = new Set();
  for (const [start, end, list] of planRanges(fetchList)) {
    const buf = await r.range(start, Math.min(end, total - 1));
    for (const e of list) {
      try {
        fresh.set(e.uid, slimAmendement(JSON.parse(inflateEntry(buf, start, e)), e.dossier));
      } catch (err) {
        // One bad entry must not freeze every dossier: skip its dossier this run, retry it next run.
        log(`✗ amendements : ${e.uid} illisible (${err.message}) — dossier ${e.dossier} gardé tel quel`);
        broken.add(e.dossier);
      }
    }
  }
  for (const dlr of broken) {
    touched.delete(dlr);
    for (const e of byDossier.get(dlr) ?? []) {
      if (e.uid in oldCrc) crc[e.uid] = oldCrc[e.uid];
      else delete crc[e.uid];
    }
  }

  const source = { etag: r.pinned().etag, lastModified: r.pinned().lastModified };
  fs.mkdirSync(AMENDEMENTS_DIR, { recursive: true });
  for (const dlr of touched) {
    const file = path.join(AMENDEMENTS_DIR, `${dlr}.json`);
    const list = byDossier.get(dlr);
    if (!list) {
      fs.rmSync(file, { force: true });
      continue;
    }
    const kept = new Map(readDossier(dlr).map((a) => [a.uid, a]));
    const amendements = list.map((e) => fresh.get(e.uid) ?? kept.get(e.uid)).filter(Boolean);
    if (amendements.length !== list.length) throw new Error(`${dlr} : ${list.length - amendements.length} amendement(s) manquant(s)`);
    writeJsonAtomic(file, { dossier: dlr, source, amendements });
  }
  writeJsonAtomic(STATE_FILE, { source, builtAt: new Date().toISOString(), crc });
  const mb = (r.stats.bytes / 1048576).toFixed(1);
  log(`✓ amendements : ${fetchList.length} lu(s), ${touched.size} dossier(s) réécrit(s) · ${r.stats.requests} requêtes · ${mb} Mo`);
  return { changed: touched.size > 0, fetched: fetchList.length, dossiers: touched.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  refresh({ force: process.argv.includes('--force') }).then(
    () => process.exit(0),
    (err) => {
      log(`✗ amendements : ${err.stack || err.message}`);
      process.exit(1);
    },
  );
}
