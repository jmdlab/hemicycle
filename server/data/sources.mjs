/**
 * The three AN open-data archives Hémicycle is built from. Shared by refresh-data.mjs (download)
 * and poll.mjs (cheap HEAD check every 15 min).
 */
// The AN's shared cache answers « force cache » with a copy up to a few hours old (seen 31/10/2026: a HEAD
// returned the 17:25 file at 02:00 while the 23:25 one existed), and its nodes disagree: even with no-cache,
// one request in three still got the old copy. So: no-cache, a cache-busting query, and isNewer() below —
// an answer older than the copy we hold is never taken for a change.
export const NO_CACHE = { 'Cache-Control': 'no-cache' };

/** The archive URL with a throwaway query string, so the AN's cache cannot match it. */
export const freshUrl = (url) => `${url}?nc=${Date.now()}`;

/**
 * Is the remote copy newer than the one we hold? Last-Modified decides when both parse;
 * otherwise a different ETag counts. A remote that failed (null) is never newer.
 */
export function isNewer(remote, cached) {
  if (!remote) return false;
  if (!cached) return true;
  if ((remote.etag && remote.etag === cached.etag) || (remote.lastModified && remote.lastModified === cached.lastModified)) return false;
  const r = Date.parse(remote.lastModified || '');
  const c = Date.parse(cached.lastModified || '');
  if (Number.isFinite(r) && Number.isFinite(c)) return r > c;
  if (remote.etag && cached.etag) return remote.etag !== cached.etag;
  return true;
}
const BASE = 'https://data.assemblee-nationale.fr/static/openData/repository/17';
export const SOURCES = [
  { key: 'scrutins', file: 'Scrutins.json.zip', url: `${BASE}/loi/scrutins/Scrutins.json.zip` },
  {
    key: 'dossiers',
    file: 'Dossiers_Legislatifs.json.zip',
    url: `${BASE}/loi/dossiers_legislatifs/Dossiers_Legislatifs.json.zip`,
  },
  {
    key: 'organes',
    file: 'AMO10_deputes_actifs_mandats_actifs_organes.json.zip',
    url: `${BASE}/amo/deputes_actifs_mandats_actifs_organes/AMO10_deputes_actifs_mandats_actifs_organes.json.zip`,
  },
];
