// consequence.mjs — what the text actually sets up, and what follows from it.
//
// A bill's title states the intent of the people who wrote it. Showing only
// that repeats their framing, which is its own bias. This module reads the
// enacting articles and reports two things: the mechanism the text puts in
// place, quoted from the articles, and what necessarily follows from that
// mechanism.
//
// The line is drawn where entailment stops. "Platforms must verify users' age"
// entails "users must prove their age", which entails an identification step
// that also applies to adults — each step is forced by the previous one. What
// the authors "really want", what the system "could later be used for", and any
// alarm vocabulary are conjecture and are rejected by the validator.
//
// Two hard guarantees:
//   · the mechanism is QUOTED from the articles, so a wrong premise is visible
//     and checkable against the source rather than buried in a conclusion;
//   · saying nothing is always available and never penalised — a model asked to
//     find implications will otherwise find them everywhere.
//
// Its own call and its own cache, deliberately: a field that may legitimately
// refuse must not be able to take down the fields that work.

import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNeutrality, explain } from './neutrality.mjs';
import { texteForScrutin, textRefFor } from './texte.mjs';

const require = createRequire(import.meta.url);
// Loaded lazily, not at import: index.mjs pulls these modules in at boot for
// their cache-read paths, and a public service must not fail to start because a
// file in another project moved. Path overridable for the same reason.
const CLI_PATH = process.env.SCRUTIN_CLAUDE_CLI || '/home/ubuntu/www/denis.me/river-brain/lib/claude-cli.cjs';
const runJSON = (...a) => require(CLI_PATH).runJSON(...a);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'storage', 'consequences');
const CACHE_VERSION = 3;

const MAX_MECANISME = 460;
const MAX_CONSEQUENCE = 460;
// Enough of the enacting text to see the mechanism; the tail of a long bill is
// usually annexes and impact studies, which are not what we are reading for.
const MAX_ARTICLES = 24_000;
const MAX_EXPOSE = 6_000;

// Keyed by DOCUMENT, not by ballot: 3,487 ballots in 2026 rest on 73 distinct
// texts — one of them carries 422 of them. Reading a bill once and sharing the
// result across every ballot on it is the difference between 73 calls and 3,487.
function cachePath(ref) {
  return path.join(DIR, `${ref}.json`);
}

export async function readCachedByRef(ref) {
  if (!ref) return null;
  try {
    const v = JSON.parse(await fs.readFile(cachePath(ref), 'utf8'));
    return v?.v === CACHE_VERSION ? v : null;
  } catch { return null; }
}

/** For a ballot: resolve its document, then read that document's entry. */
export async function readCachedConsequence(s) {
  const ref = textRefFor(s?.dossierRef);
  return ref ? readCachedByRef(ref) : null;
}

async function write(ref, value) {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(cachePath(ref), JSON.stringify(value));
}

function buildPrompt(s, texte) {
  const articles = String(texte.articles ?? '').slice(0, MAX_ARTICLES);
  const expose = String(texte.expose ?? '').slice(0, MAX_EXPOSE);
  return `Tu lis le texte officiel d'une loi française pour en dégager le dispositif réel et ce qui en découle.

TITRE DU TEXTE : ${s.dossierTitre ?? s.titre}

EXPOSÉ DES MOTIFS (écrit par les auteurs du texte — c'est leur INTENTION, pas une description neutre) :
${expose || '(non disponible)'}

ARTICLES (le texte qui s'applique réellement — c'est ta SEULE source pour le mécanisme) :
${articles || '(non disponibles)'}

Produis deux champs :

"mecanisme" (${MAX_MECANISME} caractères max) — ce que le texte OBLIGE, INTERDIT ou CRÉE concrètement. Tire-le des ARTICLES, pas de l'exposé des motifs ni de tes connaissances. Formule-le en français simple. Exemple de forme : « impose aux plateformes de contrôler l'âge de leurs utilisateurs selon un référentiel fixé par l'Arcom ».

"consequence" (${MAX_CONSEQUENCE} caractères max) — ce qui découle NÉCESSAIREMENT de ce mécanisme, en une ou deux phrases. Va au bout du raisonnement, mais uniquement tant que chaque étape est contrainte par la précédente. Exemple de forme : « Contrôler l'âge suppose que chaque utilisateur en apporte la preuve : l'accès au service passe donc par une étape d'identification, y compris pour les adultes. »

RÈGLES ABSOLUES :
- Le mécanisme doit être vérifiable dans les articles ci-dessus. Si tu ne l'y trouves pas, renvoie deux chaînes vides.
- AUTORISÉ dans la conséquence : ce qui suit logiquement du dispositif ; qui se trouve concerné au-delà du public visé ; ce que le dispositif suppose pour fonctionner ; ce qu'il rend obligatoire ou impossible.
- INTERDIT : l'intention prêtée aux auteurs ; les usages futurs hypothétiques ; le jugement de valeur ; toute mention d'un parti ou d'un groupe politique.
- N'ÉVITE PAS un mot juste. Si le texte instaure un fichier, écris « fichier ». S'il s'applique à tout le monde, écris « à tous » ou « généralisé ». S'il impose une identification, écris « identification ». Décrire exactement ce que fait le texte n'est pas de l'alarmisme — c'est le contraire du jargon que cette page existe pour lever.
- SYMÉTRIE : le même regard pour tous les textes, quel que soit le sujet.
- **Deux chaînes vides sont une réponse parfaitement valide** et souvent la bonne. N'invente jamais pour remplir.

Réponds UNIQUEMENT par un objet JSON : {"mecanisme": "…", "consequence": "…"}`;
}

/**
 * @returns {Promise<{mecanisme:string|null, consequence:string|null, source:object|null, reason?:string}>}
 */
/* ── anchoring: the mechanism must be attested in the articles ──────────── */
//
// checkNeutrality filters TONE, never FACTS: a bill carrying a hidden
// instruction can produce a mechanism that is false but perfectly neutral, and
// so accepted. This compares the mechanism's VOCABULARY to the articles it was
// supposedly drawn from — a net against off-topic injection, not a semantic
// check. It does NOT catch a meaning inverted with the text's own words
// ("autorise" for "interdit"); that limit is deliberate and documented.
//
// Thresholds calibrated on the 67 cached mechanisms against their own article
// slice, then against 335 random slices: uni >= 0.35 AND bi >= 0.06 rejects
// 4.5% of legitimate mechanisms (3/67) and 100% of mechanisms paired with the
// wrong text. Neither threshold separates alone — the conjunction does. The
// module already holds that two empty strings are a valid answer, so the
// trade-off leans to refusal: a false negative costs a missing field, a false
// positive publishes a falsehood under the authority of the official text.
const ANCHOR_MIN_UNIGRAM = 0.35;
const ANCHOR_MIN_BIGRAM = 0.06;

const ANCHOR_STOP = new Set(
  ('les des une aux par pour dans sur avec sans sous vers chez plus tres ' +
   'tout toute tous toutes autre autres aussi ainsi apres avant entre dont ' +
   'est sont sera seront soit ete etes etant leur leurs cette ces son ses ' +
   'que qui quo lorsque meme non oui ils elle elles nous vous').split(/\s+/),
);

function anchorTokens(str) {
  return String(str ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[’ʼ`]/g, "'")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !ANCHOR_STOP.has(t));
}

function ngramSet(tokens, n) {
  const out = new Set();
  for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join('\u0001'));
  return out;
}

function coverage(claimTokens, sourceTokens, n) {
  const claim = ngramSet(claimTokens, n);
  if (claim.size === 0) return 0;
  const src = ngramSet(sourceTokens, n);
  let hit = 0;
  for (const g of claim) if (src.has(g)) hit++;
  return hit / claim.size;
}

/**
 * Is the mechanism attested in the articles?
 * @returns {{ok:boolean, unigram:number, bigram:number}}
 */
export function checkAnchoring(mecanisme, articles) {
  const claim = anchorTokens(mecanisme);
  const src = anchorTokens(articles);
  if (claim.length < 4 || src.length < 40) return { ok: false, unigram: 0, bigram: 0 };
  const unigram = coverage(claim, src, 1);
  const bigram = coverage(claim, src, 2);
  return { ok: unigram >= ANCHOR_MIN_UNIGRAM && bigram >= ANCHOR_MIN_BIGRAM, unigram, bigram };
}

export async function makeConsequence(s, { force = false } = {}) {
  const knownRef = textRefFor(s?.dossierRef);
  if (!force && knownRef) {
    const hit = await readCachedByRef(knownRef);
    if (hit) return hit;
  }

  const empty = (reason, source = null) => ({
    v: CACHE_VERSION, mecanisme: null, consequence: null, source, reason,
  });

  const texte = await texteForScrutin(s);
  if (!texte?.articles) {
    // NOT cached. A failed fetch is transient — one 500 from the Assemblée on a
    // given evening would otherwise become a permanent "texte indisponible",
    // since the batch skips any reference that already has an entry. Retried
    // every night; costs a fetch, never a model call, because without articles
    // there is nothing to send.
    return empty('texte indisponible');
  }
  const source = { ref: texte.ref, url: texte.url };

  let raw;
  try {
    raw = await runJSON(buildPrompt(s, texte), {
      model: 'sonnet',        // reading law and holding the entailment line
      channel: 'scrutin',
      tools: [],
      cache: true,
      timeoutMs: 180_000,
      label: 'scrutin.consequence',
    });
  } catch (e) {
    return empty(`appel échoué: ${e.message.slice(0, 120)}`, source);
  }

  const norm = (x) => String(x ?? '').trim().replace(/\s+/g, ' ');
  /** Slightly over → cut at the last sentence end. Grossly over → caller rejects. */
  const fit = (x, n) => {
    if (x.length <= n) return x;
    if (x.length > n * 1.6) return null;
    const cut = x.slice(0, n);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' : '));
    return stop > n * 0.5 ? cut.slice(0, stop + 1).trim() : cut.replace(/\s+\S*$/, '') + '…';
  };
  let mecanisme = fit(norm(raw?.mecanisme), MAX_MECANISME);
  let consequence = fit(norm(raw?.consequence), MAX_CONSEQUENCE);

  // Both halves or neither: a consequence without its stated premise is exactly
  // the unfalsifiable claim this design refuses.
  if (!mecanisme || !consequence) {
    const out = empty('aucun dispositif identifiable dans les articles', source);
    await write(texte.ref, out);
    return out;
  }
  const verdict = checkNeutrality(`${mecanisme} ${consequence}`, {
    minLen: 0,
    maxLen: MAX_MECANISME + MAX_CONSEQUENCE + 40,
    verbatim: [s.titre, s.dossierTitre],
    noSpeculation: true,
  });
  if (!verdict.ok) {
    const out = empty(`écarté — ${explain(verdict)}`, source);
    await write(texte.ref, out);
    return out;
  }

  // Anchoring AFTER neutrality: text that reads well but has nothing to do with
  // the articles is exactly what a hidden instruction in the PDF produces.
  // Compared to the SAME slice the model saw, never the full text it did not.
  const anchor = checkAnchoring(mecanisme, String(texte.articles ?? '').slice(0, MAX_ARTICLES));
  if (!anchor.ok) {
    const out = empty(
      `écarté — mécanisme non attesté dans les articles (uni ${anchor.unigram.toFixed(2)}, bi ${anchor.bigram.toFixed(2)})`,
      source,
    );
    await write(texte.ref, out);
    return out;
  }

  const out = { v: CACHE_VERSION, mecanisme, consequence, source };
  await write(texte.ref, out);
  return out;
}
