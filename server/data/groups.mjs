/**
 * Political-group identity.
 *
 * A scrutin only carries an `organeRef` per group; the human-readable identity
 * (abbreviation, full name, official colour) lives in the AMO10 organe
 * reference export.
 *
 * Two refs used by real ballots are NOT resolvable from AMO10/AMO50 and must be
 * pinned, otherwise ~36 % of scrutins would render a group as "PO847173":
 *
 *  - PO847173 — the original "Union des droites pour la République" group.
 *    Used by 3 041 scrutins. The group was dissolved and re-registered as
 *    PO872880 (2025-09-05); only the new ref ships in AMO10, so the old one
 *    resolves to nothing. Values below are copied from PO872880, its successor.
 *  - PO0 — a placeholder ref the AN emits in 14 early L17 scrutins for the
 *    "no group recorded" bucket. Not a real organe.
 *
 * Everything else resolves from AMO10 at refresh time. Note that the correct
 * source field for the display abbreviation is `libelleAbrege`, NOT
 * `libelleAbrev`: for PO872880 the former is "UDR" (what the AN publishes and
 * what the press uses) while the latter is the administrative "UDDPLR".
 */

export const GROUP_ALIASES = {
  PO847173: {
    abbrev: 'UDR',
    nom: 'Union des droites pour la République',
    couleur: '#3367A7',
    pinned: 'dissolved group, re-registered as PO872880; absent from AMO10/AMO50',
  },
  PO0: {
    abbrev: 'ND',
    nom: 'Non déterminé',
    couleur: '#8D949A',
    pinned: 'placeholder ref emitted by the AN in 14 early L17 scrutins',
  },
};

/** Build the organeRef -> identity map from AMO10 organe records. */
export function buildGroupRegistry(organeRecords) {
  const registry = Object.create(null);
  for (const organe of organeRecords) {
    if (!organe || organe.codeType !== 'GP') continue;
    registry[organe.uid] = {
      abbrev: organe.libelleAbrege || organe.libelleAbrev || organe.uid,
      nom: organe.libelle || null,
      couleur: organe.couleurAssociee || null,
    };
  }
  for (const [ref, identity] of Object.entries(GROUP_ALIASES)) {
    if (!registry[ref]) registry[ref] = { ...identity };
  }
  return registry;
}

/** Resolve one ref, always returning something displayable. */
export function resolveGroup(registry, organeRef) {
  const hit = (registry && registry[organeRef]) || GROUP_ALIASES[organeRef];
  if (hit) return { abbrev: hit.abbrev, nom: hit.nom, couleur: hit.couleur ?? null };
  return { abbrev: organeRef, nom: null, couleur: null };
}
