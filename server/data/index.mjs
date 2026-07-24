/**
 * Data layer barrel — the only surface the HTTP layer should import.
 *
 * Everything is read from `storage/`, produced by `scripts/refresh-data.mjs`.
 * Nothing here touches the network: a request never depends on the AN being up.
 */

import { loadIndex, readScrutin, iterateScrutins, PATHS } from './store.mjs';
import { resolve as resolveQuery } from './search.mjs';
import { verify as verifyOne, verifyAll } from './qa.mjs';
import { lookupLaw, listLaws } from './law.mjs';

export { normalize, sourceUrlFor, expectedMajorite } from './normalize.mjs';
export { verifyAll, lookupLaw, listLaws, loadIndex, iterateScrutins, PATHS };
export { GROUP_ALIASES } from './groups.mjs';

/** One normalized ballot by number, or null. */
export function getScrutin(numero) {
  return readScrutin(numero);
}

/** Query -> candidates. Never auto-picks; see search.mjs. */
export function resolve(query, opts) {
  return resolveQuery(query, opts);
}

/**
 * Run the QA gates.
 * @param {object|number} [target] - a normalized record, a scrutin number, or
 *   nothing at all to sweep the whole corpus.
 */
export function verify(target) {
  if (target == null) return verifyAll(iterateScrutins());
  if (typeof target === 'number' || typeof target === 'string') {
    const rec = readScrutin(target);
    if (!rec) throw new Error(`scrutin ${target} not found — run the refresh first.`);
    return verifyOne(rec);
  }
  return verifyOne(target);
}

/** Corpus-level counts, straight from the index metadata. */
export function stats() {
  const index = loadIndex();
  return {
    ...index.meta,
    scrutins: index.docCount,
    laws: Object.keys(index.laws || {}).length,
  };
}
