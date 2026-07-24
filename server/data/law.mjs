/**
 * Promulgated law -> the ballots that produced it.
 *
 * Chain: `codeLoi` (e.g. "2024-1177") lives on the PROM-PUB act inside a
 * legislative dossier; the dossier `uid` is what scrutins reference through
 * `objet.dossierLegislatif.dossierRef`.
 *
 * The crucial honesty constraint: only 21 of the 94 laws promulgated under L17
 * can be traced to a scrutin this way. The rest passed without a recorded
 * public ballot (adoption by show of hands, which is the ordinary case) or
 * their ballots carry no dossier reference — `dossierRef` is present on just
 * 30.9 % of scrutins. So "no result" must never be rendered as "no vote
 * happened"; those two cases are returned as distinct statuses.
 */

import { loadIndex, docByNumero } from './store.mjs';
import { extractLawCode } from './text.mjs';

/** Extract every PROM-PUB act carrying a codeLoi from a dossier record. */
export function collectPromulgations(dossier) {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (node && typeof node === 'object') {
      if (node.codeActe === 'PROM-PUB' && node.codeLoi) found.push(node);
      for (const v of Object.values(node)) walk(v);
    }
  };
  walk(dossier.actesLegislatifs);
  return found;
}

/** Build codeLoi -> {dossierRef, titreLoi, dateLoi, scrutins[]}. */
export function buildLawIndex(dossiers, scrutinsByDossier) {
  const laws = Object.create(null);
  for (const dossier of dossiers) {
    for (const acte of collectPromulgations(dossier)) {
      const scrutins = (scrutinsByDossier[dossier.uid] || []).slice().sort((a, b) => a - b);
      laws[acte.codeLoi] = {
        codeLoi: acte.codeLoi,
        titreLoi: acte.titreLoi || null,
        dateLoi: (acte.dateActe || '').slice(0, 10) || null,
        legislature: Number.parseInt(dossier.legislature, 10) || null,
        dossierRef: dossier.uid,
        dossierTitre: (dossier.titreDossier && dossier.titreDossier.titre) || null,
        urlLegifrance: acte.urlEcheancierLoi || null,
        scrutins,
      };
    }
  }
  return laws;
}

/**
 * @param {string} code - "2024-1177", or any string containing it
 * @returns {{status: 'ok'|'no_public_ballot'|'unknown_law', ...}}
 */
export function lookupLaw(code, opts = {}) {
  const index = opts.index || loadIndex();
  const codeLoi = extractLawCode(code) || String(code || '').trim();
  const law = (index.laws || {})[codeLoi];

  if (!law) {
    return {
      status: 'unknown_law',
      codeLoi,
      message:
        `Aucune loi n° ${codeLoi} dans les données ouvertes de l'Assemblée nationale ` +
        `pour cette législature. Vérifiez le numéro, ou la loi relève d'une autre législature.`,
    };
  }

  const scrutins = (law.scrutins || [])
    .map((n) => docByNumero(index, n))
    .filter(Boolean)
    .map((d) => ({
      numero: d.numero,
      titre: d.titre,
      date: d.date,
      sort: d.sort,
      pour: d.pour,
      contre: d.contre,
      abstentions: d.abstentions,
      final: d.final,
      reading: d.reading,
      sourceUrl: d.sourceUrl,
    }))
    .sort((a, b) => a.numero - b.numero);

  if (!scrutins.length) {
    return {
      status: 'no_public_ballot',
      codeLoi,
      law,
      scrutins: [],
      message:
        `La loi n° ${codeLoi} (« ${law.titreLoi || law.dossierTitre || law.dossierRef} ») ` +
        `n'a aucun scrutin public rattaché dans les données ouvertes. C'est le cas ordinaire : ` +
        `la plupart des textes sont adoptés à main levée, sans scrutin public nominatif.`,
    };
  }

  return { status: 'ok', codeLoi, law, scrutins };
}

/** All indexed laws, most recent first. */
export function listLaws(opts = {}) {
  const index = opts.index || loadIndex();
  return Object.values(index.laws || {}).sort((a, b) =>
    String(b.dateLoi || '').localeCompare(String(a.dateLoi || '')),
  );
}
