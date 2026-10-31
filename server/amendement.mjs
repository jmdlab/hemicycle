// amendement.mjs — what an amendment put to the vote actually changes.
//
// The official title of an amendment ballot says who tabled it and where it
// goes (« l'amendement n° 1358 de M. Lhardit après l'article 15 du projet de loi
// de finances pour 2027 ») and nothing about what it does. JM, 31/10, on the page
// of that ballot: « Zero context zero info ». This module reads the amendment
// itself — its dispositif (the text that would apply) and its exposé sommaire
// (the authors' own case) — and writes a short, neutral account of it.
//
// Same guarantees as the bill note (consequence.mjs), same gates:
//   · read from the AN's own file for that one amendment (~20 KB, by uid —
//     the uid is already on disk from the amendments refresh, so no archive);
//   · the model is named explicitly (sonnet: reading law text), tools off;
//   · tone: checkNeutrality; facts: every figure in the output must appear in
//     the source, and the vocabulary must be anchored in it (checkAnchoring);
//   · saying nothing is always allowed; a missing source is said, not filled.
//
// Cached per amendment uid. A public visitor never triggers a model call: the
// page only READS the cache; scripts/backfill-amendements-contexte.mjs writes it.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { amendementRefs, AMENDEMENT_UID_RE } from './data/amendements.mjs';
import { checkNeutrality, explain } from './neutrality.mjs';
import { checkAnchoring } from './consequence.mjs';

const require = createRequire(import.meta.url);
const CLI_PATH = process.env.SCRUTIN_CLAUDE_CLI || '/home/ubuntu/www/denis.me/river-brain/lib/claude-cli.cjs';
const runJSON = (...a) => require(CLI_PATH).runJSON(...a);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AMDT_DIR = path.join(ROOT, 'storage', 'amendements');
export const CONTEXTE_DIR = path.join(ROOT, 'storage', 'amendements-contexte');
const DEPUTES_FILE = path.join(ROOT, 'storage', 'index', 'deputes.json');
export const CONTEXTE_VERSION = 1;
export const MODEL = 'sonnet';

const MAX_TITRE = 80;
const MAX_RESUME = 620;
const MAX_DISPOSITIF = 12_000;
const MAX_EXPOSE = 8_000;
/** A source that was not there yet is asked again after this long. */
export const ABSENT_RETRY_MS = 12 * 3600_000;
/** Bumped when the checks change: refusals made under older checks are retried. */
export const GATES_VERSION = 2;

export const anUrl = (uid) => `https://www.assemblee-nationale.fr/dyn/17/amendements/${uid}`;
const anJsonUrl = (uid) => `https://www.assemblee-nationale.fr/dyn/opendata/${uid}.json`;

/* ── which amendment a ballot is about ─────────────────────────────────── */

// Dossier files are read per page view; memoised on mtime (the nightly refresh rewrites them).
const dossierMemo = new Map();
function dossierAmendements(dlr) {
  if (!/^DLR[0-9A-Z]+$/.test(String(dlr ?? ''))) return [];
  const file = path.join(AMDT_DIR, `${dlr}.json`);
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return []; }
  const hit = dossierMemo.get(dlr);
  if (hit?.mtime === mtime) return hit.list;
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8'))?.amendements ?? []; } catch { /* unreadable = none */ }
  dossierMemo.set(dlr, { mtime, list });
  return list;
}

const day = (iso) => String(iso ?? '').slice(0, 10);
const nextDay = (iso) => {
  const d = new Date(`${day(iso)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * The amendment a ballot was about, from its title and dossier.
 * One number in the title (identical amendments: the first, flagged). The same
 * number can exist on several texts of one dossier (first and second reading):
 * only the one decided that day (or just after midnight) is taken; ambiguous = null.
 * @returns {null | {rec: object, identiques: boolean, autres: number[]}}
 */
export function amendementForScrutin(s, list = null) {
  if (!s?.titre || !s?.dossierRef) return null;
  const { nums, identiques } = amendementRefs(s.titre);
  if (nums.size === 0) return null;
  const [first, ...autres] = [...nums];
  const sous = /^(?:l'|l’|le |les )?sous-amendements?\b/i.test(String(s.titre).trim());
  const all = (list ?? dossierAmendements(s.dossierRef)).filter(
    (a) => a.numero === first && !!a.sousAmendement === sous,
  );
  if (!all.length) return null;
  // Ballots carry no text reference, so the date decides between readings: the amendment
  // decided that day (or the next, for a sitting past midnight), else the only one not yet
  // decided in the data. Two candidates left, or one decided another week: show nothing.
  const sameDay = all.filter((a) => day(a.dateSort) === day(s.date));
  const pool = sameDay.length
    ? sameDay
    : all.filter((a) => (a.dateSort ? day(a.dateSort) === nextDay(s.date) : true));
  if (pool.length !== 1) return null;
  // A sub-amendment's title also names its parent amendment: that second number is not an identical one.
  return { rec: pool[0], identiques: identiques || (!sous && autres.length > 0), autres };
}

/* ── author, article: plain words ──────────────────────────────────────── */

let deputesMemo = null;
function deputeByRef(ref) {
  if (!ref) return null;
  let mtime;
  try { mtime = fs.statSync(DEPUTES_FILE).mtimeMs; } catch { return null; }
  if (deputesMemo?.mtime !== mtime) {
    const map = new Map();
    try {
      for (const d of JSON.parse(fs.readFileSync(DEPUTES_FILE, 'utf8'))?.deputes ?? []) map.set(d.acteurRef, d);
    } catch { /* none */ }
    deputesMemo = { mtime, map };
  }
  return deputesMemo.map.get(ref) ?? null;
}

/** « APRÈS ART. 15 » → « après l’article 15 »; « ART. PREMIER » → « article premier ». */
export function articleEnClair(designation) {
  const t = String(designation ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  const m = /^(APR[ÈE]S|AVANT)\s+(?:L['’]\s*)?ART(?:ICLE)?\.?\s+(.+)$/i.exec(t);
  if (m) return `${/^av/i.test(m[1]) ? 'avant' : 'après'} l’article ${m[2].toLowerCase()}`;
  const a = /^ART(?:ICLE)?\.?\s+(.+)$/i.exec(t);
  if (a) return `article ${a[1].toLowerCase()}`;
  return t.charAt(0).toLowerCase() + t.slice(1).toLowerCase();
}

export function auteurEnClair(rec) {
  if (rec?.auteurType && rec.auteurType !== 'Député') {
    // Gouvernement, commission, rapporteur: the AN names the role, not a person.
    return { nom: rec.auteurType, groupe: null, slug: null };
  }
  const d = deputeByRef(rec?.auteurRef);
  if (!d) return null;
  return {
    nom: [d.civ, d.prenom, d.nom].filter(Boolean).join(' '),
    groupe: d.groupe?.abbrev ?? null,
    groupeNom: d.groupe?.nom ?? null,
    slug: d.slug ?? null,
  };
}

/* ── cache ──────────────────────────────────────────────────────────────── */

const UID_RE = AMENDEMENT_UID_RE;
function cachePath(uid) {
  if (!UID_RE.test(String(uid ?? ''))) throw new Error('uid invalide');
  const file = path.join(CONTEXTE_DIR, `${uid}.json`);
  if (path.dirname(file) !== path.resolve(CONTEXTE_DIR)) throw new Error('uid hors du cache');
  return file;
}

export function readContexte(uid) {
  if (!UID_RE.test(String(uid ?? ''))) return null;
  try {
    const v = JSON.parse(fs.readFileSync(cachePath(uid), 'utf8'));
    return v?.v === CONTEXTE_VERSION ? v : null;
  } catch { return null; }
}

async function writeContexte(uid, value) {
  await fsp.mkdir(CONTEXTE_DIR, { recursive: true });
  const file = cachePath(uid);
  const tmp = `${file}.tmp${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(value));
  await fsp.rename(tmp, file);
}

/** What the scrutin page shows, from the cache only. Null when the ballot is not on an amendment. */
export function amendementPourPage(s) {
  const hit = amendementForScrutin(s);
  if (!hit) return null;
  const { rec, identiques } = hit;
  const c = readContexte(rec.uid);
  return {
    numero: rec.numero,
    numeroLong: rec.numeroLong ?? null,
    sousAmendement: !!rec.sousAmendement,
    identiques,
    article: articleEnClair(rec.article),
    auteur: auteurEnClair(rec),
    url: anUrl(rec.uid),
    titre: c?.titre ?? null,
    resume: c?.resume ?? null,
    // Who wrote the summary: the model, or null for a fixed sentence (« Supprimer cet article »).
    redige: c?.resume ? (c.model ? 'modele' : 'regle') : null,
    // Said, never filled: no text from the AN yet, or nothing we could stand behind.
    etat: c?.resume ? 'ok' : c?.absent ? 'absent' : c ? 'ecarte' : 'attente',
  };
}

/** Extra words for the search index: subject and keywords, from the cache. */
export function motsPourRecherche(s) {
  const hit = amendementForScrutin(s);
  const c = hit ? readContexte(hit.rec.uid) : null;
  return c?.resume ? [c.titre, ...(c.motsCles ?? [])].filter(Boolean).join(' ') : '';
}

/* ── the source text ────────────────────────────────────────────────────── */

export function texteBrut(html) {
  return String(html ?? '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;|&rsquo;/g, '’').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/[ \t  ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

async function fetchSource(uid) {
  if (!UID_RE.test(String(uid ?? ''))) throw new Error('uid invalide');
  const res = await fetch(anJsonUrl(uid), {
    redirect: 'error', // the AN answers this URL directly; a redirect elsewhere is refused
    headers: { Accept: 'application/json', 'User-Agent': 'hemicycle.app (+https://hemicycle.app)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  const j = await res.json();
  const a = j?.amendement ?? j;
  if (a?.uid !== uid) throw new Error('uid inattendu');
  const c = a?.corps?.contenuAuteur ?? {};
  return {
    dispositif: texteBrut(c.dispositif),
    expose: texteBrut(c.exposeSommaire),
    codeLoi: a?.loiReference?.codeLoi ?? null,
    article: a?.pointeurFragmentTexte?.division?.articleDesignation ?? null,
  };
}

/* ── figures: nothing the source does not contain ──────────────────────── */

/** Numbers as written in French: « 0,055 », « 10 000 », « 1 358 » → "0.055", "10000", "1358". */
export function chiffres(text) {
  const out = new Set();
  const t = String(text ?? '').replace(/(\d)[\s  .](?=\d{3}\b)/g, '$1');
  for (const m of t.matchAll(/\d+(?:,\d+)?/g)) out.add(m[0].replace(',', '.').replace(/^0+(?=\d)/, ''));
  return out;
}

// What follows a number decides its size: « 10 M€ » and « 10 Md€ » are not the same figure.
const UNITES = [
  [/^\s*(?:%|pour ?cents?\b)/i, '%'],
  [/^\s*(?:md€|mds?\b|milliards?\b)/i, 'Md'],
  [/^\s*(?:m€|millions?\b)/i, 'M'],
  [/^\s*(?:€|euros?\b)/i, '€'],
];

function chiffresAvecUnite(text) {
  const t = String(text ?? '').replace(/(\d)[\s  .](?=\d{3}\b)/g, '$1');
  const out = [];
  for (const m of t.matchAll(/\d+(?:,\d+)?/g)) {
    const n = m[0].replace(',', '.').replace(/^0+(?=\d)/, '');
    const suite = t.slice(m.index + m[0].length, m.index + m[0].length + 16);
    const unite = UNITES.find(([re]) => re.test(suite))?.[1] ?? '';
    out.push({ n, unite });
  }
  return out;
}

/**
 * Every figure in `claim` appears in `source`, with the same unit when the claim gives one
 * (« 15 % » needs a « 15 % » in the source, not « 15 euros »). Returns the ones that do not.
 */
export function chiffresInventes(claim, source) {
  const src = chiffresAvecUnite(source);
  const avecUnite = new Set(src.map((f) => `${f.n}|${f.unite}`));
  const nus = new Set(src.map((f) => f.n));
  const bad = chiffresAvecUnite(claim)
    .filter((f) => (f.unite ? !avecUnite.has(`${f.n}|${f.unite}`) : !nus.has(f.n)))
    .map((f) => (f.unite ? `${f.n} ${f.unite}` : f.n));
  return [...new Set(bad)];
}

/* ── the model pass ─────────────────────────────────────────────────────── */

function buildPrompt(s, src, rec) {
  return `Tu expliques à un citoyen, en français simple, ce que change un amendement voté à l'Assemblée nationale.

TEXTE AMENDÉ : ${s.dossierTitre ?? '(inconnu)'}
EMPLACEMENT : ${src.article ?? rec.article ?? '(inconnu)'}${src.codeLoi ? ` — ${src.codeLoi}` : ''}

DISPOSITIF (le texte qui s'appliquerait — c'est ta source pour CE QUE FAIT l'amendement) :
${src.dispositif.slice(0, MAX_DISPOSITIF) || '(vide)'}

EXPOSÉ SOMMAIRE (écrit par les AUTEURS — ce sont leurs arguments et leurs estimations, pas des faits établis) :
${src.expose.slice(0, MAX_EXPOSE) || '(vide)'}

Produis trois champs :

"titre" (${MAX_TITRE} caractères max) — le SUJET de l'amendement en quelques mots, comme un titre de rubrique, sans verbe conjugué ni article initial. Exemple de forme : « Taxe sur les données numériques », « Suppression de la réduction d'impôt pour les dons ». Majuscule au premier mot seulement.

"resume" (2 à 4 phrases, ${MAX_RESUME} caractères max) — ce que l'amendement change concrètement : qui paie, qui reçoit, qui doit faire quoi, à partir de quand. Tire le mécanisme du DISPOSITIF. Si tu cites un montant, un taux ou un rendement qui vient de l'EXPOSÉ, attribue-le : « selon ses auteurs ». N'écris AUCUN chiffre qui ne figure pas mot pour mot dans le dispositif ou l'exposé.

"motsCles" (5 à 10 entrées) — les mots qu'un citoyen taperait pour retrouver cet amendement, y compris les noms courants (ex. pour une taxe par gigaoctet : « taxe gigaoctet », « taxe Go », « taxe GAFAM »). Seulement des mots qui décrivent le sujet, jamais un jugement.

RÈGLES ABSOLUES :
- Neutre : aucun jugement, aucun adjectif de valeur, aucune intention prêtée, aucun nom de parti ni de groupe politique, aucun nom de député.
- Ne dis pas si l'amendement a été adopté ou rejeté : la page l'affiche déjà.
- Si le dispositif est vide ou illisible, renvoie trois valeurs vides. Ne remplis jamais par supposition.

Réponds UNIQUEMENT par un objet JSON : {"titre": "…", "resume": "…", "motsCles": ["…"]}`;
}

const norm = (x) => String(x ?? '').trim().replace(/\s+/g, ' ');

/** Applies the gates to a model answer. Pure, so the tests can feed it. */
export function valider(raw, { s, src }) {
  const titre = norm(raw?.titre).replace(/[.\s]+$/, '');
  const resume = norm(raw?.resume);
  const motsCles = (Array.isArray(raw?.motsCles) ? raw.motsCles : [])
    .map(norm).filter((m) => m && m.length <= 40).slice(0, 10);
  if (!titre || !resume) return { ok: false, reason: 'aucun dispositif identifiable' };
  if (titre.length > MAX_TITRE || resume.length > MAX_RESUME * 1.15) return { ok: false, reason: 'trop long' };

  const source = `${src.dispositif}\n${src.expose}\n${s.titre ?? ''}\n${s.dossierTitre ?? ''}`;
  // The headline must be about this amendment: most of its words come from it.
  if (!titreAncre(titre, source)) return { ok: false, reason: 'titre sans rapport avec l’amendement' };
  const inventes = chiffresInventes(`${titre} ${resume}`, source);
  if (inventes.length) return { ok: false, reason: `chiffre absent de la source : ${inventes.slice(0, 3).join(', ')}` };

  const verdict = checkNeutrality(`${titre}. ${resume} ${motsCles.join(' ')}`, {
    minLen: 0,
    maxLen: MAX_TITRE + MAX_RESUME * 1.15 + 420,
    verbatim: [s.titre, s.dossierTitre],
    // The subject is the amendment, as in the bill note: « crée une taxe » is what a
    // text does, not a motive. Same mode, so speculation stays banned too.
    noSpeculation: true,
  });
  if (!verdict.ok) return { ok: false, reason: `écarté — ${explain(verdict)}` };

  // Against off-topic output (an instruction hidden in the exposé): the summary's
  // words must come from the amendment it claims to describe.
  // An amendment can be one line (« Supprimer cet article. »): a smaller source floor than a bill's.
  const anchor = checkAnchoring(resume, `${src.dispositif}\n${src.expose}`, { minSource: 12 });
  if (!anchor.ok) {
    return { ok: false, reason: `non attesté dans l'amendement (uni ${anchor.unigram.toFixed(2)}, bi ${anchor.bigram.toFixed(2)})` };
  }
  // Search words: one that shares nothing with the amendment, or carries a figure it lacks, is dropped.
  const base = `${source}\n${titre}\n${resume}`;
  const mots = motsCles.filter((m) => !chiffresInventes(m, source).length && partageUnMot(m, base));
  return { ok: true, titre, resume, motsCles: mots };
}

const fold = (x) => String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** Content words, cut to a 5-letter stem so « taxe/taxes », « numérique/numériques » meet. */
const racines = (x) => (fold(x).match(/[a-z]{4,}/g) ?? []).map((w) => w.slice(0, 5));

function titreAncre(titre, source) {
  const src = new Set(racines(source));
  const mots = racines(titre);
  if (!mots.length) return false;
  return mots.filter((w) => src.has(w)).length / mots.length >= 0.5;
}

function partageUnMot(mot, base) {
  const src = new Set(racines(base));
  const w = racines(mot);
  // A short acronym (« GAFAM », « TVA ») is kept only if the amendment writes it.
  if (!w.length) return fold(base).includes(fold(mot));
  return w.some((x) => src.has(x));
}

/**
 * « Supprimer cet article. » and its kin are their own summary: no model, no gate to fail.
 * Returns null for anything else.
 */
export function suppressionSimple(dispositif, article) {
  const t = fold(dispositif).replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  if (!/^supprimer (cet article|cette division|cet alinea|les alineas? [0-9a-z ,et-]+|l'alinea [0-9a-z ]+)$/.test(t)) return null;
  const ou = article ? ` (${article})` : '';
  if (/article|division/.test(t)) {
    return { titre: 'Suppression d’un article', resume: `L’amendement supprime l’article visé${ou} du texte en discussion.`, motsCles: ['suppression article'] };
  }
  return { titre: 'Suppression d’une partie d’un article', resume: `L’amendement supprime une partie de l’article visé${ou} : ${dispositif.trim()}`, motsCles: ['suppression alinéa'] };
}

/**
 * Reads the amendment behind a ballot and caches what it changes.
 * @returns {Promise<{status:'cached'|'ok'|'absent'|'ecarte'|'erreur'|'hors', reason?:string}>}
 */
export async function makeContexte(s, { force = false, run = runJSON, source = fetchSource, write = writeContexte } = {}) {
  const hit = amendementForScrutin(s);
  if (!hit) return { status: 'hors' };
  const { uid } = hit.rec;
  if (!UID_RE.test(String(uid ?? ''))) return { status: 'hors' };
  const prev = readContexte(uid);
  const stale = prev && (
    (prev.absent && Date.now() - Date.parse(prev.at) > ABSENT_RETRY_MS)
    // Any answer made under older checks (refused or published) is redone once they change.
    || ((prev.ecarte || prev.resume) && prev.model && prev.gates !== GATES_VERSION)
  );
  if (!force && prev && !stale) return { status: 'cached' };

  let src;
  try {
    src = await source(uid);
  } catch (e) {
    // A 404/410 is an amendment the AN does not serve (yet): asked again in 12 h, so one
    // missing file never sits at the head of the queue. 5xx and timeouts: retried next run.
    if (e?.status >= 400 && e.status < 500) {
      await write(uid, { v: CONTEXTE_VERSION, uid, absent: `amendement non publié (HTTP ${e.status})`, at: new Date().toISOString() });
      return { status: 'absent' };
    }
    return { status: 'erreur', reason: `source : ${e.message}` };
  }
  const at = new Date().toISOString();
  if (!src.dispositif) {
    await write(uid, { v: CONTEXTE_VERSION, uid, absent: 'texte de l’amendement pas encore publié', at });
    return { status: 'absent' };
  }

  const simple = suppressionSimple(src.dispositif, articleEnClair(src.article ?? hit.rec.article));
  if (simple) {
    await write(uid, { v: CONTEXTE_VERSION, uid, numero: hit.rec.numero, ...simple, model: null, at });
    return { status: 'ok' };
  }

  const prompt = buildPrompt(s, src, hit.rec);
  const ask = (text) => run(text, {
    model: MODEL,
    channel: 'scrutin',
    tools: [],
    timeoutMs: 180_000,
    label: 'scrutin.amendement',
  });
  let v;
  try {
    v = valider(await ask(prompt), { s, src });
    // One second chance, told why: a summary a few words too long is worth redoing, not losing.
    if (!v.ok) {
      v = valider(await ask(`${prompt}\n\nUne première réponse a été refusée (motif : ${v.reason}). Recommence en respectant strictement chaque consigne.`), { s, src });
    }
  } catch (e) {
    return { status: 'erreur', reason: `appel : ${String(e.message).slice(0, 120)}` };
  }
  if (!v.ok) {
    await write(uid, { v: CONTEXTE_VERSION, uid, ecarte: v.reason, gates: GATES_VERSION, model: MODEL, at });
    return { status: 'ecarte', reason: v.reason };
  }
  await write(uid, {
    v: CONTEXTE_VERSION, uid, numero: hit.rec.numero,
    titre: v.titre, resume: v.resume, motsCles: v.motsCles, gates: GATES_VERSION, model: MODEL, at,
  });
  return { status: 'ok' };
}
