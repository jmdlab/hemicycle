/**
 * /loi/<slug> — one page per legislative text (bill), aggregating every ballot
 * cast on it. Two views, same data: a JSON endpoint for the SPA and a
 * prerendered HTML page for crawlers (nginx routes bot user agents there).
 *
 * Everything is derived from indexes already on disk (bills.json + the search
 * index + laws.json); a request never computes anything a crawler burst could
 * turn into load.
 */

import fssync from "node:fs";
import path from "node:path";

import { loadIndex, PATHS } from "./data/index.mjs";
import { buildBillSlugMap } from "./data/slug.mjs";
import { extractBill } from "./data/text.mjs";
import { readScrutin, readJson } from "./data/store.mjs";
import { mainLevee, voteSort } from "./data/amendements.mjs";
import { SITE, frDate, shorten, clipWord, esc, tag, metaName, ldJson } from "./seo.mjs";

/* ── bills.json, memoised on mtime like every other index ───────────────── */
let cache = { mtime: -1, slugMap: new Map(), keyToSlug: new Map() };

function loadBills() {
  let mtime = -1;
  try { mtime = fssync.statSync(PATHS.bills).mtimeMs; } catch { /* absent → -1 */ }
  if (mtime === cache.mtime) return cache;
  let bills = {};
  try { bills = JSON.parse(fssync.readFileSync(PATHS.bills, "utf8")); } catch { bills = {}; }
  const slugMap = buildBillSlugMap(bills);
  const keyToSlug = new Map([...slugMap.entries()].map(([slug, v]) => [v.key, slug]));
  cache = { mtime, slugMap, keyToSlug };
  return cache;
}

/** Folded bill key -> slug, or null. Used to link a scrutin to its bill page. */
export function slugForBillKey(key) {
  if (!key) return null;
  return loadBills().keyToSlug.get(key) ?? null;
}

/** Every bill, with slug + numeros. For the sitemap and related links. */
export function listBills() {
  return loadBills().slugMap;
}

/* ── display title ──────────────────────────────────────────────────────── */
// bills.json keys are FOLDED (ascii, lowercase). For display we re-extract the
// bill title from an original accented scrutin title with the accented mirror
// of BILL_RE — same shape, so the fold of the match is the key itself.
const BILL_RE_ACCENTED =
  /((?:projets?|propositions?) de (?:loi|r[ée]solution)(?:\s+(?:organique|constitutionnelle|de\s+financement|de\s+finances))?[^,;()]*)/i;

function displayTitle(docs, key) {
  let best = null;
  for (const d of docs) {
    const m = BILL_RE_ACCENTED.exec(String(d.titre ?? "").normalize("NFC"));
    if (m) {
      const t = m[1].replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
      if (!best || t.length > best.length) best = t;
    }
    if (best && d.final) break; // a final vote's title is authoritative enough
  }
  const raw = best ?? key;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/* ── votes à main levée ─────────────────────────────────────────────────── *
 * Floor amendments of the dossier decided without a public scrutin (server/data/amendements.mjs).
 * Every scrutin of the legislature counts as cover, not only this bill's: a number named the same
 * day by another text's scrutin hides the amendment, never the reverse. Memoised on the mtimes of
 * the dossier file, the search index and the scrutins manifest. */
const AMENDEMENTS_DIR = path.join(PATHS.storage, "amendements");
const DLR_RE = /^DLR[0-9A-Z]+$/;
const ML_CAP = 60;
/** Lag allowed between a scrutin and the archive that carries it. Unmeasured (the open data gives the vote's
 * day, not its hour), so generous: a wider margin only delays the section, it never mislabels a vote. */
const ML_MARGIN_MS = 6 * 3_600_000;
const mlCache = new Map(); // dossierRef → { key, value }
let roster = { mtime: -1, byRef: new Map() };

function mtimeOf(file) {
  try { return fssync.statSync(file).mtimeMs; } catch { return -1; }
}

function rosterByRef() {
  const file = path.join(PATHS.index, "deputes.json");
  const mtime = mtimeOf(file);
  if (mtime !== roster.mtime) {
    const deps = readJson(file, { deputes: [] }).deputes ?? [];
    roster = { mtime, byRef: new Map(deps.map((d) => [d.acteurRef, d])) };
  }
  return roster.byRef;
}

function auteurOf(a, byRef) {
  const dep = a.auteurRef ? byRef.get(a.auteurRef) : null;
  const nom = dep ? `${dep.prenom} ${dep.nom}` : null;
  if (a.auteurType === "Gouvernement") return { nom: "Gouvernement", groupe: null, slug: null };
  if (a.auteurType === "Rapporteur") return { nom: nom ? `${nom}, rapporteur` : "Rapporteur", groupe: null, slug: dep?.slug ?? null };
  return { nom, groupe: dep?.groupe?.abbrev ?? null, slug: dep?.slug ?? null };
}

export function mainLeveeFor(dossierRef) {
  if (!dossierRef || !DLR_RE.test(dossierRef)) return null;
  const file = path.join(AMENDEMENTS_DIR, `${dossierRef}.json`);
  const key = `${mtimeOf(file)}|${mtimeOf(PATHS.searchIndex)}|${mtimeOf(PATHS.cacheManifest)}|${mtimeOf(path.join(PATHS.index, "deputes.json"))}`;
  const hit = mlCache.get(dossierRef);
  if (hit?.key === key) return hit.value;

  let value = null;
  const data = readJson(file, null);
  if (data?.amendements) {
    // Margin before the scrutins archive time: a scrutin held minutes before it may not be in it yet.
    // The scrutins joined come from the search index: the cut-off never runs past the index build, even when a
    // fresher archive was downloaded and the index step then failed.
    const ix = loadIndex();
    const notAfter =
      Math.min(Date.parse(readJson(PATHS.cacheManifest, {}).scrutins?.lastModified ?? ""), Date.parse(ix.builtAt ?? "")) -
      ML_MARGIN_MS;
    if (Number.isFinite(notAfter)) {
      const list = mainLevee(data.amendements, ix.docs ?? [], { notAfter });
      const byRef = rosterByRef();
      value = {
        total: list.length,
        adoptes: list.filter((a) => voteSort(a.sort) === "adopté").length,
        rejetes: list.filter((a) => voteSort(a.sort) === "rejeté").length,
        jusquau: new Date(notAfter).toISOString(),
        amendements: list.slice(0, ML_CAP).map((a) => ({
          uid: a.uid,
          numero: a.numero,
          numeroLong: a.numeroLong ?? String(a.numero),
          sousAmendement: !!a.sousAmendement,
          article: a.article ? a.article.toLowerCase() : null, // « APRÈS ART. 4 » → « après art. 4 », SPA and crawler alike
          sort: voteSort(a.sort),
          date: a.dateSort,
          auteur: auteurOf(a, byRef),
        })),
      };
    }
  }
  if (mlCache.size > 200) mlCache.clear();
  mlCache.set(dossierRef, { key, value });
  return value;
}

/* ── assembling one bill ────────────────────────────────────────────────── */
const LIST_CAP = 120; // PLF-sized bills carry 1 000+ ballots; cap the listing.

function billData(slug) {
  const { slugMap } = loadBills();
  const entry = slugMap.get(slug);
  if (!entry) return null;

  const ix = loadIndex();
  const docs = entry.numeros
    .map((n) => ix.byNumero?.get(n))
    .filter(Boolean)
    .sort((a, b) => b.numero - a.numero);
  if (docs.length === 0) return null;

  const titre = displayTitle(docs, entry.key);
  const finals = docs.filter((d) => d.final);
  const final = finals[0] ?? null;

  // Promulgated law, joined by dossierRef — read from the final ballot's
  // normalized record (docs only carry dossierRef sporadically).
  let loi = null;
  const refDoc = final ?? docs[0];
  const rec = refDoc ? readScrutin(refDoc.numero) : null;
  if (rec?.dossierRef) {
    for (const l of Object.values(ix.laws ?? {})) {
      if (l.dossierRef === rec.dossierRef) {
        loi = { codeLoi: l.codeLoi, dateLoi: l.dateLoi ?? null, urlLegifrance: l.urlLegifrance ?? null };
        break;
      }
    }
  }

  // Listing: solemn votes first (they are the answer), then the most recent
  // procedural ballots up to the cap.
  const rest = docs.filter((d) => !d.final);
  const listed = [...finals, ...rest].slice(0, LIST_CAP);

  const type = /^projet de loi/.test(entry.key)
    ? "Projet de loi"
    : /^proposition de resolution/.test(entry.key)
      ? "Proposition de résolution"
      : "Proposition de loi";

  return {
    slug,
    titre,
    type,
    dossierRef: rec?.dossierRef ?? null,
    mainLevee: mainLeveeFor(rec?.dossierRef ?? docs.find((d) => d.dossierRef)?.dossierRef),
    dossierTitre: rec?.dossierTitre ?? null,
    loi,
    total: docs.length,
    dateRange: [docs.at(-1)?.date ?? null, docs[0]?.date ?? null],
    final: final
      ? { numero: final.numero, date: final.date, sort: final.sort, pour: final.pour,
          contre: final.contre, abstentions: final.abstentions, reading: final.reading ?? null }
      : null,
    scrutins: listed.map((d) => ({
      numero: d.numero, date: d.date, titre: d.titre, sort: d.sort,
      pour: d.pour, contre: d.contre, abstentions: d.abstentions,
      final: !!d.final, reading: d.reading ?? null,
    })),
  };
}

/** A few other bills, by most recent activity — internal links, never empty. */
function otherBills(excludeSlug, n = 5) {
  const { slugMap } = loadBills();
  const ix = loadIndex();
  const rows = [];
  for (const [slug, v] of slugMap) {
    if (slug === excludeSlug) continue;
    const last = Math.max(...v.numeros);
    rows.push({ slug, key: v.key, last });
  }
  rows.sort((a, b) => b.last - a.last);
  return rows.slice(0, n).map((r) => {
    const doc = ix.byNumero?.get(r.last);
    return { slug: r.slug, titre: doc ? displayTitle([doc], r.key) : r.key };
  });
}

/* ── routes ─────────────────────────────────────────────────────────────── */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,220}$/;

export function registerLoiRoutes(app, log) {
  // JSON — what the SPA renders.
  app.get("/api/hemicycle/loi/:slug", (req, res) => {
    const slug = String(req.params.slug ?? "");
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "bad_query" });
    try {
      const bill = billData(slug);
      if (!bill) return res.status(404).json({ error: "not_found" });
      res.json({ ...bill, autres: otherBills(slug) });
    } catch (e) {
      log("loi failed:", e.message);
      res.status(503).json({ error: "upstream_unavailable" });
    }
  });

  // Prerendered HTML — the indexable page for crawlers.
  app.get("/api/hemicycle/og/loi/:slug", (req, res) => {
    const slug = String(req.params.slug ?? "");
    if (!SLUG_RE.test(slug)) return res.status(400).send("");
    let bill;
    try { bill = billData(slug); } catch { bill = null; }
    if (!bill) return res.status(404).send("");

    const url = `${SITE}/loi/${slug}`;
    const f = bill.final;
    const resultWord = f?.sort === "adopté" ? "adopté" : f?.sort === "rejeté" ? "rejeté" : null;
    const titleCore = clipWord(bill.titre, 80);
    const title = `${titleCore} — ${bill.total} scrutin${bill.total > 1 ? "s" : ""}${resultWord ? ` · ${resultWord === "adopté" ? "Adopté" : "Rejeté"}` : ""} | Hémicycle`;
    const desc = clipWord(
      f && resultWord
        ? `${bill.titre} : ${resultWord} par l’Assemblée nationale le ${frDate(f.date)} (${f.pour} pour, ${f.contre} contre, ${f.abstentions} abstentions). ${bill.total} scrutins publics sur ce texte, détaillés vote par vote.`
        : `${bill.titre} : ${bill.total} scrutin${bill.total > 1 ? "s" : ""} public${bill.total > 1 ? "s" : ""} à l’Assemblée nationale, détaillé${bill.total > 1 ? "s" : ""} vote par vote. Pas encore de vote solennel sur l’ensemble du texte.`,
      300);

    const rowsHtml = bill.scrutins.map((s) =>
      `<li><a href="/${s.numero}">${esc(shorten(s.titre || `Scrutin n° ${s.numero}`, 110))}</a> — ${esc(frDate(s.date))}${s.sort ? `, ${esc(s.sort)}` : ""} (${s.pour} pour, ${s.contre} contre)</li>`).join("");
    const capNote = bill.total > bill.scrutins.length
      ? `<p>${bill.total - bill.scrutins.length} autres scrutins de procédure ne sont pas listés ici.</p>`
      : "";
    const ml = bill.mainLevee;
    const mlHtml = ml && ml.total > 0
      ? `<h2>Votes à main levée</h2><p>Vote à main levée — pas de détail par député. ${ml.total} amendement${ml.total > 1 ? "s" : ""} décidé${ml.total > 1 ? "s" : ""} sans scrutin public (${ml.adoptes} adopté${ml.adoptes > 1 ? "s" : ""}, ${ml.rejetes} rejeté${ml.rejetes > 1 ? "s" : ""}).</p><ul>${ml.amendements.map((a) =>
          `<li>${a.sousAmendement ? "Sous-amendement" : "Amendement"} n° ${esc(a.numeroLong)}${a.article ? ` (${esc(a.article)})` : ""}${a.auteur?.nom ? ` de ${esc(a.auteur.nom)}${a.auteur.groupe ? ` (${esc(a.auteur.groupe)})` : ""}` : ""} — ${esc(a.sort)} le ${esc(frDate(a.date.slice(0, 10)))}</li>`).join("")}</ul>${ml.total > ml.amendements.length ? `<p>${ml.total - ml.amendements.length} autres ne sont pas listés ici.</p>` : ""}`
      : "";
    const loiHtml = bill.loi
      ? `<p>Texte promulgué : loi n° ${esc(bill.loi.codeLoi)}${bill.loi.dateLoi ? ` du ${esc(frDate(bill.loi.dateLoi))}` : ""}${/^https?:\/\//i.test(bill.loi.urlLegifrance ?? "") ? ` — <a href="${esc(bill.loi.urlLegifrance)}" rel="nofollow">texte sur Légifrance</a>` : ""}.</p>`
      : "";
    const autres = otherBills(slug);
    const autresHtml = autres.length
      ? `<h2>Autres textes récents</h2><ul>${autres.map((b) => `<li><a href="/loi/${esc(b.slug)}">${esc(shorten(b.titre, 100))}</a></li>`).join("")}</ul>`
      : "";

    const ld = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Legislation",
          "@id": `${url}#legislation`,
          "name": bill.titre,
          "url": url,
          "inLanguage": "fr-FR",
          "legislationType": bill.type,
          "jurisdiction": "France",
          "legislationPassedBy": { "@type": "GovernmentOrganization", "name": "Assemblée nationale" },
          ...(bill.loi?.codeLoi ? { "legislationIdentifier": `Loi n° ${bill.loi.codeLoi}` } : {}),
          ...(f?.date ? { "legislationDate": f.date } : {}),
          ...(f?.sort === "adopté"
            ? { "legislationLegalForce": "InForce" }
            : f?.sort === "rejeté" ? { "legislationLegalForce": "NotInForce" } : {}),
        },
        {
          "@type": "BreadcrumbList",
          "@id": `${url}#breadcrumb`,
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Accueil", "item": `${SITE}/` },
            { "@type": "ListItem", "position": 2, "name": shorten(bill.titre, 60) },
          ],
        },
      ],
    };

    res.type("html").send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
${metaName("description", desc)}
<link rel="canonical" href="${esc(url)}" />
${tag("og:type", "article")}${tag("og:site_name", "Hémicycle")}${tag("og:locale", "fr_FR")}
${tag("og:url", url)}${tag("og:title", `${bill.titre}${resultWord ? ` — ${resultWord === "adopté" ? "Adopté" : "Rejeté"}` : ""}`)}${tag("og:description", desc)}
${tag("og:image", `${SITE}/share.png`)}
${metaName("twitter:card", "summary_large_image")}
${metaName("twitter:title", bill.titre)}${metaName("twitter:description", desc)}${metaName("twitter:image", `${SITE}/share.png`)}
<script type="application/ld+json">${ldJson(ld)}</script>
</head><body>
<nav aria-label="Fil d’Ariane"><a href="/">Accueil</a> › ${esc(shorten(bill.titre, 70))}</nav>
<article>
<h1>${esc(bill.titre)} — les votes de l’Assemblée nationale</h1>
${f && resultWord
    ? `<p><strong>${resultWord === "adopté" ? "Adopté" : "Rejeté"}</strong> le ${esc(frDate(f.date))}${f.reading ? ` (${esc(f.reading)})` : ""} : ${f.pour} pour, ${f.contre} contre, ${f.abstentions} abstentions. <a href="/${f.numero}">Voir le scrutin solennel n°${f.numero}</a>.</p>`
    : `<p>Aucun vote solennel sur l’ensemble du texte pour l’instant ; ${bill.total} scrutin${bill.total > 1 ? "s" : ""} de procédure et d’amendements ont eu lieu.</p>`}
${loiHtml}
<h2>Tous les scrutins sur ce texte</h2>
<ul>${rowsHtml}</ul>
${capNote}
${mlHtml}
${autresHtml}
<p><a href="${esc(url)}">Voir la fiche complète sur Hémicycle</a></p>
</article>
</body></html>`);
  });
}
