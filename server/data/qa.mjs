/**
 * Arithmetic self-checks on a normalized scrutin.
 *
 * Every gate here was validated against all 8 433 L17 scrutins. Two gates from
 * the original runbook were WRONG and are deliberately absent:
 *
 *  1. "Σ membres = 577" — fails on 46 % of ballots. Seats fall vacant between
 *     by-elections; the real distribution is 577×4518, 575×2316, 576×1567,
 *     574×32. Replaced by `effectif_plausible`, and `effectif` is computed and
 *     used everywhere 577 used to be hardcoded.
 *  2. "majorité = ⌊exprimés/2⌋+1" for every ballot — fails on the 23 motions de
 *     censure, whose threshold is an absolute majority of sitting MEMBERS.
 *     Replaced by `majorite_formula`, which branches on typeMajorite.
 *
 * Also deliberately absent: any gate summing `nonVotantsVolontaires`. At group
 * level that field mirrors the abstention count (identical number, empty
 * nominal list) while the synthesis reports 0, so a naive sum "fails" on 6 203
 * scrutins and subtracting it double-counts abstentions.
 */

import { expectedMajorite, isCensureMajority } from './normalize.mjs';

const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);

/**
 * @param {object} n - a normalized scrutin
 * @returns {{ok: boolean, numero: number, checks: Array<{id,label,ok,expected,actual}>}}
 */
export function verify(n) {
  const g = n.groupes || [];
  const s = n.synthese || {};
  const checks = [];
  const add = (id, label, expected, actual) =>
    checks.push({ id, label, ok: expected === actual, expected, actual });

  // --- Ventilation must reconcile with the synthesis (0 failures observed) ---
  add('sum_pour', 'Σ pour par groupe = synthèse pour', s.pour, sum(g, 'pour'));
  add('sum_contre', 'Σ contre par groupe = synthèse contre', s.contre, sum(g, 'contre'));
  add('sum_abstention', 'Σ abstentions par groupe = synthèse abstentions', s.abstention, sum(g, 'abstention'));

  // --- Internal arithmetic of the synthesis (0 failures observed) ---
  add('votants', 'pour + contre + abstentions = votants', s.votants, s.pour + s.contre + s.abstention);
  add('exprimes', 'pour + contre = suffrages exprimés', s.exprimes, s.pour + s.contre);

  // --- Corrected gates ---
  add(
    'majorite_formula',
    isCensureMajority(n.typeMajorite)
      ? 'majorité requise = ⌊effectif/2⌋+1 (motion de censure)'
      : 'majorité requise = ⌊exprimés/2⌋+1',
    s.majorite,
    expectedMajorite({ typeMajorite: n.typeMajorite, exprimes: s.exprimes, effectif: n.effectif }),
  );

  const effectifOk = n.effectif >= 550 && n.effectif <= 577;
  checks.push({
    id: 'effectif_plausible',
    label: 'effectif (Σ membres) dans la plage 550–577',
    ok: effectifOk,
    expected: '550..577',
    actual: n.effectif,
  });

  // Known upstream anomaly: 1 scrutin of 8 433 (n°1, motion de censure of
  // 2024-10-08) reports 10 non-votants in the synthesis vs 21 across groups.
  add('sum_non_votants', 'Σ non-votants par groupe = synthèse non-votants', s.nonVotants, sum(g, 'nonVotant'));

  const negatives = g.filter((r) => r.absent < 0);
  checks.push({
    id: 'absents_non_negatifs',
    label: 'absents ≥ 0 pour chaque groupe',
    ok: negatives.length === 0,
    expected: 0,
    actual: negatives.length,
  });

  // Guards the absent derivation: the five buckets must repartition the group.
  const bad = g.filter(
    (r) => r.pour + r.contre + r.abstention + r.nonVotant + r.absent !== r.membres,
  );
  checks.push({
    id: 'ventilation_complete',
    label: 'pour+contre+abstention+nonVotant+absent = membres, par groupe',
    ok: bad.length === 0,
    expected: 0,
    actual: bad.length,
  });

  return { ok: checks.every((c) => c.ok), numero: n.numero, checks };
}

/** Aggregate `verify` over many scrutins into a per-gate failure report. */
export function verifyAll(records) {
  const gates = new Map();
  let total = 0;
  let failing = 0;
  const examples = new Map();

  for (const rec of records) {
    total++;
    const res = verify(rec);
    if (!res.ok) failing++;
    for (const c of res.checks) {
      if (!gates.has(c.id)) gates.set(c.id, { id: c.id, label: c.label, failures: 0 });
      if (!c.ok) {
        gates.get(c.id).failures++;
        if (!examples.has(c.id)) {
          examples.set(c.id, { numero: rec.numero, expected: c.expected, actual: c.actual });
        }
      }
    }
  }

  return {
    total,
    failing,
    ok: failing === 0,
    gates: [...gates.values()].map((gate) => ({ ...gate, example: examples.get(gate.id) || null })),
  };
}
