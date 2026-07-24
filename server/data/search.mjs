/**
 * Query resolution: free text / number / law reference -> candidate ballots.
 *
 * Design constraint: this layer NEVER decides for the caller. 76 % of L17
 * ballots are amendments and a single bill can be voted a dozen times across
 * several readings, so "the vote on X" is usually ambiguous. When more than one
 * bill or more than one reading matches we return the shortlist plus a note and
 * set `ambiguous`, leaving the pick to the caller.
 */

import { tokenize, expandSynonyms, levenshtein, extractBill, extractReading, isFinalVote, extractLawCode } from './text.mjs';
import { loadIndex, docByNumero } from './store.mjs';

const K1 = 1.2;
const B = 0.75;
const MAX_CANDIDATES = 8;

/** Weight applied to final "vote on the whole text" ballots. */
const FINAL_VOTE_BOOST = 2.5;

/**
 * Build the BM25 postings from normalized records.
 * Kept next to the scorer so indexing and querying can never drift apart.
 */
export function buildSearchIndex(records) {
  const docs = [];
  const postings = Object.create(null);
  let totalLen = 0;

  records.forEach((rec, i) => {
    const terms = tokenize(`${rec.titre} ${rec.dossierTitre || ''}`);
    totalLen += terms.length;

    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [term, freq] of tf) {
      (postings[term] || (postings[term] = [])).push([i, freq]);
    }

    docs.push({
      numero: rec.numero,
      legislature: rec.legislature,
      titre: rec.titre,
      date: rec.date,
      sort: rec.sort,
      pour: rec.synthese.pour,
      contre: rec.synthese.contre,
      abstentions: rec.synthese.abstention,
      len: terms.length,
      bill: extractBill(rec.titre),
      reading: extractReading(rec.titre),
      final: isFinalVote(rec.titre),
      dossierRef: rec.dossierRef,
      sourceUrl: rec.sourceUrl,
    });
  });

  return {
    builtAt: new Date().toISOString(),
    docCount: docs.length,
    avgdl: docs.length ? totalLen / docs.length : 0,
    docs,
    postings,
  };
}

function bm25(index, queryTerms) {
  const { docs, postings, avgdl } = index;
  const N = docs.length;
  const scores = new Map();

  for (const term of new Set(queryTerms)) {
    const list = postings[term];
    if (!list) continue;
    const df = list.length;
    // Lucene-style IDF: always positive, so a term matching most documents
    // contributes little instead of penalising the document.
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (const [docIdx, freq] of list) {
      const dl = docs[docIdx].len || 1;
      const denom = freq + K1 * (1 - B + (B * dl) / (avgdl || 1));
      scores.set(docIdx, (scores.get(docIdx) || 0) + idf * ((freq * (K1 + 1)) / denom));
    }
  }
  return scores;
}

const toCandidate = (doc, score) => ({
  numero: doc.numero,
  legislature: doc.legislature,
  titre: doc.titre,
  date: doc.date,
  sort: doc.sort,
  pour: doc.pour,
  contre: doc.contre,
  abstentions: doc.abstentions,
  score: Math.round(score * 1000) / 1000,
  bill: doc.bill,
  reading: doc.reading,
  final: doc.final,
  sourceUrl: doc.sourceUrl,
});

/** For query terms with no posting, substitute the closest vocab term (typo
 *  tolerance). Vocab is ~4 000 terms, so a bounded scan per unmatched term is
 *  sub-millisecond. */
function fuzzyExpand(index, terms) {
  const vocab = Object.keys(index.postings);
  const out = [...terms];
  for (const t of terms) {
    if (t.length < 5 || index.postings[t]) continue;
    // A distance-2 edit on a short word rewrites a third of it — that's how
    // "budget" (6) silently became "buffet" and pulled in cadmium ballots.
    // Reserve distance-2 for long words (real typos like "narcotafic"); short
    // words only accept a single-char correction. Semantic gaps are the
    // synonym table's job, not the typo corrector's.
    const maxD = t.length >= 8 ? 2 : 1;
    let best = null, bestD = maxD + 1;
    for (const v of vocab) {
      const d = levenshtein(t, v, maxD);
      if (d < bestD) { bestD = d; best = v; if (d === 1) break; }
    }
    if (best && !out.includes(best)) out.push(best);
  }
  return out;
}

/** Free-text topic search: BM25, final-vote boost, then one entry per bill. */
function topicSearch(index, query) {
  // Cap the term count before fuzzyExpand: it scans the whole vocab per unmatched
  // term, so an adversarial 1000-word query would block the (single-threaded)
  // event loop. 12 terms is far more than any real question.
  let terms = expandSynonyms(tokenize(query).slice(0, 12));
  if (terms.length) terms = fuzzyExpand(index, terms);
  if (!terms.length) return { candidates: [], note: 'Requête vide après filtrage des mots outils.' };

  const scores = bm25(index, terms);
  if (!scores.size) return { candidates: [], note: null };

  const ranked = [...scores.entries()]
    .map(([i, s]) => {
      const doc = index.docs[i];
      return { doc, score: doc.final ? s * FINAL_VOTE_BOOST : s };
    })
    .sort((a, b) => b.score - a.score || b.doc.numero - a.doc.numero);

  // Collapse to the best ballot per bill first: showing eight amendments to the
  // same text is useless, showing the final vote on eight bills is the answer.
  const best = [];
  const seenBill = new Set();
  const overflow = [];
  for (const r of ranked) {
    const key = r.doc.bill || `#${r.doc.numero}`;
    if (seenBill.has(key)) {
      if (overflow.length < MAX_CANDIDATES) overflow.push(r);
      continue;
    }
    seenBill.add(key);
    best.push(r);
    if (best.length >= MAX_CANDIDATES) break;
  }

  const picked = best.concat(overflow).slice(0, MAX_CANDIDATES);
  return {
    candidates: picked.map((r) => toCandidate(r.doc, r.score)),
    bills: [...seenBill],
  };
}

/**
 * @param {string} query
 * @param {object} [opts]
 * @param {object} [opts.index] - preloaded index (defaults to storage/index)
 * @returns {{interpretation, candidates, ambiguous, note}}
 */
export function resolve(query, opts = {}) {
  const index = opts.index || loadIndex();
  const q = String(query ?? '').trim().slice(0, 200);

  if (!q) {
    return { interpretation: 'topic', candidates: [], ambiguous: false, note: 'Requête vide.' };
  }

  // 1. Pure digits -> scrutin number, no search at all.
  if (/^\d+$/.test(q)) {
    const numero = Number.parseInt(q, 10);
    const doc = docByNumero(index, numero);
    return {
      interpretation: 'numero',
      candidates: doc ? [toCandidate(doc, 1)] : [],
      ambiguous: false,
      note: doc ? null : `Aucun scrutin n°${numero} dans la 17e législature.`,
    };
  }

  // 2. Law reference -> promulgated-law path.
  const code = extractLawCode(q);
  if (code && /\bloi\b|n\s*°|^\s*\d{4}\s*-/.test(q.toLowerCase())) {
    const law = (index.laws || {})[code];
    if (!law) {
      return {
        interpretation: 'reference',
        candidates: [],
        ambiguous: false,
        note: `Aucune loi n° ${code} promulguée sous la 17e législature dans les données ouvertes.`,
        codeLoi: code,
      };
    }
    const docs = (law.scrutins || [])
      .map((n) => docByNumero(index, n))
      .filter(Boolean);
    const candidates = docs
      .sort((a, b) => Number(b.final) - Number(a.final) || b.numero - a.numero)
      .slice(0, MAX_CANDIDATES)
      .map((d) => toCandidate(d, 1));
    return {
      interpretation: 'reference',
      candidates,
      ambiguous: candidates.length > 1,
      codeLoi: code,
      note: candidates.length
        ? null
        : `La loi n° ${code} (« ${law.titreLoi || law.dossierRef} ») n'a pas de scrutin public associé.`,
    };
  }

  // 3. Topic search.
  let { candidates, note, bills } = topicSearch(index, q);
  // Entity axis — year: "budget 2026" narrows to 2026 ballots (the year token
  // also feeds BM25, this just makes it decisive when present). Never empties
  // the result: if nothing matches the year, keep the unfiltered shortlist.
  const yearM = q.match(/\b(20\d{2})\b/);
  if (yearM) {
    const inYear = candidates.filter((c) => String(c.date).startsWith(yearM[1]));
    if (inYear.length) candidates = inYear;
  }
  const distinctBills = new Set(candidates.map((c) => c.bill || `#${c.numero}`));
  const distinctReadings = new Set(candidates.map((c) => c.reading).filter(Boolean));
  // Confidence = how far the top hit stands above the runner-up. When it
  // dominates (>=2x, or it is the only real hit) we auto-select even if several
  // bills matched; ambiguity is reserved for genuine near-ties. This kills the
  // old behaviour where a clearly-winning result (8431 at 38 vs 14) still forced
  // the picker just because >1 bill appeared.
  const top = candidates[0]?.score || 0;
  const second = candidates[1]?.score || 0;
  const dominant = candidates.length === 1 || (top > 0 && (second === 0 || top / second >= 2));
  const ambiguous = !dominant && (distinctBills.size > 1 || distinctReadings.size > 1);

  let finalNote = note ?? null;
  if (!finalNote && !candidates.length) finalNote = 'Aucun scrutin ne correspond à cette recherche.';
  else if (!finalNote && ambiguous) {
    const parts = [];
    if (distinctBills.size > 1) parts.push(`${distinctBills.size} textes différents`);
    if (distinctReadings.size > 1) parts.push(`${distinctReadings.size} lectures différentes`);
    finalNote = `Résultat ambigu : ${parts.join(' et ')} correspondent. Aucun scrutin n'est sélectionné automatiquement.`;
  }

  return {
    interpretation: 'topic',
    candidates,
    ambiguous,
    note: finalNote,
    ...(bills ? { matchedBills: bills.length } : {}),
  };
}
