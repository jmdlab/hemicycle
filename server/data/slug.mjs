/**
 * URL slugs, shared by the HTTP layer, the sitemap builder and the deputy
 * index builder — one folding, everywhere, or /loi/<slug> and the sitemap
 * disagree about what a page is called.
 */

import { fold } from './text.mjs';

/** "Projet de loi de finances pour 2026" -> "projet-de-loi-de-finances-pour-2026". */
export function slugify(str) {
  return fold(str)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * bills.json ({ folded title -> [numeros] }) -> Map<slug, { key, numeros }>.
 *
 * Keys are sorted before slugging so a rare collision resolves to the same
 * "-2" suffix on every rebuild — a slug must never move between two bills
 * across a nightly refresh.
 */
export function buildBillSlugMap(bills) {
  const map = new Map();
  for (const key of Object.keys(bills).sort()) {
    let slug = slugify(key);
    if (!slug) continue;
    if (map.has(slug)) {
      let i = 2;
      while (map.has(`${slug}-${i}`)) i++;
      slug = `${slug}-${i}`;
    }
    map.set(slug, { key, numeros: bills[key] });
  }
  return map;
}
