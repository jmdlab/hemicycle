#!/usr/bin/env node
// build-sitemap.mjs — one URL per ballot, so search engines can find the
// 8 400 explanatory pages that a JavaScript app otherwise hides from them.
//
// Written to storage/, not dist/: `vite build` empties dist/, and the sitemap
// is data, not a build artefact. nginx serves it at /sitemap.xml.
//
//   node scripts/build-sitemap.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIndex, PATHS } from '../server/data/index.mjs';
import { buildBillSlugMap } from '../server/data/slug.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'storage', 'sitemap.xml');
const SITE = process.env.SCRUTIN_SITE || 'https://hemicycle.app';
const log = (...a) => console.log(new Date().toISOString(), ...a);

const readJsonOr = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

const ix = await loadIndex();
const docs = [...(ix.docs ?? [])].sort((a, b) => b.numero - a.numero);
const byNumero = new Map(docs.map((d) => [d.numero, d]));

// /loi/<slug> — one page per bill; lastmod = the date of its newest ballot.
const billSlugs = buildBillSlugMap(readJsonOr(PATHS.bills, {}));
const billUrls = [...billSlugs.entries()].map(([slug, v]) => {
  let last = null;
  for (const n of v.numeros) {
    const d = byNumero.get(n)?.date ?? null;
    if (d && (!last || d > last)) last = d;
  }
  return { slug, last };
});

// /depute/<slug> + /deputes — absent index (pipeline not yet run) means the
// sitemap simply doesn't announce those pages; it never fails the build.
const deputes = readJsonOr(path.join(PATHS.index, 'deputes.json'), { deputes: [] });
const depLastmod = (deputes.generatedAt ?? '').slice(0, 10) || null;

// lastmod uses each ballot's own date; the home page tracks the newest.
const lastHome = docs[0]?.date ?? null;
// XML-escape: loc now carries slugs, and an "&" in a URL would invalidate the
// whole document.
const escXml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const url = (loc, lastmod) =>
  `  <url><loc>${escXml(loc)}</loc>${lastmod ? `<lastmod>${escXml(lastmod)}</lastmod>` : ''}</url>`;

const body = [
  url(`${SITE}/`, lastHome),
  ...(deputes.deputes.length ? [url(`${SITE}/deputes`, depLastmod)] : []),
  ...billUrls.map((b) => url(`${SITE}/loi/${b.slug}`, b.last)),
  ...deputes.deputes.map((d) => url(`${SITE}/depute/${d.slug}`, depLastmod)),
  ...docs.map((d) => url(`${SITE}/${d.numero}`, d.date)),
].join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;

// Atomic, like every other file the pipeline writes under a live service.
const tmp = OUT + '.tmp';
fs.writeFileSync(tmp, xml);
fs.renameSync(tmp, OUT);
const total = 1 + (deputes.deputes.length ? 1 : 0) + billUrls.length + deputes.deputes.length + docs.length;
log(`✓ sitemap : ${total} URLs (${billUrls.length} lois, ${deputes.deputes.length} députés, ${docs.length} scrutins) → ${path.relative(ROOT, OUT)} (${(xml.length / 1024).toFixed(0)} Ko)`);
