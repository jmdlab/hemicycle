/**
 * The three AN open-data archives Hémicycle is built from. Shared by refresh-data.mjs (download)
 * and poll.mjs (cheap HEAD check every 15 min).
 */
// The AN's shared cache answers « force cache » with a copy up to a few hours old (seen 31/10/2026: a HEAD
// returned the 17:25 file at 02:00 while the 23:25 one existed). no-cache asks it to revalidate with the origin.
export const NO_CACHE = { 'Cache-Control': 'no-cache' };
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
