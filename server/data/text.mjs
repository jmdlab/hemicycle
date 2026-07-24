/**
 * Text utilities shared by the index builder and the query path.
 *
 * Both sides MUST fold identically, so tokenisation lives here rather than
 * being duplicated in the refresh script.
 */

/** Lowercase, strip diacritics, normalise the French apostrophe. */
export function fold(str) {
  return String(str ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’ʼ`]/g, "'");
}

/**
 * French stopwords, plus the parliamentary boilerplate that appears in nearly
 * every title ("amendement", "article", "monsieur"...). Terms carrying no
 * discriminating power in a corpus that is 100 % ballot titles.
 */
export const STOPWORDS = new Set(
  (
    "a au aux avec ce ces dans de des du elle en et eux il je la le les leur lui ma mais me meme mes " +
    "moi mon ne nos notre nous on ou par pas pour qu que qui sa se ses son sur ta te tes toi ton tu " +
    "un une vos votre vous c d j l m n s t y ete etee etees etes etant suis es est sommes etes sont " +
    "sera seront soit dont ainsi apres avant entre sans sous vers chez plus tres tout toute tous toutes " +
    "autre autres meme n° no num numero mme mm mr m. article articles alinea alineas texte " +
    "commission president presidente collegues leurs"
  ).split(/\s+/),
);

/**
 * Light French stemmer — de-pluralise + a couple of high-frequency endings.
 * Applied to BOTH index and query (inside tokenize) so the two sides fold
 * identically. Deliberately conservative: romance languages over-stem easily,
 * so this only collapses the plural/derivation noise that made "réseaux
 * sociaux" and "réseau social" miss each other.
 */
export function stemFr(w) {
  if (w.length < 5) return w;
  if (w.endsWith("eaux")) return w.slice(0, -1); // reseaux -> reseau
  if (w.endsWith("aux")) return w.slice(0, -3) + "al"; // sociaux -> social
  if (w.endsWith("s") || w.endsWith("x")) return w.slice(0, -1); // pluriels
  return w;
}

/** Fold, split on non-letters, drop stopwords and 1-char noise, then stem. */
export function tokenize(str) {
  const out = [];
  for (const raw of fold(str).split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(stemFr(raw));
  }
  return out;
}

/**
 * Query-only synonym expansion: the words citizens type ("euthanasie") vs the
 * legislative wording ("droit à l'aide à mourir"). Keys and values are the
 * FOLDED + STEMMED forms, matching tokenize() output. Small curated set of the
 * hot mismatches; expansion only ADDS terms, never removes.
 */
const SYNONYMS = {
  euthanasie: ["aide", "mourir"],
  suicide: ["aide", "mourir"],
  drogue: ["stupefiant", "narcotrafic", "trafic"],
  stupefiant: ["narcotrafic", "drogue"],
  narcotrafic: ["stupefiant", "trafic"],
  voile: ["laicite"],
  smic: ["salaire", "minimum"],
  gpa: ["procreation"],
  pma: ["procreation"],
  climat: ["climatique", "environnement"],
  // Immigration: the corpus never uses the word "immigration" itself — the
  // ballots are titled "étrangers" / "séjour". So the synonyms must point at
  // the tokens that actually have postings, not at a dead term.
  immigration: ["etranger", "sejour"],
  immigre: ["etranger", "sejour"],
  etranger: ["sejour"],
  asile: ["etranger", "sejour"],
  // Budget: official wording is "loi de finances" — "budget"/"PLF" have no
  // postings, so map them onto the live "finance"/"financement" stems.
  budget: ["finance", "financement"],
  plf: ["finance", "financement"],
};

export function expandSynonyms(terms) {
  const out = [...terms];
  for (const t of terms) {
    const syn = SYNONYMS[t];
    if (!syn) continue;
    for (const s of syn) if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** Bounded Levenshtein: returns a number > max as soon as it is exceeded. */
export function levenshtein(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const BILL_RE = /((?:projets?|propositions?) de (?:loi|resolution)(?:\s+(?:organique|constitutionnelle|de\s+financement|de\s+finances))?[^,;()]*)/;

/**
 * Cluster key: the underlying bill a ballot belongs to.
 *
 * Titles name their bill even for amendments ("l'amendement n° 12 ... du projet
 * de loi de finances pour 2026"), so one regex clusters final votes together
 * with every amendment voted on the same text. Yields ~277 distinct bills
 * across L17.
 */
export function extractBill(titre) {
  const folded = fold(titre);
  const m = BILL_RE.exec(folded);
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '') || null;
}

const READINGS = [
  [/commission mixte paritaire/, 'CMP'],
  [/lecture definitive/, 'lecture définitive'],
  [/nouvelle lecture/, 'nouvelle lecture'],
  [/deuxieme lecture/, 'deuxième lecture'],
  [/premiere lecture/, 'première lecture'],
];

/** Which reading of the bill this ballot belongs to, when stated. */
export function extractReading(titre) {
  const folded = fold(titre);
  for (const [re, label] of READINGS) if (re.test(folded)) return label;
  return null;
}

/**
 * Is this the final vote on the whole text ("vote solennel sur l'ensemble")?
 * These are the ballots a citizen almost always means, yet they are only ~2.6 %
 * of the corpus (221 of 8 433) — the rest are amendments and procedural votes.
 */
export function isFinalVote(titre) {
  return /^l'ensemble\b/.test(fold(titre).trim());
}

/** Detects `loi n° 2024-1177` and friends; returns a normalised codeLoi. */
export function extractLawCode(query) {
  const f = fold(query);
  const m = /\b(?:loi\s*)?n[°o]?\s*(\d{4})\s*[-–—]\s*(\d{1,4})\b/.exec(f) || /\b(\d{4})[-–—](\d{1,4})\b/.exec(f);
  if (!m) return null;
  return `${m[1]}-${Number.parseInt(m[2], 10)}`;
}
