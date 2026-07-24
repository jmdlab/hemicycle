// neutrality.mjs — political-neutrality validator for every string this app emits.
//
// The app publishes to a public surface (an image + a tweet) about parliamentary
// votes. The owner's hard requirement: no bias for or against any party.
//
// Design principle learned the hard way: bias hides in SELECTION, not only in
// wording. "The most absent group is X" has no neutral phrasing — the argmax is
// the bias. So the rules below ban not just loaded words but also superlatives,
// rankings, and naming a subset of groups.
//
// IMPLEMENTATION LANDMINE (cost us a full false-positive rate once):
// naive substring matching for "semble" matches inside "ASSEMBLÉE" — and every
// single tweet contains "Assemblée nationale". Every pattern here is therefore a
// \b-anchored regex applied to ACCENT-FOLDED text, never a substring `includes`.

/** Strip accents + lowercase so patterns match regardless of diacritics. */
export function fold(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// L17 political groups — abbreviations and full names. A tweet must name NONE:
// the chart already shows every group symmetrically, so prose never needs one.
const GROUP_ABBREVS = [
  'RN', 'EPR', 'LFI-NFP', 'LFI', 'NFP', 'SOC', 'DR', 'EcoS', 'DEM', 'HOR',
  'LIOT', 'GDR', 'UDR', 'UDDPLR', 'NI',
];
const GROUP_NAMES = [
  'rassemblement national',
  'ensemble pour la republique',
  'la france insoumise',
  'socialistes et apparentes',
  'droite republicaine',
  'ecologiste et social',
  'les democrates',
  'horizons',
  'libertes, independants, outre-mer et territoires',
  'gauche democrate et republicaine',
  'union des droites pour la republique',
  'deputes non inscrits',
];

// Three families of banned language. All matched \b-anchored on folded text.
const BANNED = [
  // --- characterising adjectives / loaded nouns ---
  ['adjectif',   /\b(extreme|extremiste|radical|radicale|populiste|macroniste|lepeniste|melenchoniste|frontiste|gauchiste|droitiste|centriste|reactionnaire|progressiste)\b/],
  // --- motive attributed to PEOPLE ---
  ['intention',  /\b(choisi|choisit|choisir|veut|veulent|vouloir|prefere|preferent|grace a|sous pretexte)\b/],
  // --- ranking, superlative, comparison across groups ---
  // The lookahead keeps age and quantity brackets out of it: "les moins de
  // 15 ans" is the category a law applies to, not a ranking of anyone.
  ['classement', /\b(le plus|la plus|les plus|le moins|la moins|les moins)(?!\s+de\s+\d)\b|\b(en tete|record|champion|pire|meilleur|meilleure|loin devant|davantage que|plus que les)\b/],
  // --- significance, consequence, editorialising ---
  ['portee',     /\b(decisif|decisive|historique|camouflet|desaveu|tournant|coup dur|revers|victoire|defaite|echec|triomphe|desapprobation)\b/],
  // --- hedging / speculation ---
  ['speculation',/\b(semble|semblent|sans doute|probablement|on peut penser|laisse penser)\b/],
  // --- combative result verbs (result must use the AN's own word) ---
  ['verbe_resultat', /\b(echoue|echouent|s'effondre|effondre|emporte|balaye|balaie|ecrase|torpille|enterre|sauve)\b/],
];

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}]/u;

/**
 * What a TEXT does, as opposed to what a person wants. "Le texte permet à
 * l'autorité de…" is the ordinary legal verb for describing a provision, and
 * banning it made the mechanism undescribable. Rejected where the subject is a
 * person (a caption about a vote), allowed where the subject is the text itself
 * (the mechanism note), which is the only place `noSpeculation` is set.
 */
const TEXT_EFFECT = /\b(permet|permettre|permettent|autorise|autorisent|empeche|empechent|empecher|oblige|obligent|interdit|interdisent|impose|imposent|cree|creent)\b/;

/**
 * Extra rules for the "what follows from this" note.
 *
 * That note is allowed to do something the rest of the app never does: follow a
 * mechanism to its necessary consequence. Requiring age verification entails
 * that users prove identity — that is deduction, not conjecture, and refusing to
 * say it leaves the reader with only the sponsor's framing, which is its own
 * bias.
 *
 * The line is drawn exactly where entailment stops: intent behind the text,
 * predictions about future misuse, and alarm vocabulary are all conjecture
 * dressed as fact. Banned here, matched on accent-folded text.
 */
const SPECULATION = [
  ['intention_cachee', /\b(but cache|objectif cache|vise en realite|vise surtout|sous couvert|sous pretexte|pretexte|veritable but|en realite il s'agit|permettrait de)\b/],
  ['usage_futur',      /\b(pourra etre utilise|pourrait etre utilise|ouvre la voie|ouvre la porte|risque de deriver|pente glissante|premier pas vers|finira par)\b/],
  // Rhetoric only. Words that DESCRIBE a mechanism accurately — généralisé,
  // massif, fichier, identification, surveillance — are facts when the text says
  // so, and banning them left the note unable to state what the law actually
  // does. What stays banned is the vocabulary that evaluates instead of
  // describing.
  ['alarme',           /\b(liberticide|flicage|big brother|orwellien|scandale|scandaleux|alarmant|effrayant|terrifiant)\b/],
  ['jugement_valeur',  /\b(heureusement|malheureusement|hélas|bien sur|evidemment|il faut noter|on notera|force est de constater)\b/],
];

/**
 * Validate a public-facing string.
 * @param {string} text
 * @param {{maxLen?:number, minLen?:number, allowGroups?:boolean}} opts
 * @returns {{ok:boolean, violations:{rule:string,detail:string}[]}}
 */
export function checkNeutrality(text, opts = {}) {
  const {
    maxLen = 260, minLen = 60, allowGroups = false, verbatim = [],
    // Applies the entailment/conjecture boundary described above. Only the
    // consequence note sets this.
    noSpeculation = false,
  } = opts;
  const v = [];
  const t = String(text ?? '');

  // Verbatim exemption: the official scrutin title is the Assemblée's own
  // wording. Quoting it is factual transcription, not our editorial voice — a
  // bill literally titled "…visant à lutter contre l'extrémisme" must not be
  // rejected for containing a word from our list. We mask those exact spans
  // before the language checks (length/emoji/hashtag checks still see the whole
  // string). Only strings WE supply from the AN payload may be exempted, never
  // model output, so this cannot be used to smuggle bias.
  // Masking must survive TRUNCATION: captions shorten long official titles, so
  // the full string is often absent while a prefix of it is present. We locate a
  // short probe then extend character-by-character while the two still agree,
  // comparing folded chars so accents and case never break the match.
  let scan = t;
  for (const q of verbatim) {
    if (!q || q.length < 12) continue;
    const fq = fold(q);
    const i = fold(scan).indexOf(fq.slice(0, 12));
    if (i < 0) continue;
    let n = 0;
    while (n < fq.length && i + n < scan.length && fold(scan[i + n]) === fq[n]) n++;
    scan = scan.slice(0, i) + ' '.repeat(n) + scan.slice(i + n);
  }
  const f = fold(scan);

  if (t.length < minLen) v.push({ rule: 'longueur', detail: `${t.length} < ${minLen}` });
  if (t.length > maxLen) v.push({ rule: 'longueur', detail: `${t.length} > ${maxLen}` });

  if (t.includes('#')) v.push({ rule: 'hashtag', detail: 'caractère #' });
  if (t.includes('@')) v.push({ rule: 'mention', detail: 'caractère @' });
  if (/https?:\/\//i.test(t)) v.push({ rule: 'lien', detail: 'URL dans le texte (la source va en réponse)' });
  if (t.includes('!')) v.push({ rule: 'ponctuation', detail: 'point d’exclamation' });
  if (t.includes('?')) v.push({ rule: 'ponctuation', detail: 'point d’interrogation' });
  if (EMOJI.test(t)) v.push({ rule: 'emoji', detail: 'emoji détecté' });

  for (const [rule, re] of BANNED) {
    // The superlative ban exists because ranking political GROUPS is bias by
    // selection — the argmax is the editorial claim. The note about a text
    // names no group (they stay banned below), so a superlative there is the
    // law's own category: "les plus exposés", "la plus haute juridiction".
    if (rule === 'classement' && noSpeculation) continue;
    const m = f.match(re);
    if (m) v.push({ rule, detail: `« ${m[0]} »` });
  }

  // Only the mechanism note has a text as its subject; everywhere else the
  // subject is people, and these verbs would be attributing motive.
  if (!noSpeculation) {
    const m = f.match(TEXT_EFFECT);
    if (m) v.push({ rule: 'intention', detail: `« ${m[0]} »` });
  }

  if (noSpeculation) {
    for (const [rule, re] of SPECULATION) {
      const m = f.match(re);
      if (m) v.push({ rule, detail: `« ${m[0]} »` });
    }
  }

  if (!allowGroups) {
    // Abbreviations: word-boundary, case-sensitive on the RAW text (so "DR" hits
    // but "dr" inside a word does not, and "NI" doesn't match "ni" the conjunction).
    for (const ab of GROUP_ABBREVS) {
      // NB: in `u` mode `\-` is an invalid escape — the hyphen is literal as-is.
      const re = new RegExp(`(^|[^\\p{L}\\p{N}-])${ab}($|[^\\p{L}\\p{N}-])`, 'u');
      if (re.test(scan)) { v.push({ rule: 'groupe_nomme', detail: ab }); break; }
    }
    for (const name of GROUP_NAMES) {
      if (f.includes(name)) { v.push({ rule: 'groupe_nomme', detail: name }); break; }
    }
  }

  return { ok: v.length === 0, violations: v };
}

/** Human-readable one-liner, for logs and the QA surface. */
export function explain(result) {
  return result.ok
    ? 'neutralité OK'
    : result.violations.map((x) => `${x.rule}: ${x.detail}`).join(' · ');
}

export const RULES_FR = [
  'Uniquement des faits du scrutin, ou une somme/différence de ses nombres.',
  'Aucun adjectif qualifiant un groupe politique.',
  'Aucun groupe politique nommé.',
  'Aucun verbe d’intention ou de cause.',
  'Aucun superlatif ni classement entre groupes.',
  'Aucune interprétation, portée ou conséquence.',
  'Aucune spéculation.',
  'Aucun hashtag, emoji, @, ! ou ?.',
  'Le résultat s’énonce avec le mot de l’Assemblée : adoptée ou rejetée.',
  'Aucun lien dans le texte — la source se poste en réponse.',
];
