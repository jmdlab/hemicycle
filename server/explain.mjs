// explain.mjs — turn a parliamentary ballot into something a person can read.
//
// The premise of this app: these texts are written in a register that keeps
// people out. Everything here is about removing that barrier without ever
// telling the reader what to think — describing the machinery plainly is not
// the same as taking a side, and the line between the two is the whole job.
//
// Every string in this file is derived by rule from official fields. No model,
// no invention. The optional model pass (build-time, cached) adds the "what it
// means / what is at stake" paragraph on top; the page works fully without it.

/* ── glossary: only the terms this ballot actually uses ─────────────────── */

const GLOSSARY = {
  cmp: {
    term: 'Commission mixte paritaire',
    plain:
      'Quand l’Assemblée et le Sénat n’arrivent pas au même texte, sept députés et sept sénateurs se réunissent pour tenter d’en écrire un commun. Le vote porte alors sur ce texte de compromis.',
  },
  premiereLecture: {
    term: 'Première lecture',
    plain:
      'Le premier examen du texte par l’Assemblée. Il repartira ensuite au Sénat, et peut faire plusieurs allers-retours avant d’être définitivement adopté ou abandonné.',
  },
  nouvelleLecture: {
    term: 'Nouvelle lecture',
    plain:
      'Le texte revient devant l’Assemblée après un désaccord avec le Sénat, pour être réexaminé.',
  },
  lectureDefinitive: {
    term: 'Lecture définitive',
    plain:
      'Le dernier mot. En cas de désaccord persistant avec le Sénat, le Gouvernement peut demander à l’Assemblée de trancher seule.',
  },
  rejetPrealable: {
    term: 'Motion de rejet préalable',
    plain:
      'Une demande de rejeter le texte sans même en discuter le contenu. Si elle est adoptée, l’examen s’arrête là ; si elle est rejetée, le débat continue.',
  },
  questionPrealable: {
    term: 'Question préalable',
    plain:
      'Comme la motion de rejet : une demande d’arrêter l’examen du texte avant d’entrer dans le détail.',
  },
  censure: {
    term: 'Motion de censure',
    plain:
      'Un vote sur le maintien du Gouvernement. Elle n’est adoptée que si la majorité de tous les députés la vote — les absents comptent donc de fait contre elle.',
  },
  amendement: {
    term: 'Amendement',
    plain:
      'Une modification proposée à un article du texte. Le vote porte sur cette seule modification, pas sur l’ensemble de la loi.',
  },
  sousAmendement: {
    term: 'Sous-amendement',
    plain: 'Une modification apportée à un amendement lui-même. Un cran plus fin encore.',
  },
  article: {
    term: 'Vote sur un article',
    plain:
      'Le vote porte sur une partie du texte seulement, pas sur la loi entière.',
  },
  ensemble: {
    term: 'Vote sur l’ensemble',
    plain:
      'Le vote qui compte pour le texte entier, une fois tous les articles examinés. C’est celui qui décide si la loi est adoptée.',
  },
  majoriteAbsolue: {
    term: 'Majorité absolue',
    plain:
      'Le nombre de voix qu’il fallait atteindre pour l’emporter : plus de la moitié des votes exprimés.',
  },
  exprimes: {
    term: 'Suffrages exprimés',
    plain:
      'Les votes « pour » et « contre » additionnés. Les abstentions n’en font pas partie : elles ne comptent ni d’un côté ni de l’autre.',
  },
  abstention: {
    term: 'Abstention',
    plain:
      'Le député était là et a choisi de ne se prononcer ni pour ni contre.',
  },
  nonVotant: {
    term: 'Non-votant',
    plain:
      'Un député présent qui ne prend pas part au vote — c’est notamment le cas de la personne qui préside la séance.',
  },
  absent: {
    term: 'Absent',
    plain:
      'Le député n’a pas pris part au scrutin. C’est presque toujours le contingent le plus nombreux.',
  },
};

/** Only the entries this ballot actually needs, in reading order. */
export function glossaryFor(s) {
  const t = String(s?.titre ?? '');
  const keys = [];

  if (/motion de censure/i.test(t)) keys.push('censure');
  else if (/motion de rejet préalable/i.test(t)) keys.push('rejetPrealable');
  else if (/question préalable/i.test(t)) keys.push('questionPrealable');
  else if (/sous-amendement/i.test(t)) keys.push('sousAmendement');
  else if (/amendement/i.test(t)) keys.push('amendement');
  else if (/^l['’]article/i.test(t)) keys.push('article');
  else if (/^l['’]ensemble d/i.test(t)) keys.push('ensemble');

  if (/commission mixte paritaire|texte de la cmp/i.test(t)) keys.push('cmp');
  else if (/première lecture/i.test(t)) keys.push('premiereLecture');
  else if (/nouvelle lecture/i.test(t)) keys.push('nouvelleLecture');
  else if (/lecture définitive/i.test(t)) keys.push('lectureDefinitive');

  keys.push('majoriteAbsolue', 'exprimes', 'abstention');
  if ((s?.synthese?.nonVotants ?? 0) > 0) keys.push('nonVotant');
  keys.push('absent');

  return keys.map((k) => ({ key: k, ...GLOSSARY[k] })).filter((g) => g.term);
}

/* ── the result, said plainly ───────────────────────────────────────────── */

/**
 * One sentence on what the outcome was and how close it came, using only the
 * ballot's own arithmetic. No adjective about the margin ("de justesse",
 * "largement") — the numbers are given so the reader judges the margin.
 */
export function plainOutcome(s) {
  const y = s?.synthese ?? {};
  const censure = /motion de censure/i.test(String(s?.titre ?? ''));
  const pour = y.pour ?? 0;

  // Three states, never two. The old `adopted ? … : "rejeté"` published "il est
  // rejeté" for a ballot whose result the AN did not code (sort: null), and that
  // sentence went straight into the Open Graph description served to crawlers —
  // the confident-falsehood the client already refuses in sortOf, reintroduced
  // server-side. An unknown result now says so; a missing threshold drops the
  // "il fallait X voix" clause rather than printing "il fallait 0 voix".
  const result =
    s?.sort === 'adopté' ? `il est adopté`
    : s?.sort === 'rejeté' ? `il est rejeté`
    : null;

  const base = y.majorite == null
    ? ''
    : censure
      ? `Il fallait ${y.majorite} voix — la majorité de tous les députés — pour que la motion soit adoptée. `
      : `Il fallait ${y.majorite} voix sur ${y.exprimes ?? 0} suffrages exprimés pour l’emporter. `;

  const got = result
    ? `Le texte a recueilli ${pour} voix pour et ${y.contre ?? 0} contre : ${result}.`
    : `Le texte a recueilli ${pour} voix pour et ${y.contre ?? 0} contre. Le résultat n’est pas publié dans les données ouvertes.`;

  return `${base}${got}`.trim();
}

/* ── participation, said plainly ────────────────────────────────────────── */

export function plainTurnout(s) {
  const y = s?.synthese ?? {};
  const eff = s?.effectif ?? 577;
  const votants = y.votants ?? 0;
  const nonVotants = y.nonVotants ?? 0;
  const absents = eff - votants - nonVotants;
  return {
    sieges: eff,
    votants,
    absents,
    nonVotants,
    // Stated as a plain count, not a rate with a verdict attached.
    phrase: `Sur ${eff} sièges, ${votants} députés ont pris part au vote et ${absents} étaient absents.`,
  };
}

/* ── who voted what, per group, at a glance ─────────────────────────────── */

/**
 * Per group: the raw counts, plus a direction — but ONLY when enough of the
 * group actually turned up to make that direction mean anything.
 *
 * This guard matters. A group with 122 seats that cast 2 votes against would
 * otherwise be reported as "a majoritairement voté contre", which is true of
 * the two votes and false about the group: 105 of its members were absent.
 * Attributing a position to people who did not vote is precisely the kind of
 * distortion this app exists to remove, so below half participation we state no
 * direction at all and let the counts stand on their own.
 *
 * Groups keep their seat-count order — sorting by behaviour would itself be a
 * claim about who matters.
 */
const DIRECTION_MIN_TURNOUT = 0.5;

export function groupBreakdown(s) {
  return (s?.groupes ?? []).map((g) => {
    const pour = g.pour ?? 0, contre = g.contre ?? 0, abst = g.abstention ?? 0;
    const membres = g.membres ?? 0;
    const exprimes = pour + contre;
    const participation = membres > 0 ? (exprimes + abst) / membres : 0;

    let direction = null;
    if (participation >= DIRECTION_MIN_TURNOUT) {
      if (exprimes === 0) direction = 's’est abstenu';
      else if (pour > contre) direction = 'a majoritairement voté pour';
      else if (contre > pour) direction = 'a majoritairement voté contre';
      else direction = 's’est partagé à égalité';
    }
    return {
      participation,
      abbrev: g.abbrev, nom: g.nom, membres,
      pour, contre, abstention: abst,
      nonVotant: g.nonVotant ?? 0, absent: g.absent ?? 0,
      direction,
    };
  });
}
