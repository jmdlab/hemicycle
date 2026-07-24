#!/usr/bin/env node
/**
 * Per-deputy index, built ONLY from the two raw archives already synced by
 * refresh-data.mjs — no network, no inference, no fabricated positions:
 *
 *   · AMO10 (députés actifs) -> identity, group, circonscription, mandate start
 *   · Scrutins.json.zip      -> every nominal ballot (decompteNominatif):
 *                               who voted pour/contre/abstention/non-votant,
 *                               and whether the vote was cast by delegation
 *
 * Outputs (all regenerable, gitignored):
 *   storage/index/deputes.json   roster + per-deputy aggregates
 *   storage/deputes/<slug>.json  compact vote history: [[numero, code, deleg]]
 *                                code: p=pour c=contre a=abstention n=non-votant
 *
 * What is deliberately NOT computed: per-deputy absences. The nominal record
 * lists positions taken; a missing entry does not distinguish "absent" from
 * committee work or a vacant seat, so no absence figure is asserted.
 *
 *   node scripts/build-deputes.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

import { PATHS, writeJsonAtomic } from '../server/data/store.mjs';
import { iterateZip } from '../server/data/zip.mjs';
import { buildGroupRegistry, resolveGroup } from '../server/data/groups.mjs';
import { slugify } from '../server/data/slug.mjs';

const AMO_ZIP = path.join(PATHS.raw, 'AMO10_deputes_actifs_mandats_actifs_organes.json.zip');
const SCRUTINS_ZIP = path.join(PATHS.raw, 'Scrutins.json.zip');
const OUT_INDEX = path.join(PATHS.index, 'deputes.json');
const OUT_DIR = path.join(PATHS.storage, 'deputes');

const t0 = Date.now();
const log = (...a) => console.log(...a);
const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => (v && typeof v === 'object' ? (v['#text'] ?? null) : (v ?? null));

// ── 1. roster + group registry from AMO10 ──────────────────────────────────
const amoBuf = fs.readFileSync(AMO_ZIP);

const organes = [];
for (const entry of iterateZip(amoBuf, (n) => n.includes('/organe/'))) {
  const rec = JSON.parse(entry.read().toString('utf8')).organe;
  if (rec && rec.codeType === 'GP') organes.push(rec);
}
const registry = buildGroupRegistry(organes);

const roster = [];
for (const entry of iterateZip(amoBuf, (n) => n.includes('/acteur/'))) {
  const a = JSON.parse(entry.read().toString('utf8')).acteur;
  if (!a) continue;
  const uid = text(a.uid);
  const ident = a.etatCivil?.ident ?? {};
  if (!uid || !ident.nom) continue;

  const mandats = toArray(a.mandats?.mandat);
  // Current group: the GP mandate still open. Current seat: the ASSEMBLEE one.
  const gp = mandats.find((m) => m.typeOrgane === 'GP' && !m.dateFin);
  const asm = mandats.find((m) => m.typeOrgane === 'ASSEMBLEE' && !m.dateFin)
    ?? mandats.find((m) => m.typeOrgane === 'ASSEMBLEE');
  const lieu = asm?.election?.lieu ?? {};

  // "(47) - Technicien" -> "Technicien"; empty/placeholder professions dropped.
  const prof = String(a.profession?.libelleCourant ?? '')
    .replace(/^\(\d+\)\s*-\s*/, '').trim() || null;

  roster.push({
    acteurRef: uid,
    civ: ident.civ ?? null,
    prenom: ident.prenom ?? '',
    nom: ident.nom ?? '',
    groupe: gp ? resolveGroup(registry, gp.organes?.organeRef) : { abbrev: 'NI', nom: 'Non inscrit', couleur: null },
    departement: lieu.departement ?? null,
    numDepartement: lieu.numDepartement ?? null,
    circo: lieu.numCirco ?? null,
    dateDebutMandat: asm?.dateDebut ?? null,
    profession: prof,
  });
}
log(`  · roster: ${roster.length} députés actifs (AMO10), ${organes.length} groupes`);

// Stable slugs: sort by acteurRef so a collision resolves identically on every
// rebuild, then slug from the name; collisions get the department+circo, which
// is how the AN itself disambiguates homonyms.
roster.sort((x, y) => x.acteurRef.localeCompare(y.acteurRef));
const bySlug = new Map();
for (const d of roster) {
  let slug = slugify(`${d.prenom} ${d.nom}`);
  if (bySlug.has(slug) && d.numDepartement) slug = slugify(`${d.prenom} ${d.nom} ${d.numDepartement} ${d.circo ?? ''}`);
  while (bySlug.has(slug)) slug = `${slug}-2`;
  d.slug = slug;
  bySlug.set(slug, d);
}

// ── 2. nominal votes from the raw scrutins ─────────────────────────────────
const votesByActeur = new Map(); // acteurRef -> [[numero, code, deleg]]
const scrutinDates = []; // [numero, date] for participation denominators
let ballots = 0;
let unknownActeurs = new Set();

const POSITIONS = [
  ['pours', 'p'],
  ['contres', 'c'],
  ['abstentions', 'a'],
  ['nonVotants', 'n'],
];

for (const entry of iterateZip(fs.readFileSync(SCRUTINS_ZIP), (n) => n.endsWith('.json'))) {
  const s = JSON.parse(entry.read().toString('utf8')).scrutin;
  if (!s) continue;
  const numero = Number.parseInt(s.numero, 10);
  if (!Number.isFinite(numero)) continue;
  scrutinDates.push([numero, s.dateScrutin ?? null]);

  for (const g of toArray(s.ventilationVotes?.organe?.groupes?.groupe)) {
    const dn = g?.vote?.decompteNominatif;
    if (!dn) continue;
    for (const [key, code] of POSITIONS) {
      for (const v of toArray(dn[key]?.votant)) {
        const ref = v?.acteurRef;
        if (!ref) continue;
        let list = votesByActeur.get(ref);
        if (!list) votesByActeur.set(ref, (list = []));
        list.push([numero, code, v.parDelegation === 'true' ? 1 : 0]);
        ballots++;
      }
    }
  }
}
for (const ref of votesByActeur.keys()) if (!bySlug.has(ref) && !roster.some((d) => d.acteurRef === ref)) unknownActeurs.add(ref);
log(`  · votes nominatifs: ${ballots} positions sur ${scrutinDates.length} scrutins`);
log(`  · acteurs hors roster actif (anciens députés): ${unknownActeurs.size} — ignorés, jamais inventés`);

// ── 3. per-deputy files + aggregates ───────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
scrutinDates.sort((a, b) => a[0] - b[0]);
const dateByNumero = new Map(scrutinDates.map(([numero, date]) => [numero, date]));

// Prune files for deputies who left the roster (slug no longer exists).
const keep = new Set([...bySlug.keys()].map((s) => `${s}.json`));
for (const f of fs.readdirSync(OUT_DIR)) {
  if (f.endsWith('.json') && !keep.has(f)) fs.rmSync(path.join(OUT_DIR, f));
}

let written = 0;
for (const d of roster) {
  const votes = (votesByActeur.get(d.acteurRef) ?? []).sort((a, b) => b[0] - a[0]);
  const stats = { votes: votes.length, pour: 0, contre: 0, abstention: 0, nonVotant: 0, parDelegation: 0 };
  for (const [, code, deleg] of votes) {
    if (code === 'p') stats.pour++;
    else if (code === 'c') stats.contre++;
    else if (code === 'a') stats.abstention++;
    else stats.nonVotant++;
    if (deleg) stats.parDelegation++;
  }
  // Denominator: ballots held since THIS deputy's mandate began — a deputy
  // seated in March must not be scored against January's ballots. When the
  // mandate-start date is missing, we must NOT fall back to the full corpus
  // (that would understate a real person's participation): the honest floor is
  // the ballots held since their FIRST recorded vote. With no votes at all we
  // have no honest denominator, so we publish nothing rather than a fake rate.
  const debut = d.dateDebutMandat ?? '';
  let since = debut || null;
  if (!since && votes.length) {
    for (const [numero] of votes) {
      const dt = dateByNumero.get(numero);
      if (dt != null && (since == null || dt < since)) since = dt;
    }
  }
  stats.scrutinsDepuisMandat = since
    ? scrutinDates.reduce((n, [, date]) => n + (date != null && date >= since ? 1 : 0), 0)
    : null;
  stats.participation = stats.scrutinsDepuisMandat
    ? Math.min(1, stats.votes / stats.scrutinsDepuisMandat)
    : null;
  d.stats = stats;
  d.dernierVote = votes[0]?.[0] ?? null;

  writeJsonAtomic(path.join(OUT_DIR, `${d.slug}.json`), {
    acteurRef: d.acteurRef,
    slug: d.slug,
    votes,
  });
  written++;
}

roster.sort((x, y) => x.nom.localeCompare(y.nom, 'fr') || x.prenom.localeCompare(y.prenom, 'fr'));
writeJsonAtomic(OUT_INDEX, {
  generatedAt: new Date().toISOString(),
  scrutins: scrutinDates.length,
  deputes: roster,
});

log(`✓ députés: ${written} fiches -> storage/deputes/, index ${path.relative(PATHS.storage, OUT_INDEX)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
