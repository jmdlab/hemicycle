/**
 * Storage paths + cached readers.
 *
 * The refresh script is the only writer; every reader here is lazy and memoised
 * so the API process pays the index-parse cost once, on first query.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const STORAGE = process.env.SCRUTIN_STORAGE || path.join(ROOT, 'storage');

export const PATHS = {
  storage: STORAGE,
  raw: path.join(STORAGE, 'raw'),
  normalized: path.join(STORAGE, 'normalized'),
  index: path.join(STORAGE, 'index'),
  cacheManifest: path.join(STORAGE, 'raw', '.cache.json'),
  searchIndex: path.join(STORAGE, 'index', 'search.json'),
  laws: path.join(STORAGE, 'index', 'laws.json'),
  bills: path.join(STORAGE, 'index', 'bills.json'),
  meta: path.join(STORAGE, 'index', 'meta.json'),
};

export function ensureDirs() {
  for (const dir of [PATHS.raw, PATHS.normalized, PATHS.index]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    if (err.code === 'ENOENT') {
      throw new Error(`${file} is missing — run \`node scripts/refresh-data.mjs\` first.`);
    }
    throw err;
  }
}

/** Atomic write: build alongside, then rename, so readers never see a partial file. */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

let _index = null;
let _indexMtime = 0;

/**
 * Search index + law table, merged and memoised.
 *
 * The memo is invalidated when `search.json` changes on disk, so a long-running
 * API process picks up the nightly refresh without a restart. The check is one
 * `statSync` per call — cheap next to parsing a 5.5 MB index.
 */
export function loadIndex({ reload = false } = {}) {
  let mtime = 0;
  try {
    mtime = fs.statSync(PATHS.searchIndex).mtimeMs;
  } catch {
    /* readJson below produces the actionable error */
  }
  if (_index && !reload && mtime === _indexMtime) return _index;

  const index = readJson(PATHS.searchIndex);
  index.laws = readJson(PATHS.laws, {});
  index.meta = readJson(PATHS.meta, {});
  // numero -> doc, so direct lookups and law joins are O(1) instead of scanning
  // 8 400+ docs per call.
  index.byNumero = new Map(index.docs.map((d) => [d.numero, d]));
  _index = index;
  _indexMtime = mtime;
  return _index;
}

/**
 * Look a doc up by ballot number, building the map on demand.
 * Tolerates an index handed in by a caller (tests) that never went through
 * `loadIndex`.
 */
export function docByNumero(index, numero) {
  if (!index.byNumero) index.byNumero = new Map(index.docs.map((d) => [d.numero, d]));
  return index.byNumero.get(numero);
}

export function scrutinPath(numero) {
  return path.join(PATHS.normalized, `${numero}.json`);
}

/** One normalized ballot, or null when absent. */
export function readScrutin(numero) {
  const n = Number.parseInt(numero, 10);
  if (!Number.isFinite(n)) return null;
  try {
    return JSON.parse(fs.readFileSync(scrutinPath(n), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Every normalized ballot, ascending. Streams from disk — used by QA sweeps. */
export function* iterateScrutins() {
  const files = fs
    .readdirSync(PATHS.normalized)
    .filter((f) => f.endsWith('.json'))
    .map((f) => Number.parseInt(f, 10))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  for (const n of files) {
    const rec = readScrutin(n);
    if (rec) yield rec;
  }
}
