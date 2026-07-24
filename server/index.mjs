// index.mjs — scrutin service (port 3206).
//
// Routes are mounted at the FULL /api/hemicycle/* path: nginx proxy_pass has no
// trailing slash, so the prefix is passed through intact (same convention as
// filtre/revendre — family-tree uses the stripping form, don't copy that one).
//
// Hard rule inherited from the runbook, with corrected gates: if the vote
// arithmetic does not reconcile, we return 422 and render NOTHING. A card that
// looks authoritative but is wrong is worse than no card.

import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { getScrutin, resolve as resolveQuery, verify, loadIndex } from "./data/index.mjs";
import { makeTweet } from "./tweet.mjs";
import { summarize, readCached, mechanicalHeat } from "./summarize.mjs";
import { plainSummary, plainDetail, keywordSalience } from "./plain.mjs";
import { glossaryFor, plainOutcome, plainTurnout, groupBreakdown } from "./explain.mjs";
import { readCachedConsequence } from "./consequence.mjs";
import { remuneration } from "./remuneration.mjs";
import { payloadHash } from "./data/cardhash.mjs";
import { SITE, frDate, shorten, clipWord, esc, tag, metaName, ldJson } from "./seo.mjs";
import { registerLoiRoutes, slugForBillKey } from "./loi.mjs";
import { registerDeputeRoutes } from "./depute.mjs";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "3206", 10);
const ROOT = path.resolve(__dirname, "..");
const STORAGE = path.join(ROOT, "storage");
const CARDS = path.join(STORAGE, "cards");
const PUBLIC_BASE = "/storage/cards";
const PY = process.env.SCRUTIN_PY || "/home/ubuntu/.venvs/hemicycle/bin/python";
const RENDERER = path.join(ROOT, "render", "render_card.py");
const RASTERIZER = path.join(ROOT, "render", "rasterize.py");
const RENDER_TIMEOUT_MS = 120_000;

// LLM is OFF by default. Every string this app publishes has a rule-based
// generator derived from official Assemblée fields, so the site can serve an
// anonymous public audience with no model call, no key, no rate limit and no
// per-visitor cost — and answer in microseconds instead of tens of seconds.
// Set SCRUTIN_LLM=on to let the optional model pass enrich cached rows.
const LLM = process.env.SCRUTIN_LLM === "on";

/* SITE (absolute origin for crawler og: URLs) is imported from seo.mjs — one
   definition shared with the /loi and /depute prerendered pages. */
// Announced at boot rather than left implicit: on a public site the difference
// between the two modes is the difference between "no model call is reachable
// from a request" and "some are". A stray SCRUTIN_LLM=on copied in from a dev
// .env should be visible in the log at startup, not discovered from a bill.

// Discovery scope. The corpus on disk goes back to the start of the legislature
// (Oct 2024), but the app is meant to read as current parliamentary activity,
// not an archive — so the list, the search and the figures cover the current
// year only. SCRUTIN_SINCE overrides it (an ISO date): that is the hook a
// rolling window would use later.
// Direct access by number still renders any ballot, so links shared earlier
// keep working.
const SINCE = process.env.SCRUTIN_SINCE || `${new Date().getFullYear()}-01-01`;
const inScope = (d) => String(d?.date ?? "") >= SINCE;

await fs.mkdir(CARDS, { recursive: true });

const app = express();
app.use(express.json({ limit: "64kb" }));
app.disable("x-powered-by");

const log = (...a) => console.log(new Date().toISOString(), ...a);

log(LLM ? "⚠ LLM=on — le passage modèle optionnel est actif" : "LLM=off — aucun appel modèle joignable depuis une requête");

/* ── health ─────────────────────────────────────────────────────────────── */
/**
 * Strict decimal, and nothing else.
 *
 * `Number()` accepts "0x7b", "1e2", " 123", "+123" and "123.0" — all of which
 * passed `Number.isInteger` here while failing nginx's `^/api/hemicycle/page/\d+$`
 * regex. The request therefore escaped the render rate-limit zone (6 r/min,
 * 2 connections) into the read zone (90 r/min, 6 connections) while still
 * spawning cairosvg. Measured in production: twelve `/page/0x7b` all returned
 * 200 where twelve `/page/123` correctly 503'd after five. At ~1 MB and ~113 MB
 * RSS per render, that fills the disk in hours.
 *
 * The 7-digit cap also kills `parseInt("1e+21")` returning 1, which served
 * ballot 1 under the label 1e+21.
 */
function parseNumero(v) {
  const raw = String(v ?? "").trim();
  return /^[1-9]\d{0,6}$/.test(raw) ? Number(raw) : null;
}

app.get("/api/hemicycle/health", (_req, res) => {
  // A health check that answers "is the process up" on a site whose whole value
  // is freshness is a health check that lies. The data can be three days stale
  // while the port is perfectly open.
  let meta = {};
  try { meta = loadIndex()?.meta ?? {}; } catch { /* index absent */ }
  const ageH = meta.generatedAt ? (Date.now() - Date.parse(meta.generatedAt)) / 3.6e6 : null;
  const stale = ageH == null || ageH > 36;
  res.status(stale ? 503 : 200).json({
    ok: !stale,
    service: "hemicycle",
    data: {
      generatedAt: meta.generatedAt ?? null,
      ageHours: ageH == null ? null : Math.round(ageH * 10) / 10,
      scrutins: meta.scrutins ?? null,
      dernierScrutin: meta.dateRange?.[1] ?? null,
    },
  });
});

/* ── latest ballots, straight from the local index ──────────────────────── */
// We serve the Assemblée's own open data from disk rather than scraping the
// site on every page load: instant, and immune to markup changes. Freshness is
// kept by the nightly cron, plus the opportunistic kick below.
const AN_LIST_URL = "https://www.assemblee-nationale.fr/dyn/17/scrutins";
let summarizing = false;

/** Fill missing summaries off the request path — the batched LLM call is ~60 s. */
function kickSummaries(nums) {
  if (summarizing || nums.length === 0) return false;
  summarizing = true;
  (async () => {
    try {
      const items = nums.map((n) => getScrutin(n)).filter(Boolean);
      await summarize(items);
      log(`summaries filled: ${items.length}`);
    } catch (e) {
      log("summarize failed:", e.message);
    } finally {
      summarizing = false;
    }
  })();
  return true;
}

// What a deputy is paid, and what an absence actually costs them. Constants
// transcribed from the Assemblée's own page — see server/remuneration.mjs.
app.get("/api/hemicycle/remuneration", (_req, res) => {
  const base = remuneration();
  // The share of that cost matching ballots the deputy did not vote on
  // themselves — counting BOTH the ones they took no part in and the ones a
  // colleague cast for them under a delegation.
  //
  // Labelled for exactly what it is: a proportion of the cost, not a measure of
  // absence. A deputy who did not vote may have been in committee, where the
  // Assemblée keeps the only real attendance record and which this dataset does
  // not contain. Naming it "coût de l'absentéisme" would assert something the
  // data cannot support; naming it after the arithmetic asserts only the
  // arithmetic, and lets the reader draw their own conclusion.
  const d = delegations()[String(SINCE).slice(0, 4)];
  const sansVotePersonnel =
    d?.scrutins && d?.prisEnPersonneMoyenne != null
      ? {
          part: 1 - d.prisEnPersonneMoyenne / d.scrutins,
          scrutins: d.scrutins - d.prisEnPersonneMoyenne,
          scrutinsTotal: d.scrutins,
          total: base.depuisJanvier.total * (1 - d.prisEnPersonneMoyenne / d.scrutins),
        }
      : null;
  res.json({ ...base, sansVotePersonnel });
});

app.get("/api/hemicycle/latest", async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit ?? "20", 10) || 20));
  const offset = Math.max(0, parseInt(req.query.offset ?? "0", 10) || 0);
  // Year filter. Absent means every year: the archive is already on disk, so
  // scoping the list to the current year would hide work that is right there.
  const year = /^\d{4}$/.test(String(req.query.year ?? "")) ? String(req.query.year) : null;
  try {
    const ix = await loadIndex();
    const all = [...(ix.docs ?? [])]
      .filter((d) => !year || String(d.date).slice(0, 4) === year)
      .sort((a, b) => b.numero - a.numero);
    const total = all.length;
    const docs = all.slice(offset, offset + limit);

    const summaries = LLM
      ? await Promise.all(
          docs.map((d) => readCached({ numero: d.numero, legislature: d.legislature ?? 17 })),
        )
      : docs.map(() => null);
    const missing = LLM ? docs.filter((_, i) => !summaries[i]).map((d) => d.numero) : [];
    const full = docs.map((d) => getScrutin(d.numero));

    // Procedural ballots (amendments, articles, motions) have no detail of their
    // own: the official title genuinely doesn't say what an amendment does, and
    // the model is instructed to abstain rather than invent. But the PARENT TEXT
    // is what's at stake, and its solemn vote already carries a validated
    // description — so we borrow that, explicitly labelled as the parent text.
    // No extra model call, no new claim.
    const context = await parentContext(ix, docs, summaries);

    res.json({
      builtAt: ix.builtAt,
      // True while one-liners are still being computed — the client may re-poll.
      summarizing: LLM ? kickSummaries(missing) || summarizing : false,
      listUrl: AN_LIST_URL,
      since: SINCE,
      // Pagination state. `total` is what lets the client stop asking rather
      // than discover the end by receiving an empty page.
      total,
      offset,
      limit,
      years: yearCounts(ix),
      stats: computeStats(ix),
      scrutins: docs.map((d, i) => {
        const s = summaries[i];
        const f = full[i];
        // Rule-based base layer; the model pass only ever overrides it.
        const salience = keywordSalience(f, d);
        const heat = s?.heat ?? Math.min(100, mechanicalHeat(f).score + salience * 10);
        return {
          numero: d.numero,
          legislature: d.legislature ?? 17,
          titre: d.titre,
          date: d.date,
          sort: d.sort,
          pour: d.pour,
          contre: d.contre,
          abstentions: d.abstentions,
          sourceUrl: d.sourceUrl ?? `${AN_LIST_URL}/${d.numero}`,
          resume: s?.resume ?? plainSummary(f, d),
          detail: s?.detail ?? plainDetail(f, d),
          contextDetail: s?.detail ? null : (context.get(d.numero) ?? null),
          hot: s?.hot ?? heat >= 50,
          heat,
          why: s?.why ?? mechanicalHeat(f).reasons,
        };
      }),
    });
  } catch (e) {
    log("latest failed:", e.message);
    res.status(503).json({ error: "upstream_unavailable" });
  }
});

/* ── delegated votes ────────────────────────────────────────────────────── */

const DELEGATIONS = path.join(ROOT, "storage", "index", "delegations.json");
let delegCache = { mtime: -1, value: {} };

/**
 * Per-year share of recorded votes cast by a delegate rather than the titular.
 *
 * The Assemblée lets a deputy delegate their vote; the delegate presses one
 * button and two votes are recorded. So "votants" counts recorded positions,
 * not people in the room — and the page must not turn one into the other.
 * Invalidated on file change, like every other index this process reads.
 */
function delegations() {
  let mtime = -1;
  try { mtime = fssync.statSync(DELEGATIONS).mtimeMs; } catch { /* absent → -1 */ }
  if (mtime === delegCache.mtime) return delegCache.value;
  let value = {};
  try {
    value = JSON.parse(fssync.readFileSync(DELEGATIONS, "utf8"));
  } catch (e) {
    // Absent is normal before the first pipeline run. Corrupt is not, and
    // swallowing it silently drops the page back to a derived figure that reads
    // about twenty ballots too kind — with nothing in the log to say why.
    if (e.code !== "ENOENT") log("delegations.json illisible:", e.message);
    value = {};
  }
  delegCache = { mtime, value };
  return value;
}

/* ── year facets ────────────────────────────────────────────────────────── */
let yearsCache = { builtAt: null, value: null };

/** Years present in the archive, newest first, with their ballot counts. */
function yearCounts(ix) {
  if (yearsCache.builtAt === ix.builtAt && yearsCache.value) return yearsCache.value;
  const counts = new Map();
  for (const d of ix.docs ?? []) {
    const y = String(d.date ?? "").slice(0, 4);
    if (/^\d{4}$/.test(y)) counts.set(y, (counts.get(y) ?? 0) + 1);
  }
  const value = [...counts.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([annee, scrutins]) => ({ annee, scrutins }));
  yearsCache = { builtAt: ix.builtAt, value };
  return value;
}

/* ── aggregate stats, recomputed once per index build ───────────────────── */
let statsCache = { builtAt: null, value: null };

/**
 * Participation and outcome aggregates over the whole legislature.
 *
 * NOT a "last 20 ballots" figure: the recent window happens to be dominated by
 * solemn votes, so it reads 60%+ against a 26% corpus average and would look
 * like a trend when it is only a difference in composition. The honest split is
 * by ballot TYPE — solemn votes on a whole text versus everything else — which
 * is a real and stable contrast rather than an artefact of the window.
 *
 * Purely arithmetic: no adjectives, no comparison to a norm, no judgement about
 * who shows up. ~220 ms over 8,400 ballots, computed once per index build.
 */
function computeStats(ix) {
  if (statsCache.builtAt === ix.builtAt && statsCache.value) return statsCache.value;

  const docs = [...(ix.docs ?? [])].filter(inScope).sort((a, b) => b.numero - a.numero);
  let n = 0, sumPart = 0, adoptes = 0, nFinal = 0, sumFinal = 0;
  // Attendance per group: how often a group's seats were actually occupied for
  // a vote, averaged over every ballot of the period. Present = voted or was
  // recorded as non-voting (the chair). Kept in seat order, never sorted by
  // rate — ordering by behaviour would be our ranking rather than the reader's.
  const byGroup = new Map();

  for (const d of docs) {
    const f = getScrutin(d.numero);
    if (!f) continue;
    const eff = f.effectif || 577;
    const part = (f.synthese?.votants ?? 0) / eff;
    sumPart += part;
    n += 1;
    if (f.sort === "adopté") adoptes += 1;
    if (d.final) { nFinal += 1; sumFinal += part; }

    for (const g of f.groupes ?? []) {
      if (!g.abbrev || g.abbrev === "ND" || !(g.membres > 0)) continue;
      const a = byGroup.get(g.abbrev) ?? { abbrev: g.abbrev, nom: g.nom, membres: 0, sum: 0, k: 0 };
      // Docs are walked newest first, so the FIRST value seen is the current
      // one. Assigning on every pass left the seat count of the oldest ballot
      // of the period — the group's headcount as it was in January.
      if (!a.nom) a.nom = g.nom;
      if (!a.membres) a.membres = g.membres;
      a.sum += ((g.pour ?? 0) + (g.contre ?? 0) + (g.abstention ?? 0) + (g.nonVotant ?? 0)) / g.membres;
      a.k += 1;
      byGroup.set(g.abbrev, a);
    }
  }

  const groupes = [...byGroup.values()]
    // `scrutins` is the number of ballots this group actually existed for, and
    // `absents` the count derived from the same denominator. The client used to
    // multiply the rate by the period total, which inflated the figure for any
    // group created or dissolved mid-period.
    .map((a) => ({
      abbrev: a.abbrev,
      nom: a.nom,
      membres: a.membres,
      presence: a.k ? a.sum / a.k : 0,
      scrutins: a.k,
      absents: Math.round(a.k - a.sum),
    }))
    .sort((x, y) => y.membres - x.membres);

  const deleg = delegations()[String(SINCE).slice(0, 4)];
  const value = {
    scrutins: n,
    dateRange: [docs.at(-1)?.date ?? null, docs[0]?.date ?? null],
    participationAvg: n ? sumPart / n : 0,
    participationFinal: nFinal ? sumFinal / nFinal : 0,
    finalVotes: nFinal,
    adoptes,
    rejetes: n - adoptes,
    groupes,
    // Share of the recorded votes that a colleague cast on someone's behalf.
    // Published alongside participation precisely so the two are never
    // conflated: participation counts positions, not people present.
    partDelegation: deleg?.partDelegation ?? 0,
    // Counted per deputy, not derived from a mean of per-ballot rates: seats
    // fall vacant and are filled through the year, so the denominators differ
    // and the derived figure came out flattering by about twenty ballots.
    prisMoyenne: deleg?.prisMoyenne ?? null,
    prisMediane: deleg?.prisMediane ?? null,
    prisEnPersonneMoyenne: deleg?.prisEnPersonneMoyenne ?? null,
    lastScrutin: docs[0] ? { numero: docs[0].numero, date: docs[0].date } : null,
  };
  statsCache = { builtAt: ix.builtAt, value };
  return value;
}

/**
 * For each procedural ballot without a detail, the description of the bill it
 * belongs to — taken from that bill's solemn vote, which already has a
 * neutrality-checked detail. Returns Map<numero, string>.
 */
async function parentContext(ix, docs, summaries) {
  const out = new Map();
  const needy = docs.filter((d, i) => !summaries[i]?.detail && d.bill && !d.final);
  if (needy.length === 0) return out;

  // bill -> the numero of its solemn vote (prefer the most recent one)
  const finalByBill = new Map();
  for (const d of ix.docs) {
    if (!d.final || !d.bill) continue;
    const prev = finalByBill.get(d.bill);
    if (!prev || d.numero > prev) finalByBill.set(d.bill, d.numero);
  }

  const wanted = [...new Set(needy.map((d) => finalByBill.get(d.bill)).filter(Boolean))];
  const cached = new Map(
    await Promise.all(
      wanted.map(async (n) => [n, await readCached({ numero: n, legislature: 17 })]),
    ),
  );
  for (const d of needy) {
    const detail = cached.get(finalByBill.get(d.bill))?.detail;
    if (detail) out.set(d.numero, detail);
  }
  return out;
}

/* ── one ballot, explained ──────────────────────────────────────────────── */
// The point of the project: someone with no time and no appetite for legal
// French should understand, at a glance, what was voted and who stood where.
// Everything here is rule-derived from official fields.
/**
 * Meta-only HTML for link-preview crawlers.
 *
 * Twitterbot, WhatsApp, LinkedIn and the rest do not run JavaScript, so a
 * single-page app hands them an empty shell — a bare link, on a product whose
 * entire purpose is being shared. nginx routes their user agents here; humans
 * never see this and are redirected to the real page if they land on it.
 *
 * The card is already on disk at 2048×1152, which is exactly what
 * summary_large_image wants. Nothing is generated for a crawler: an absent
 * raster falls back to the site image rather than spawning a renderer for a bot.
 */
// The /loi/<slug> and /depute/<slug> families live in their own modules;
// registered BEFORE og/:numero so route order never depends on Express
// parameter matching subtleties.
registerLoiRoutes(app, log);
registerDeputeRoutes(app, log);

app.get("/api/hemicycle/og/:numero", async (req, res) => {
  const numero = parseNumero(req.params.numero);
  if (numero === null) return res.status(400).send("");
  const s = getScrutin(numero);
  if (!s) return res.status(404).send("");

  // Search engines (Googlebot, bingbot, Applebot) AND social crawlers land here
  // — none of them run the SPA's JS. So this route is not just an OG stub any
  // more: it is the indexable page. It must carry the same substance a human
  // reads (result, per-group breakdown, plain-language explanation, related
  // votes) or Google sees ~45 words of thin content that never ranks and looks
  // like cloaking. Everything below is already computed for /page; nothing new
  // is generated for a crawler except reading caches off disk.
  // frDate / shorten / clipWord / esc / tag / metaName come from seo.mjs —
  // shared verbatim with the /loi and /depute prerendered pages.

  const url = `${SITE}/${numero}`;
  const syn = s.synthese ?? {};
  const pour = syn.pour ?? 0, contre = syn.contre ?? 0, abst = syn.abstention ?? 0;
  const sujet = plainSummary(s, s) || s.titre || `Scrutin n° ${numero}`;
  const resultWord = s.sort === "adopté" ? "adopté" : s.sort === "rejeté" ? "rejeté" : null;
  const resultLabel = s.sort === "adopté" ? "Adopté" : s.sort === "rejeté" ? "Rejeté" : "Résultat";
  const dateFr = frDate(s.date);

  // Cap the subject inside <title> so the full tag stays ≲110 chars; long
  // subjects are cut at a word boundary BEFORE the result/brand suffix.
  const sujetTitle = clipWord(sujet, 70);
  const title = `${sujetTitle} — ${resultLabel}${resultWord ? ` (${pour}-${contre})` : ""} · Scrutin n°${numero} | Hémicycle`;
  const ogTitle = `${sujet} — ${resultLabel}`;
  const desc = clipWord(
    resultWord
      ? `Le ${dateFr}, l’Assemblée nationale a ${resultWord} : ${sujet}. ${pour} pour, ${contre} contre, ${abst} abstentions. Détail du vote par groupe (RN, LFI, EPR, LR…).`
      : `${dateFr} — ${sujet}. ${pour} pour, ${contre} contre, ${abst} abstentions. Détail du vote par groupe.`,
    300);

  let image = `${SITE}/share.png`;
  try {
    const card = await readCachedCard(s);
    if (card?.pngShare?.url) image = SITE + card.pngShare.url;
  } catch { /* fall back to the site image */ }

  // ── the substance ──
  const groups = groupBreakdown(s).slice().sort((a, b) => (b.membres || 0) - (a.membres || 0));
  const outcome = plainOutcome(s);
  const turnout = plainTurnout(s);
  const detail = plainDetail(s, s);
  let conseq = null;
  try { conseq = await readCachedConsequence(s); } catch { /* optional */ }

  // Internal linking: sibling votes on the same bill first (a bill carries many
  // ballots), then the most recent ballots — turns 8 434 orphan pages into a
  // crawlable graph so PageRank flows and Google discovers the corpus.
  let related = [];
  let billLink = null; // { slug } — this ballot's own bill page
  try {
    const ix = await loadIndex();
    const docs = ix.docs ?? [];
    const self = docs.find((d) => d.numero === numero);
    if (self?.bill) {
      related = docs.filter((d) => d.bill === self.bill && d.numero !== numero);
      const slug = slugForBillKey(self.bill);
      if (slug) billLink = { slug };
    }
    if (related.length < 4) {
      // Topical fallback: same legislature, nearest scrutin numbers. Adjacent
      // ballots come from the same sitting, so they are topically close —
      // unlike "5 most recent site-wide", which put the same 5 links on every
      // orphan page. Deterministic tie-break: lower numero first.
      const seen = new Set([numero, ...related.map((d) => d.numero)]);
      const leg = self?.legislature ?? s.legislature ?? 17;
      related = related.concat(
        docs.filter((d) => !seen.has(d.numero) && (d.legislature ?? 17) === leg)
            .sort((a, b) =>
              Math.abs(a.numero - numero) - Math.abs(b.numero - numero) || a.numero - b.numero)
            .slice(0, 5 - related.length));
    }
    related = related.slice(0, 5);
  } catch { /* index optional */ }

  const name = metaName;

  const rows = groups.map((g) =>
    `<tr><th scope="row">${esc(g.abbrev || g.nom)}</th><td>${g.pour}</td><td>${g.contre}</td><td>${g.abstention}</td><td>${g.absent}</td></tr>`).join("");
  const table = groups.length
    ? `<h2>Comment a voté chaque groupe</h2><table><thead><tr><th scope="col">Groupe</th><th scope="col">Pour</th><th scope="col">Contre</th><th scope="col">Abstention</th><th scope="col">Absents</th></tr></thead><tbody>${rows}</tbody></table>`
    : "";
  const clair = detail ? `<h2>Le texte, en clair</h2><p>${esc(detail)}</p>` : "";
  const conseqHtml = conseq?.mecanisme
    ? `<h2>Ce que le texte change</h2><p>${esc(conseq.mecanisme)}</p>${conseq.consequence ? `<p>${esc(conseq.consequence)}</p>` : ""}`
    : "";
  // The bill page aggregates every ballot on this text — the strongest
  // internal link a scrutin page can carry.
  const billHtml = billLink
    ? `<p><a href="/loi/${esc(billLink.slug)}">Tous les scrutins sur ce texte de loi</a></p>`
    : "";
  const relHtml = related.length
    ? `<h2>Autres scrutins</h2><ul>${related.map((d) => `<li><a href="/${d.numero}">${esc(shorten(d.titre || `Scrutin n° ${d.numero}`, 90))}</a></li>`).join("")}</ul>`
    : "";
  const src = s.sourceUrl || `https://www.assemblee-nationale.fr/dyn/17/scrutins/${numero}`;

  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": `${url}#article`,
        "isPartOf": { "@id": `${SITE}/#website` },
        "mainEntityOfPage": url,
        "url": url,
        "headline": shorten(sujet, 110),
        "description": desc,
        "inLanguage": "fr-FR",
        ...(s.date ? { "datePublished": s.date, "dateModified": s.date } : {}),
        "author": { "@id": `${SITE}/#org` },
        "publisher": { "@id": `${SITE}/#org` },
        "image": image,
        "isBasedOn": src,
        "about": {
          "@type": "Legislation",
          "name": s.titre || sujet,
          "jurisdiction": "France",
          "legislationPassedBy": { "@type": "GovernmentOrganization", "name": "Assemblée nationale" },
        },
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${url}#breadcrumb`,
        "itemListElement": [
          { "@type": "ListItem", "position": 1, "name": "Accueil", "item": `${SITE}/` },
          { "@type": "ListItem", "position": 2, "name": `Scrutin n°${numero} — ${shorten(sujet, 60)}` },
        ],
      },
    ],
  };

  // </script>-safe JSON-LD embedding — see seo.mjs.
  const ldSafe = ldJson(ld);

  res.type("html").send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
${name("description", desc)}
<link rel="canonical" href="${esc(url)}" />
${tag("og:type", "article")}${tag("og:site_name", "Hémicycle")}${tag("og:locale", "fr_FR")}
${tag("og:url", url)}${tag("og:title", ogTitle)}${tag("og:description", desc)}
${tag("og:image", image)}${tag("og:image:width", "2048")}${tag("og:image:height", "1152")}
${name("twitter:card", "summary_large_image")}
${name("twitter:title", ogTitle)}${name("twitter:description", desc)}${name("twitter:image", image)}
<script type="application/ld+json">${ldSafe}</script>
</head><body>
<nav aria-label="Fil d’Ariane"><a href="/">Accueil</a> › Scrutin n°${numero}</nav>
<article>
<h1>${esc(sujet)}${dateFr ? ` — ce qu’a voté l’Assemblée le ${esc(dateFr)}` : ""}</h1>
<p><strong>${esc(resultLabel)}</strong> — ${esc(outcome)}</p>
<p>${esc(turnout.phrase)}</p>
${table}
${clair}
${conseqHtml}
${billHtml}
${relHtml}
<p>Source : <a href="${esc(src)}" rel="nofollow">Assemblée nationale — scrutin public n°${numero}</a></p>
<p><a href="${esc(url)}">Voir la fiche complète sur Hémicycle</a></p>
</article>
</body></html>`);
});

app.get("/api/hemicycle/page/:numero", async (req, res) => {
  const numero = parseNumero(req.params.numero);
  if (numero === null) {
    return res.status(400).json({ error: "bad_query", message: "Numéro invalide." });
  }
  let s;
  try { s = await getScrutin(numero); } catch (e) {
    return res.status(503).json({ error: "upstream_unavailable" });
  }
  if (!s) return res.status(404).json({ error: "not_found", numero });

  const source = { url: s.sourceUrl, label: `Assemblée nationale — scrutin n°${numero}` };
  const qa = verify(s);
  const ix = await loadIndex();
  const doc = (ix.docs ?? []).find((d) => d.numero === numero) ?? null;
  const cached = LLM ? await readCached({ numero, legislature: s.legislature ?? 17 }) : null;
  // Read from the bill itself. Precomputed offline and cached, so a public
  // visitor never triggers a model call — and absent means absent, never
  // "infer something instead".
  // Keyed by the ballot's DOSSIER, not its number: one bill carries hundreds of
  // ballots and is read once. Passing {numero} here silently missed every time.
  const conseq = await readCachedConsequence(s);

  // This ballot's bill page, when the title names one — the SPA links to it.
  const billSlug = doc?.bill ? slugForBillKey(doc.bill) : null;

  const body = {
    numero,
    legislature: s.legislature ?? 17,
    date: s.date,
    sort: s.sort,
    titre: s.titre,
    loi: billSlug ? { slug: billSlug } : null,
    resume: cached?.resume ?? plainSummary(s, doc),
    detail: cached?.detail ?? plainDetail(s, doc),
    outcome: plainOutcome(s),
    turnout: plainTurnout(s),
    groupes: groupBreakdown(s),
    glossaire: glossaryFor(s),
    synthese: s.synthese,
    effectif: s.effectif,
    source,
    qa,
    mecanisme: conseq?.mecanisme ?? null,
    consequence: conseq?.consequence ?? null,
    texteSource: conseq?.mecanisme ? (conseq.source ?? null) : null,
  };

  // The visual is the other half of the page; a QA-refused ballot gets the
  // explanation but no card, same rule as everywhere else.
  if (qa.ok) {
    try {
      const { assets } = await buildCard(s);
      body.preview = assets.preview;
      body.pngShare = assets.pngShare;
      body.png = assets.png;
      body.svg = assets.svg;
    } catch (e) {
      log(`page n°${numero}: render failed — ${e.message}`);
    }
  }
  res.json(body);
});

/* ── resolve: number | law reference | free-text topic ──────────────────── */
// Type-ahead suggestions. Same engine as /resolve but trimmed to the few fields
// a dropdown row needs, and GET (cacheable, cheap, called on every keystroke —
// the client debounces and aborts, this stays in-memory and sub-millisecond).
app.get("/api/hemicycle/suggest", (req, res) => {
  const q = String(req.query?.q ?? "").trim();
  if (q.length < 2) return res.json({ suggestions: [] });
  try {
    const out = resolveQuery(q);
    const suggestions = (out.candidates ?? []).slice(0, 6).map((c) => {
      const full = getScrutin(c.numero);
      return {
        numero: c.numero,
        resume: full ? plainSummary(full, c) : (c.titre || `Scrutin n° ${c.numero}`),
        date: c.date,
        sort: c.sort,
      };
    });
    res.json({ suggestions, interpretation: out.interpretation, ambiguous: !!out.ambiguous });
  } catch {
    res.json({ suggestions: [] });
  }
});

app.post("/api/hemicycle/resolve", async (req, res) => {
  const query = String(req.body?.query ?? "").trim();
  if (!query) return res.status(400).json({ error: "bad_query", message: "Requête vide." });
  try {
    const out = await resolveQuery(query);
    // BM25 emits unbounded scores (26.2, 17.9, …) but the wire contract — and
    // the client's auto-advance threshold — is a 0..1 confidence. Normalise
    // against the top hit so the number means what the type says it means.
    // `ambiguous` stays the authoritative "let the user choose" signal.
    const top = Math.max(1e-9, ...(out.candidates ?? []).map((c) => Number(c.score) || 0));
    // No inScope filter here: search covers the WHOLE corpus, not just the
    // current year. Filtering after scoring dropped 59% of ballots (the 2025
    // flagship laws — narcotrafic, immigration, aide à mourir 1re lecture — went
    // invisible) AND left `ambiguous`/`note` describing candidates that were
    // then removed. Direct access by number renders any ballot regardless.
    const candidates = (out.candidates ?? [])
      .map((c) => {
        // The plain-French summary, so the disambiguation screen reads like the
        // rest of the app instead of leading with the official jargon it exists
        // to remove. Derived from the same fields as the list, no model call.
        const full = getScrutin(c.numero);
        return {
          ...c,
          resume: full ? plainSummary(full, c) : null,
          score: Math.max(0, Math.min(1, (Number(c.score) || 0) / top)),
        };
      });
    // Coherence: never claim ambiguity over an empty result set.
    const ambiguous = candidates.length > 0 ? out.ambiguous : false;
    const note = candidates.length === 0
      ? (out.note ?? "Aucun scrutin ne correspond. Essayez d’autres mots, un numéro ou une référence de loi.")
      : out.note;
    res.json({ query, ...out, candidates, ambiguous, note });
  } catch (e) {
    log("resolve failed:", e.message);
    res.status(503).json({ error: "upstream_unavailable" });
  }
});

/* ── render: normalized data → QA gate → 3 rasters + neutral tweet ──────── */
app.post("/api/hemicycle/render", async (req, res) => {
  // `legislature` used to be read from the body, silently ignored by
  // getScrutin (which takes one argument), then echoed back in the response —
  // so a request could be answered with "legislature": 9999 next to card URLs
  // under /17/. It is a property of the record on disk, not an input.
  const numero = parseNumero(req.body?.numero);
  if (numero === null) {
    return res.status(400).json({ error: "bad_query", message: "Numéro de scrutin invalide." });
  }

  let s;
  try {
    s = await getScrutin(numero);
  } catch (e) {
    log("getScrutin failed:", e.message);
    return res.status(503).json({ error: "upstream_unavailable" });
  }
  if (!s) return res.status(404).json({ error: "not_found", numero });

  const source = { url: s.sourceUrl, label: `Assemblée nationale — scrutin n°${numero}` };
  const meta = toMeta(s);

  // QA gate — refuse to render on unreconciled arithmetic.
  const qa = verify(s);
  if (!qa.ok) {
    log(`QA refused n°${numero}:`, qa.checks.filter((c) => !c.ok).map((c) => c.id).join(","));
    return res.status(422).json({ error: "qa_failed", numero, qa, meta, source });
  }

  try {
    const { assets, tweet, tweetSource, reason, cached } = await buildCard(s);
    if (reason) log(`tweet fallback n°${numero}: ${reason}`);
    if (cached) log(`cache hit n°${numero}`);
    res.json({
      numero, legislature: s.legislature ?? 17,
      preview: assets.preview, pngShare: assets.pngShare, png: assets.png, svg: assets.svg,
      tweet, tweetSource,
      source, meta, qa,
    });
  } catch (e) {
    log("render failed:", e.message);
    res.status(500).json({ error: "render_failed" });
  }
});

/* ── helpers ────────────────────────────────────────────────────────────── */
function toMeta(s) {
  const y = s.synthese;
  return {
    numero: s.numero, legislature: s.legislature, titre: s.titre, date: s.date, sort: s.sort,
    pour: y.pour, contre: y.contre, abstentions: y.abstention,
    votants: y.votants, exprimes: y.exprimes, nonVotants: y.nonVotants ?? 0,
    majoriteAbsolue: y.majorite, effectif: s.effectif,
    absents: s.effectif - y.votants - (y.nonVotants ?? 0),
    sourceUrl: s.sourceUrl,
  };
}

/* payloadHash imported from data/cardhash.mjs — TEMPLATE_VERSION-aware, shared
   with pregenerate and the daily pipeline so a design bump invalidates every
   cache entry in all three places at once. */

/**
 * Render + caption, cached together.
 *
 * The caption MUST live in the same cache entry as the rasters: it costs an LLM
 * call (~20-50 s) and is deterministic for a given payload, so recomputing it on
 * every view made repeat requests take a full minute even though the PNG was
 * already on disk. Both are keyed by the same content hash.
 */
/**
 * The card already on disk, or nothing. Never renders.
 *
 * Crawlers must not be able to spawn cairosvg: they arrive in bursts, they do
 * not wait, and a missing raster is worth an imperfect preview rather than a
 * render queue driven by whoever pastes a link.
 */
async function readCachedCard(s) {
  const hash = payloadHash(s);
  const dir = path.join(CARDS, String(s.legislature), String(s.numero), hash);
  const marker = path.join(dir, "result.json");
  if (!fssync.existsSync(marker)) return null;
  try {
    const c = JSON.parse(await fs.readFile(marker, "utf8"));
    const assets = c.assets ?? c;
    if (!assets?.share?.file || !fssync.existsSync(path.join(dir, assets.share.file))) return null;
    return withUrls(assets, s, hash);
  } catch { return null; }
}

async function buildCard(s) {
  const hash = payloadHash(s);
  const dir = path.join(CARDS, String(s.legislature), String(s.numero), hash);
  const marker = path.join(dir, "result.json");

  if (fssync.existsSync(marker)) {
    const c = JSON.parse(await fs.readFile(marker, "utf8"));
    const assets = c.assets ?? c;
    const raster = assets?.card?.file && fssync.existsSync(path.join(dir, assets.card.file));
    if (c.tweet && raster) {
      return {
        assets: withUrls(assets, s, hash),
        tweet: c.tweet, tweetSource: c.tweetSource, cached: true,
      };
    }
  }

  await fs.mkdir(dir, { recursive: true });

  // The SVG is the canonical artefact and is cheap to keep (12 KB vs ~880 KB
  // for the raster set), so the whole corpus can be pre-generated. Rasters are
  // derived from it only when a card is actually requested, and are disposable.
  const svgPath = await ensureSvg(dir, s);
  const out = await runJson(PY, [RASTERIZER, "--svg", svgPath]);

  const { text: tweet, source: tweetSource, reason } = await makeTweet(s, { noLlm: !LLM });
  await fs.writeFile(marker, JSON.stringify({ assets: out, tweet, tweetSource }));
  return { assets: withUrls(out, s, hash), tweet, tweetSource, reason, cached: false };
}

/**
 * Ensure the SVG source exists; generating it costs ~95 ms. The payload file is
 * written only for the duration of the call — the renderer needs it as input,
 * but nothing downstream does (rasterising reads the SVG), and keeping 8,400 of
 * them costs 26 MB for no benefit.
 */
async function ensureSvg(dir, payload) {
  const existing = (await fs.readdir(dir)).find((f) => f.endsWith("-card.svg"));
  if (existing) return path.join(dir, existing);
  const payloadFile = path.join(dir, "payload.json");
  await fs.writeFile(payloadFile, JSON.stringify(payload));
  try {
    const out = await runJson(PY, [RENDERER, "--in", payloadFile, "--outdir", dir, "--svg-only"]);
    return path.join(dir, out.svg.file);
  } finally {
    await fs.unlink(payloadFile).catch(() => {});
  }
}

async function runJson(bin, args) {
  const { stdout } = await execFileP(bin, args, {
    timeout: RENDER_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  const out = JSON.parse(stdout.trim().split("\n").pop());
  if (out.error) throw new Error(out.error);
  return out;
}

function withUrls(out, s, hash) {
  const base = `${PUBLIC_BASE}/${s.legislature}/${s.numero}/${hash}`;
  const at = (k) => (out[k] ? { ...out[k], url: `${base}/${path.basename(out[k].file)}` } : null);
  return { preview: at("preview"), pngShare: at("share"), png: at("card"), svg: at("svg") };
}

app.use((_req, res) => res.status(404).json({ error: "not_found" }));

/**
 * Terminal error handler — four arguments, registered last.
 *
 * Without it Express serves its default handler, which puts the STACK TRACE in
 * the response body whenever NODE_ENV is not "production". On a public service
 * `POST /resolve -d '{bad'` was publishing /home/ubuntu/www/... paths and the
 * Node version to any anonymous caller. The detail goes to the log; the caller
 * gets a code and nothing else.
 */
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) log("unhandled:", err.stack || err.message);
  else log("rejected:", err.type || err.message);
  const error =
    err.type === "entity.too.large" ? "payload_too_large"
    : err.type === "entity.parse.failed" ? "bad_json"
    : status >= 500 ? "internal_error"
    : "bad_request";
  res.status(status).json({ error });
});

app.listen(PORT, "127.0.0.1", () => log(`hemicycle service on 127.0.0.1:${PORT}`));
