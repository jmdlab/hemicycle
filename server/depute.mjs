/**
 * /depute/<slug> and /deputes — one page per sitting deputy, built from the
 * per-deputy index produced by scripts/build-deputes.mjs (AN open data only:
 * AMO10 roster + nominal ballot records).
 *
 * Honesty rule inherited from the build: positions are the ones the Assemblée
 * recorded, nothing is inferred. No per-deputy "absence" figure exists here,
 * because the data cannot distinguish absent from committee work.
 */

import fssync from "node:fs";
import path from "node:path";

import { loadIndex, PATHS } from "./data/index.mjs";
import { SITE, frDate, shorten, clipWord, esc, tag, metaName, ldJson } from "./seo.mjs";

const INDEX_FILE = path.join(PATHS.index, "deputes.json");
const VOTES_DIR = path.join(PATHS.storage, "deputes");

/* ── roster, memoised on mtime ──────────────────────────────────────────── */
let cache = { mtime: -1, value: null, bySlug: new Map() };

function loadDeputes() {
  let mtime = -1;
  try { mtime = fssync.statSync(INDEX_FILE).mtimeMs; } catch { /* absent → -1 */ }
  if (mtime === cache.mtime) return cache;
  let value = null;
  try { value = JSON.parse(fssync.readFileSync(INDEX_FILE, "utf8")); } catch { value = null; }
  const bySlug = new Map((value?.deputes ?? []).map((d) => [d.slug, d]));
  cache = { mtime, value, bySlug };
  return cache;
}

/** Sitemap needs the slugs + freshness without re-reading the file itself. */
export function listDeputes() {
  const { value } = loadDeputes();
  return value ?? { generatedAt: null, deputes: [] };
}

const POSITION = { p: "pour", c: "contre", a: "abstention", n: "non-votant" };
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;

function readVotes(slug) {
  try {
    return JSON.parse(fssync.readFileSync(path.join(VOTES_DIR, `${slug}.json`), "utf8"));
  } catch { return null; }
}

/** Latest N votes, hydrated with what the ballot was about. */
function hydrate(votes, n) {
  const ix = loadIndex();
  const out = [];
  for (const [numero, code, deleg] of votes.slice(0, n)) {
    const doc = ix.byNumero?.get(numero);
    out.push({
      numero,
      position: POSITION[code] ?? code,
      parDelegation: !!deleg,
      titre: doc?.titre ?? null,
      date: doc?.date ?? null,
      sort: doc?.sort ?? null,
    });
  }
  return out;
}

/** Alphabetic neighbours in the same group — internal links between fiches. */
function colleagues(dep, n = 5) {
  const { value } = loadDeputes();
  const same = (value?.deputes ?? []).filter(
    (d) => d.groupe?.abbrev === dep.groupe?.abbrev && d.slug !== dep.slug,
  );
  const i = same.findIndex((d) => d.nom.localeCompare(dep.nom, "fr") >= 0);
  const start = Math.max(0, (i === -1 ? same.length : i) - Math.floor(n / 2));
  return same.slice(start, start + n);
}

const fmtPct = (x) => (x == null ? "—" : `${Math.round(x * 100)} %`);

/* ── routes ─────────────────────────────────────────────────────────────── */
export function registerDeputeRoutes(app, log) {
  // JSON — the roster, slimmed for the index page.
  app.get("/api/hemicycle/deputes", (_req, res) => {
    const { value } = loadDeputes();
    if (!value) return res.status(503).json({ error: "upstream_unavailable" });
    res.json({
      generatedAt: value.generatedAt,
      scrutins: value.scrutins,
      deputes: value.deputes.map((d) => ({
        slug: d.slug, civ: d.civ, prenom: d.prenom, nom: d.nom,
        groupe: d.groupe, departement: d.departement, circo: d.circo,
        votes: d.stats?.votes ?? 0, participation: d.stats?.participation ?? 0,
      })),
    });
  });

  // JSON — one deputy.
  app.get("/api/hemicycle/depute/:slug", (req, res) => {
    const slug = String(req.params.slug ?? "");
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "bad_query" });
    try {
      const dep = loadDeputes().bySlug.get(slug);
      if (!dep) return res.status(404).json({ error: "not_found" });
      const votes = readVotes(slug);
      res.json({
        ...dep,
        derniersVotes: votes ? hydrate(votes.votes, 60) : [],
        totalVotes: votes?.votes?.length ?? dep.stats?.votes ?? 0,
        collegues: colleagues(dep).map((c) => ({
          slug: c.slug, civ: c.civ, prenom: c.prenom, nom: c.nom, groupe: c.groupe,
        })),
      });
    } catch (e) {
      log("depute failed:", e.message);
      res.status(503).json({ error: "upstream_unavailable" });
    }
  });

  // Prerendered HTML — the deputies index, for crawlers.
  app.get("/api/hemicycle/og/deputes", (_req, res) => {
    const { value } = loadDeputes();
    if (!value) return res.status(503).send("");
    const url = `${SITE}/deputes`;
    const n = value.deputes.length;
    const title = `Les ${n} députés de l’Assemblée nationale — votes et participation | Hémicycle`;
    const desc = clipWord(
      `Les ${n} députés de la XVIIe législature, groupe par groupe : votes exprimés sur ${value.scrutins} scrutins publics, participation, historique de vote détaillé pour chaque députée et député.`,
      300);

    // Grouped by political group, seat-count order — same rule as the stats page.
    const byGroup = new Map();
    for (const d of value.deputes) {
      const k = d.groupe?.abbrev ?? "NI";
      if (!byGroup.has(k)) byGroup.set(k, { nom: d.groupe?.nom ?? k, rows: [] });
      byGroup.get(k).rows.push(d);
    }
    const groupsHtml = [...byGroup.entries()]
      .sort((a, b) => b[1].rows.length - a[1].rows.length)
      .map(([abbrev, g]) =>
        `<h2>${esc(g.nom ?? abbrev)} (${g.rows.length})</h2><ul>${g.rows
          .map((d) => `<li><a href="/depute/${esc(d.slug)}">${esc(`${d.prenom} ${d.nom}`)}</a>${d.departement ? ` — ${esc(d.departement)}` : ""}</li>`)
          .join("")}</ul>`)
      .join("");

    const ld = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage",
          "@id": `${url}#page`,
          "url": url,
          "name": title,
          "description": desc,
          "inLanguage": "fr-FR",
          "isPartOf": { "@id": `${SITE}/#website` },
        },
        {
          "@type": "BreadcrumbList",
          "@id": `${url}#breadcrumb`,
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Accueil", "item": `${SITE}/` },
            { "@type": "ListItem", "position": 2, "name": "Députés" },
          ],
        },
      ],
    };

    res.type("html").send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
${metaName("description", desc)}
<link rel="canonical" href="${esc(url)}" />
${tag("og:type", "website")}${tag("og:site_name", "Hémicycle")}${tag("og:locale", "fr_FR")}
${tag("og:url", url)}${tag("og:title", title)}${tag("og:description", desc)}
${tag("og:image", `${SITE}/share.png`)}
${metaName("twitter:card", "summary_large_image")}
${metaName("twitter:title", title)}${metaName("twitter:description", desc)}${metaName("twitter:image", `${SITE}/share.png`)}
<script type="application/ld+json">${ldJson(ld)}</script>
</head><body>
<nav aria-label="Fil d’Ariane"><a href="/">Accueil</a> › Députés</nav>
<article>
<h1>Les ${n} députés de l’Assemblée nationale</h1>
<p>${esc(desc)}</p>
${groupsHtml}
<p><a href="${esc(url)}">Voir la liste complète sur Hémicycle</a></p>
</article>
</body></html>`);
  });

  // Prerendered HTML — one deputy, for crawlers.
  app.get("/api/hemicycle/og/depute/:slug", (req, res) => {
    const slug = String(req.params.slug ?? "");
    if (!SLUG_RE.test(slug)) return res.status(400).send("");
    const dep = loadDeputes().bySlug.get(slug);
    if (!dep) return res.status(404).send("");

    const url = `${SITE}/depute/${slug}`;
    const fullName = `${dep.prenom} ${dep.nom}`;
    const st = dep.stats ?? {};
    const circo = dep.departement
      ? `${dep.departement}${dep.circo ? ` (${dep.circo}e circonscription)` : ""}`
      : null;
    const groupe = dep.groupe?.nom ?? dep.groupe?.abbrev ?? null;

    const title = `${fullName} — votes à l’Assemblée nationale (${dep.groupe?.abbrev ?? "député"}) | Hémicycle`;
    const desc = clipWord(
      `Comment vote ${fullName}, député${dep.civ === "Mme" ? "e" : ""}${groupe ? ` du groupe ${groupe}` : ""}${circo ? `, élu${dep.civ === "Mme" ? "e" : ""} dans ${circo}` : ""} : ${st.votes ?? 0} positions exprimées (${st.pour ?? 0} pour, ${st.contre ?? 0} contre, ${st.abstention ?? 0} abstentions), participation ${fmtPct(st.participation)} des scrutins publics depuis le début de son mandat.`,
      300);

    const votes = readVotes(slug);
    const recent = votes ? hydrate(votes.votes, 40) : [];
    const rowsHtml = recent.map((v) =>
      `<tr><td><a href="/${v.numero}">${esc(shorten(v.titre ?? `Scrutin n° ${v.numero}`, 100))}</a></td><td>${esc(frDate(v.date))}</td><td>${esc(v.position)}${v.parDelegation ? " (par délégation)" : ""}</td></tr>`).join("");
    const votesHtml = rowsHtml
      ? `<h2>Ses derniers votes</h2><table><thead><tr><th scope="col">Scrutin</th><th scope="col">Date</th><th scope="col">Position</th></tr></thead><tbody>${rowsHtml}</tbody></table>${(votes?.votes?.length ?? 0) > recent.length ? `<p>${votes.votes.length - recent.length} autres positions enregistrées depuis le début de la législature.</p>` : ""}`
      : "<p>Aucune position nominative enregistrée pour ce mandat.</p>";

    const cols = colleagues(dep);
    const colsHtml = cols.length
      ? `<h2>Dans le même groupe</h2><ul>${cols.map((c) => `<li><a href="/depute/${esc(c.slug)}">${esc(`${c.prenom} ${c.nom}`)}</a></li>`).join("")}</ul>`
      : "";

    const ld = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Person",
          "@id": `${url}#person`,
          "name": fullName,
          "givenName": dep.prenom,
          "familyName": dep.nom,
          "url": url,
          "jobTitle": dep.civ === "Mme" ? "Députée" : "Député",
          ...(groupe ? { "memberOf": { "@type": "Organization", "name": groupe } } : {}),
          ...(dep.profession ? { "hasOccupation": { "@type": "Occupation", "name": dep.profession } } : {}),
          "worksFor": { "@type": "GovernmentOrganization", "name": "Assemblée nationale" },
          ...(circo ? { "workLocation": { "@type": "Place", "name": circo } } : {}),
        },
        {
          "@type": "BreadcrumbList",
          "@id": `${url}#breadcrumb`,
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "Accueil", "item": `${SITE}/` },
            { "@type": "ListItem", "position": 2, "name": "Députés", "item": `${SITE}/deputes` },
            { "@type": "ListItem", "position": 3, "name": fullName },
          ],
        },
      ],
    };

    res.type("html").send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
${metaName("description", desc)}
<link rel="canonical" href="${esc(url)}" />
${tag("og:type", "profile")}${tag("og:site_name", "Hémicycle")}${tag("og:locale", "fr_FR")}
${tag("og:url", url)}${tag("og:title", `${fullName} — ses votes à l’Assemblée nationale`)}${tag("og:description", desc)}
${tag("og:image", `${SITE}/share.png`)}
${metaName("twitter:card", "summary_large_image")}
${metaName("twitter:title", fullName)}${metaName("twitter:description", desc)}${metaName("twitter:image", `${SITE}/share.png`)}
<script type="application/ld+json">${ldJson(ld)}</script>
</head><body>
<nav aria-label="Fil d’Ariane"><a href="/">Accueil</a> › <a href="/deputes">Députés</a> › ${esc(fullName)}</nav>
<article>
<h1>${esc(fullName)} — ses votes à l’Assemblée nationale</h1>
<p>${esc(dep.civ === "Mme" ? "Députée" : "Député")}${groupe ? ` du groupe ${esc(groupe)}${dep.groupe?.abbrev ? ` (${esc(dep.groupe.abbrev)})` : ""}` : ""}${circo ? `, élu${dep.civ === "Mme" ? "e" : ""} dans ${esc(circo)}` : ""}${dep.dateDebutMandat ? `. Mandat en cours depuis le ${esc(frDate(dep.dateDebutMandat))}` : ""}.</p>
<h2>En chiffres</h2>
<ul>
<li>${st.votes ?? 0} positions exprimées sur ${st.scrutinsDepuisMandat ?? "?"} scrutins publics tenus depuis le début du mandat (participation ${esc(fmtPct(st.participation))})</li>
<li>${st.pour ?? 0} pour · ${st.contre ?? 0} contre · ${st.abstention ?? 0} abstentions${st.nonVotant ? ` · ${st.nonVotant} non-votant` : ""}</li>
${st.parDelegation ? `<li>${st.parDelegation} votes exprimés par délégation</li>` : ""}
</ul>
<p>Un scrutin sans position enregistrée ne signifie pas nécessairement une absence : le travail en commission n’apparaît pas dans les scrutins publics.</p>
${votesHtml}
${colsHtml}
<p><a href="/deputes">Tous les députés</a></p>
<p><a href="${esc(url)}">Voir la fiche complète sur Hémicycle</a></p>
</article>
</body></html>`);
  });
}
