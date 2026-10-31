import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../server/data/normalize.mjs';

const groupe = (ref, membres, pour, contre, abst, position) => ({
  organeRef: ref,
  nombreMembresGroupe: String(membres),
  vote: {
    positionMajoritaire: position,
    decompteVoix: { pour: String(pour), contre: String(contre), abstentions: String(abst), nonVotants: '0' },
  },
});

test('a group that cast no vote has no majority position, whatever the AN says', () => {
  const rec = normalize({
    numero: '9336',
    legislature: '17',
    syntheseVote: { decompte: {} },
    ventilationVotes: { organe: { groupes: { groupe: [groupe('PO1', 35, 0, 0, 0, 'pour'), groupe('PO2', 68, 5, 0, 0, 'pour')] } } },
  });
  const [silent, soc] = [rec.groupes.find((g) => g.organeRef === 'PO1'), rec.groupes.find((g) => g.organeRef === 'PO2')];
  assert.equal(silent.positionMajoritaire, null);
  assert.equal(soc.positionMajoritaire, 'pour');
});
