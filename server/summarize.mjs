// summarize.mjs — one-line plain-French summary + a neutral "notable" score.
//
// WHY THE SCORE IS MOSTLY MECHANICAL
// "Hot" is a judgement, and a judgement made by vibe is how political bias
// re-enters a tool we deliberately built to have none. So heat is computed from
// facts of the ballot itself — is it a censure motion, is it the decisive vote
// on a text, was it close, did the chamber turn out — and only the *public
// salience* of the subject is asked of the model, bounded to 0..3.
//
// "Notable" here means "worth a citizen's attention", never "good" or "bad",
// and never "one side won". Nothing in the scoring looks at WHICH side won.

import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { checkNeutrality, explain } from './neutrality.mjs';

const require = createRequire(import.meta.url);
// Loaded lazily, not at import: index.mjs pulls these modules in at boot for
// their cache-read paths, and a public service must not fail to start because a
// file in another project moved. Path overridable for the same reason.
const CLI_PATH = process.env.SCRUTIN_CLAUDE_CLI || '/home/ubuntu/www/denis.me/river-brain/lib/claude-cli.cjs';
const runJSON = (...a) => require(CLI_PATH).runJSON(...a);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIR = path.join(ROOT, 'storage', 'summaries');
const HOT_THRESHOLD = 50;
const MAX_SUMMARY = 120;
const MAX_DETAIL = 190;
// Bump when the entry shape or the prompt changes, so cached rows regenerate
// instead of silently serving the old schema.
const CACHE_VERSION = 4;

/* ── mechanical signals ─────────────────────────────────────────────────── */

const RE_CENSURE = /motion de censure/i;
const RE_FINAL = /^l['’]ensemble d/i;
const RE_REJET = /motion de rejet|question préalable/i;

/**
 * Facts-only component of the score. No model, no politics, no winner check.
 * @returns {{score:number, reasons:string[]}}
 */
export function mechanicalHeat(s) {
  const y = s.synthese ?? {};
  const reasons = [];
  let score = 0;

  if (RE_CENSURE.test(s.titre ?? '')) { score += 40; reasons.push('motion de censure'); }
  else if (RE_FINAL.test(s.titre ?? '')) { score += 15; reasons.push('vote sur l’ensemble du texte'); }
  else if (RE_REJET.test(s.titre ?? '')) { score += 10; reasons.push('motion de procédure'); }

  const exprimes = Number(y.exprimes) || 0;
  if (exprimes > 0) {
    const margin = Math.abs((Number(y.pour) || 0) - (Number(y.contre) || 0)) / exprimes;
    if (margin < 0.05) { score += 40; reasons.push('vote très serré'); }
    else if (margin < 0.10) { score += 30; reasons.push('vote serré'); }
  }

  const effectif = Number(s.effectif) || 577;
  const turnout = (Number(y.votants) || 0) / effectif;
  if (turnout > 0.6) { score += 15; reasons.push('forte participation'); }

  return { score, reasons };
}

/* ── cache ──────────────────────────────────────────────────────────────── */

function cachePath(s) {
  return path.join(DIR, String(s.legislature ?? 17), `${s.numero}.json`);
}

export async function readCached(s) {
  try {
    const v = JSON.parse(await fs.readFile(cachePath(s), 'utf8'));
    return v?.v === CACHE_VERSION ? v : null;   // stale schema → recompute
  } catch { return null; }
}

async function writeCached(s, value) {
  const p = cachePath(s);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(value));
}

/* ── model pass: summary + salience, batched ────────────────────────────── */

function buildPrompt(items) {
  const list = items
    .map((s) => `- numero ${s.numero} | ${String(s.titre).replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');
  return `Pour chaque scrutin de l'Assemblée nationale ci-dessous, produis un résumé en UNE phrase courte et un score de saillance publique.

SCRUTINS :
${list}

RÉSUMÉ — règles :
- Français simple, ${MAX_SUMMARY} caractères maximum, une seule phrase sans point final.
- Dis DE QUOI PARLE LE TEXTE, en langage courant, comme à quelqu'un qui ne suit pas la politique.
- Purement descriptif. Aucun groupe politique nommé. Aucun jugement, aucune conséquence, aucune intention prêtée à quiconque.
- N'indique NI le résultat du vote NI les chiffres : ils sont affichés à côté.

DÉTAIL — règles (le champ "detail") :
- Français simple, ${MAX_DETAIL} caractères maximum, une ou deux phrases.
- Dis CE QUE LE TEXTE CHANGE CONCRÈTEMENT : quelles mesures, quelles obligations ou quels droits, et POUR QUI (quelles personnes, quels organismes, à partir de quand si le titre le précise).
- Reste strictement descriptif : décris le contenu du texte, PAS ses effets supposés, PAS son opportunité, PAS qui y gagne ou y perd.
- Interdits : jugement, conséquence prédite, intention prêtée à quiconque, groupe politique nommé, résultat du vote, chiffres du vote.
- Si le titre officiel ne permet pas d'en dire plus sans inventer, renvoie une chaîne vide plutôt que de broder.

SAILLANCE (0 à 3) — à quel point le sujet touche la vie quotidienne des gens :
  3 = concerne directement une grande partie de la population (santé, école, impôts, retraites, salaires, logement, sécurité, numérique grand public)
  2 = concerne un secteur ou un groupe important
  1 = technique mais avec un effet concret
  0 = purement procédural ou très technique
Juge le SUJET, jamais le camp politique.

Réponds UNIQUEMENT par un tableau JSON : [{"numero": 1234, "resume": "…", "detail": "…", "salience": 2}, …]`;
}

/**
 * Fill summaries for the given normalized scrutins. Never throws; anything that
 * fails simply has no summary and falls back to mechanical heat alone.
 * @returns {Promise<Map<number, object>>}
 */
export async function summarize(items) {
  const out = new Map();
  const todo = [];

  for (const s of items) {
    const cached = await readCached(s);
    if (cached) out.set(s.numero, cached);
    else todo.push(s);
  }
  if (todo.length === 0) return out;

  let rows = [];
  try {
    const raw = await runJSON(buildPrompt(todo), {
      model: 'haiku',
      channel: 'scrutin',
      tools: [],
      cache: true,
      timeoutMs: 120_000,
      label: 'scrutin.summarize',
    });
    rows = Array.isArray(raw) ? raw : Array.isArray(raw?.scrutins) ? raw.scrutins : [];
  } catch {
    rows = [];
  }

  const byNum = new Map(rows.map((r) => [Number(r?.numero), r]));
  for (const s of todo) {
    const r = byNum.get(s.numero);
    const entry = buildEntry(s, r);
    out.set(s.numero, entry);
    await writeCached(s, entry);
  }
  return out;
}

function buildEntry(s, r) {
  const { score: mech, reasons } = mechanicalHeat(s);

  let resume = typeof r?.resume === 'string' ? r.resume.trim().replace(/\s+/g, ' ') : '';
  if (resume.length > MAX_SUMMARY) resume = resume.slice(0, MAX_SUMMARY).replace(/\s+\S*$/, '') + '…';

  // The summary describes the bill, so the official title is exempt as verbatim
  // and length limits don't apply — but the "no group named / no judgement"
  // rules do, and a violation drops the summary rather than publishing it.
  if (resume) {
    const v = checkNeutrality(resume, { minLen: 0, maxLen: MAX_SUMMARY + 10, verbatim: [s.titre] });
    if (!v.ok) {
      resume = '';
      reasons.push(`résumé écarté (${explain(v)})`);
    }
  }

  let detail = typeof r?.detail === 'string' ? r.detail.trim().replace(/\s+/g, ' ') : '';
  if (detail.length > MAX_DETAIL) detail = detail.slice(0, MAX_DETAIL).replace(/\s+\S*$/, '') + '…';
  if (detail) {
    const v = checkNeutrality(detail, { minLen: 0, maxLen: MAX_DETAIL + 10, verbatim: [s.titre] });
    if (!v.ok) {
      detail = '';
      reasons.push(`détail écarté (${explain(v)})`);
    }
  }

  const salience = Math.max(0, Math.min(3, Number(r?.salience) || 0));
  const score = Math.min(100, mech + salience * 10);
  if (salience >= 2) reasons.push('sujet à fort impact quotidien');

  return {
    v: CACHE_VERSION,
    numero: s.numero,
    resume: resume || null,
    detail: detail || null,
    salience,
    heat: score,
    hot: score >= HOT_THRESHOLD,
    why: reasons,
  };
}
