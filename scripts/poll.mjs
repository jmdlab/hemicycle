#!/usr/bin/env node
/**
 * Fast poll of the AN open data (cron every 15 min by day, hourly at night).
 *
 * A run with nothing new costs three HEAD requests and exits. When an archive's
 * ETag / Last-Modified moved, it runs the whole daily pipeline (daily.mjs), so a
 * scrutin published by the AN is on hemicycle.app at the next quarter hour.
 *
 * Every new scrutin gets one line in logs/delais-an.jsonl: vote date, the AN
 * archive's Last-Modified (when the AN published it), when this poll first saw
 * it, and when the site served it. The open data carries the vote date but not
 * the hour, so the AN delay is known to the day; our own delay to the minute.
 *
 * Writes storage/index/poll.json (last check, last change seen) for the QA probe.
 * `--check` only reports what changed (no pipeline, no state written).
 * Locking is done by cron (flock on /var/lock/hemicycle-conseq.lock).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PATHS, readJson, writeJsonAtomic } from '../server/data/store.mjs';
import { SOURCES, NO_CACHE, freshUrl, isNewer } from '../server/data/sources.mjs';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLL_STATE = path.join(PATHS.index, 'poll.json');
const DELAYS_LOG = path.join(ROOT, 'logs', 'delais-an.jsonl');
const SITE = 'https://hemicycle.app';

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Remote validators for one archive, or null when the HEAD failed. */
async function head(source) {
  try {
    const res = await fetch(freshUrl(source.url), {
      method: 'HEAD',
      headers: NO_CACHE,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    return { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
  } catch {
    return null;
  }
}

/** A change = the AN serves a copy newer than ours (a stale cache node is not a change). */
export const isChanged = isNewer;

/** Numbers of the normalised scrutins on disk. */
function numerosOnDisk() {
  const out = new Set();
  for (const f of fs.readdirSync(PATHS.normalized)) {
    const m = /^(\d+)\.json$/.exec(f);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

/** True once the public site answers 200 for this scrutin. */
async function servedBySite(numero) {
  try {
    const res = await fetch(`${SITE}/api/hemicycle/page/${numero}`, { signal: AbortSignal.timeout(15_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const manifest = readJson(PATHS.cacheManifest, {});
  const state = readJson(POLL_STATE, {});
  const checkedAt = new Date().toISOString();

  const remotes = await Promise.all(SOURCES.map(head));
  const failed = SOURCES.filter((_, i) => !remotes[i]).map((s) => s.key);
  const changed = SOURCES.filter((s, i) => isChanged(remotes[i], manifest[s.key])).map((s) => s.key);
  const scrutinsRemote = remotes[SOURCES.findIndex((s) => s.key === 'scrutins')];

  const nextState = { ...state, checkedAt, headFailed: failed };
  if (scrutinsRemote?.lastModified && isNewer(scrutinsRemote, { lastModified: state.remoteScrutinsLastModified })) {
    nextState.remoteScrutinsLastModified = scrutinsRemote.lastModified;
  }

  if (process.argv.includes('--check')) {
    log(`· --check : changé = ${changed.join(', ') || 'rien'} · HEAD en échec = ${failed.join(', ') || 'aucun'}`);
    return 0;
  }

  if (changed.length === 0) {
    writeJsonAtomic(POLL_STATE, nextState);
    log(`· rien de neuf${failed.length ? ` (HEAD en échec : ${failed.join(', ')})` : ''}`);
    return 0;
  }

  log(`▸ changé : ${changed.join(', ')} — pipeline complète`);
  const before = numerosOnDisk();
  let ok = true;
  try {
    const { stdout } = await execFileP(process.execPath, [path.join(ROOT, 'scripts', 'daily.mjs')], {
      cwd: ROOT,
      timeout: 3_000_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const last = stdout.trim().split('\n').pop();
    log(`  ${last}`);
  } catch (err) {
    ok = false;
    const tail = `${err.stdout || ''}${err.stderr || ''}`.trim().split('\n').slice(-3).join(' | ');
    log(`✗ daily.mjs en échec : ${tail.slice(0, 400) || err.message}`);
  }

  const built = readJson(PATHS.cacheManifest, {}).scrutins?.lastModified || null;
  const fresh = [...numerosOnDisk()].filter((n) => !before.has(n)).sort((a, b) => a - b);
  const liveAt = new Date().toISOString();
  const lines = [];
  for (const numero of fresh) {
    const doc = readJson(path.join(PATHS.normalized, `${numero}.json`), {});
    lines.push({
      numero,
      voteDate: doc.date || null,
      anLastModified: built ? new Date(built).toISOString() : null,
      seenAt: checkedAt,
      liveAt,
    });
  }
  // One probe of the site for the newest scrutin: confirms the API reloaded the index.
  if (fresh.length) {
    const served = await servedBySite(fresh[fresh.length - 1]);
    for (const l of lines) l.served = served;
    if (!served) log(`✗ hemicycle.app ne sert pas encore le scrutin n°${fresh[fresh.length - 1]}`);
  }
  if (lines.length) fs.appendFileSync(DELAYS_LOG, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  if (ok) {
    nextState.lastChangeAt = checkedAt;
    nextState.lastChanged = changed;
  }
  nextState.lastRunOk = ok;
  writeJsonAtomic(POLL_STATE, nextState);
  log(`${ok ? '✓' : '✗'} ${fresh.length} nouveau(x) scrutin(s)${fresh.length ? ` : n°${fresh[0]}…${fresh[fresh.length - 1]}` : ''}`);
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      log(`✗ poll : ${err.stack || err.message}`);
      process.exit(1);
    },
  );
}
