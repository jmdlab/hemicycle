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

import { loadIndex, PATHS } from "./data/index.mjs";
import { buildBillSlugMap } from "./data/slug.mjs";
import { extractBill } from "./data/text.mjs";
import { readScrutin } from "./data/store.mjs";
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
${autresHtml}
<p><a href="${esc(url)}">Voir la fiche complète sur Hémicycle</a></p>
</article>
</body></html>`);
  });
}
