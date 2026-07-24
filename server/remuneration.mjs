// remuneration.mjs — what a deputy is paid, and what an absence costs them.
//
// Transcribed from the Assemblée's own page, not from memory and not from a
// press summary. Every figure below appears verbatim there; the URL and the
// update date ship with them so the page can cite its source rather than ask
// to be believed.
//
// Two things this file exists to keep straight:
//
//   · The indemnité parlementaire is the deputy's income. The dotation de
//     fonctionnement and the crédit collaborateurs are NOT: the first
//     reimburses mandate expenses, the second pays other people's salaries and
//     never reaches the deputy. Adding the three gives ~26 000 €/month, which
//     is the number that circulates and is wrong. They are listed here
//     precisely so the page can say what they are instead of omitting them.
//
//   · Missing a ballot costs nothing. The Règlement docks pay for missing
//     Wednesday-morning committee meetings (art. 42) and for taking part in
//     fewer than two thirds of solemn votes and censure motions over a session
//     (art. 159). Ordinary public ballots — the daily electronic votes, which
//     are essentially all of the 8 400 in this app — appear in neither.
//     That is a fact about the rules, checkable in the text, and it is the only
//     thing this page says on the subject: no cost is inferred, because the
//     participation figure does not measure attendance (see delegations).

export const SOURCE = {
  url: "https://www.assemblee-nationale.fr/dyn/synthese/deputes-groupes-parlementaires/la-situation-materielle-du-depute",
  label: "Assemblée nationale — La situation matérielle du député",
  maj: "janvier 2026",
};

/** The deputy's own pay. Amounts in force since 1 January 2024. */
export const INDEMNITE = {
  depuis: "1er janvier 2024",
  base: 5931.95,
  residence: 177.96,
  fonction: 1527.48,
  brut: 7637.39,
  net: 5953.34,
};

/** Sums a deputy administers but does not earn. */
export const AUTRES = [
  {
    cle: "dotation",
    nom: "Dotation de fonctionnement parlementaire",
    montant: 7238.04,
    depuis: "1er janvier 2026",
    quoi: "Frais liés au mandat — permanence, déplacements, impressions. Ce n’est pas un revenu.",
  },
  {
    cle: "collaborateurs",
    nom: "Crédit collaborateurs",
    montant: 11463,
    quoi: "Salaires et charges de cinq collaborateurs au plus. Cet argent ne revient jamais au député.",
  },
];

/**
 * When absence actually costs a deputy money.
 * `scrutinOrdinaire: false` is the answer to the question people ask.
 */
export const RETENUES = {
  scrutinOrdinaire: false,
  regles: [
    {
      article: "Article 42 du Règlement",
      quand: "Au-delà de deux absences par mois aux commissions du mercredi matin",
      combien: "25 % de l’indemnité de fonction",
    },
    {
      article: "Article 159 du Règlement",
      quand: "Moins de deux tiers de participation aux votes solennels et motions de censure sur une session",
      combien: "un tiers de l’indemnité de fonction, doublé sous la moitié",
    },
  ],
  reglementUrl:
    "https://www.assemblee-nationale.fr/dyn/17/divers/texte_reference/02_reglement_assemblee_nationale.pdf",
};

/** Seats. Vacancies between a resignation and its by-election are brief and
 *  the Assemblée publishes no running headcount, so the constitutional number
 *  is used and the figure is presented as what the seats cost, not a payroll. */
const SIEGES = 577;

/**
 * Cost to the public purse, per deputy per month.
 *
 * This is where the "26 000 € par mois" figure is finally placed correctly. It
 * is wrong as INCOME — the deputy earns 5 953 € net — and right as COST: the
 * mandate allowance and the staff budget are public money too, they are simply
 * not the deputy's. Stating one without the other is how the confusion lives:
 * quote only the pay and the cost looks small, quote only the total and the
 * deputy looks paid four times what they are.
 */
function coutMensuelParDepute() {
  return INDEMNITE.brut + AUTRES.reduce((sum, a) => sum + a.montant, 0);
}

/**
 * What the seats have cost since 1 January, up to today.
 *
 * Prorated by elapsed days rather than by whole months, so the figure moves
 * every day instead of jumping on the first — a running total that only changes
 * twelve times a year reads as an estimate, which it would then be.
 */
function coutDepuisJanvier(now = new Date()) {
  const annee = now.getUTCFullYear();
  const debut = Date.UTC(annee, 0, 1);
  const finAnnee = Date.UTC(annee + 1, 0, 1);
  const jours = (Date.UTC(annee, now.getUTCMonth(), now.getUTCDate()) - debut) / 86_400_000;
  const joursAnnee = (finAnnee - debut) / 86_400_000;
  const annuelParDepute = coutMensuelParDepute() * 12;
  return {
    annee,
    jours,
    joursAnnee,
    total: annuelParDepute * SIEGES * (jours / joursAnnee),
  };
}

export function remuneration(now = new Date()) {
  return {
    source: SOURCE,
    indemnite: INDEMNITE,
    autres: AUTRES,
    retenues: RETENUES,
    sieges: SIEGES,
    coutMensuel: coutMensuelParDepute(),
    depuisJanvier: coutDepuisJanvier(now),
  };
}
