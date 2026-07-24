/**
 * Raw Assemblée nationale scrutin JSON -> compact normalized record.
 *
 * The upstream shape is an XML-to-JSON transliteration: every number is a
 * string, single-element collections are sometimes objects instead of arrays,
 * and absent collections are `null`. This module is the single place that
 * knows about those quirks.
 */

import { resolveGroup } from './groups.mjs';

/** Public AN page for a ballot — the citable source for every record. */
export function sourceUrlFor(legislature, numero) {
  return `https://www.assemblee-nationale.fr/dyn/${legislature}/scrutins/${numero}`;
}

const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const toInt = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};

/** True when the ballot uses the motion-de-censure threshold rule. */
export function isCensureMajority(typeMajorite) {
  return typeof typeMajorite === 'string' && /censure/i.test(typeMajorite);
}

/**
 * Required majority, derived rather than trusted.
 *
 * Ordinary ballots: absolute majority of votes cast (suffrages exprimés).
 * Motions de censure: absolute majority of sitting members — which is NOT a
 * hardcoded 289. When seats are vacant the AN lowers it accordingly (289 with
 * 576-577 seats filled, 288 with 574-575). Verified: this single formula
 * reproduces `nbrSuffragesRequis` for all 8 433 L17 scrutins, both types.
 */
export function expectedMajorite({ typeMajorite, exprimes, effectif }) {
  const base = isCensureMajority(typeMajorite) ? effectif : exprimes;
  return Math.floor(base / 2) + 1;
}

/**
 * @param {object} raw - parsed `VTANR5L17V{n}.json`, with or without the
 *   `{ scrutin: ... }` wrapper.
 * @param {object} [ctx]
 * @param {object} [ctx.groupRegistry] - organeRef -> {abbrev, nom, couleur}
 * @param {object} [ctx.dossierTitres]  - dossierRef -> dossier title
 */
export function normalize(raw, ctx = {}) {
  const s = raw && raw.scrutin ? raw.scrutin : raw;
  if (!s || !s.numero) throw new Error('normalize: not a scrutin record');

  const { groupRegistry = null, dossierTitres = null } = ctx;

  const legislature = toInt(s.legislature);
  const numero = toInt(s.numero);

  const synth = s.syntheseVote || {};
  const decompte = synth.decompte || {};

  const rawGroupes = toArray(
    s.ventilationVotes && s.ventilationVotes.organe
      ? s.ventilationVotes.organe.groupes && s.ventilationVotes.organe.groupes.groupe
      : null,
  );

  const groupes = rawGroupes.map((g) => {
    const voix = (g.vote && g.vote.decompteVoix) || {};
    const membres = toInt(g.nombreMembresGroupe);
    const pour = toInt(voix.pour);
    const contre = toInt(voix.contre);
    const abstention = toInt(voix.abstentions);
    // `nonVotants` = members barred from voting (président de séance, ministers).
    // `nonVotantsVolontaires` is deliberately NOT used: at group level it mirrors
    // the abstention count (same number, empty nominal list), so subtracting it
    // would double-count abstentions. See README.
    const nonVotant = toInt(voix.nonVotants);
    return {
      organeRef: g.organeRef,
      ...resolveGroup(groupRegistry, g.organeRef),
      membres,
      pour,
      contre,
      abstention,
      nonVotant,
      absent: membres - pour - contre - abstention - nonVotant,
      positionMajoritaire: (g.vote && g.vote.positionMajoritaire) || null,
    };
  });

  // Seats actually filled on the day. Replaces the hardcoded 577: vacancies are
  // routine (observed 574/575/576/577 across L17), so 577 is wrong 46% of the time.
  const effectif = groupes.reduce((n, g) => n + g.membres, 0);

  // Fixed presentational order: largest group first. Never ordered by voting
  // behaviour — that would be an editorial claim about who "won" the ballot.
  groupes.sort((a, b) => b.membres - a.membres || a.abbrev.localeCompare(b.abbrev, 'fr'));

  const dossier = (s.objet && s.objet.dossierLegislatif) || null;
  const dossierRef = (dossier && dossier.dossierRef) || null;

  return {
    numero,
    legislature,
    date: s.dateScrutin || null,
    titre: s.titre || (s.objet && s.objet.libelle) || '',
    sort: (s.sort && s.sort.code) || null,
    sortLibelle: (s.sort && s.sort.libelle) || null,
    typeVote: {
      code: (s.typeVote && s.typeVote.codeTypeVote) || null,
      libelle: (s.typeVote && s.typeVote.libelleTypeVote) || null,
    },
    typeMajorite: (s.typeVote && s.typeVote.typeMajorite) || null,
    demandeur: (s.demandeur && s.demandeur.texte) || null,
    synthese: {
      votants: toInt(synth.nombreVotants),
      exprimes: toInt(synth.suffragesExprimes),
      majorite: toInt(synth.nbrSuffragesRequis),
      pour: toInt(decompte.pour),
      contre: toInt(decompte.contre),
      abstention: toInt(decompte.abstentions),
      nonVotants: toInt(decompte.nonVotants),
    },
    effectif,
    groupes,
    dossierRef,
    dossierTitre:
      (dossierTitres && dossierRef && dossierTitres[dossierRef]) ||
      (dossier && dossier.libelle) ||
      null,
    sourceUrl: sourceUrlFor(legislature, numero),
  };
}
