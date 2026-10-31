import test from 'node:test';
import assert from 'node:assert/strict';
import {
  amendementForScrutin, articleEnClair, chiffres, chiffresInventes, texteBrut, valider,
} from '../server/amendement.mjs';

const rec = (o) => ({ uid: 'AMANR5L17PO838901B3210P1D1N001358', numero: 1358, sousAmendement: false, dateSort: '2026-10-30T09:06:24+01:00', ...o });
const s9336 = {
  titre: "l'amendement n° 1358 de M. Lhardit après l'article 15 (examen prioritaire) du projet de loi de finances pour 2027 (première lecture).",
  dossierRef: 'DLR5L17N54629', dossierTitre: 'Projet de loi de finances pour 2027', date: '2026-10-30',
};

test('ballot → amendment: same number, the one decided that day wins', () => {
  const list = [rec({ uid: 'A', dateSort: '2026-11-20T10:00:00+01:00' }), rec({ uid: 'B' }), rec({ uid: 'C', numero: 99 })];
  assert.equal(amendementForScrutin(s9336, list).rec.uid, 'B');
  // decided another week: not this ballot's amendment
  assert.equal(amendementForScrutin({ ...s9336, date: '2026-12-01' }, list), null);
  // a sitting past midnight
  assert.equal(amendementForScrutin({ ...s9336, date: '2026-11-19' }, list).rec.uid, 'A');
  // two texts, same number, same day: ambiguous, nothing shown
  assert.equal(amendementForScrutin(s9336, [rec({ uid: 'B' }), rec({ uid: 'D' })]), null);
  // not yet decided in the data, and the only one: taken
  assert.equal(amendementForScrutin(s9336, [rec({ uid: 'E', dateSort: null })]).rec.uid, 'E');
  assert.equal(amendementForScrutin({ ...s9336, titre: "l'ensemble du projet de loi" }, list), null);
  // a sub-amendment ballot never lands on the amendment with the same number
  assert.equal(amendementForScrutin({ ...s9336, titre: 'le sous-amendement n° 1358 de M. X' }, list), null);
  // a sub-amendment's title names its parent: not « identiques »
  const sous = rec({ uid: 'S', numero: 1087, sousAmendement: true });
  const hit = amendementForScrutin({ ...s9336, titre: "le sous-amendement n° 1087 de M. Boyard à l'amendement n° 1012 de M. X" }, [sous]);
  assert.equal(hit.rec.uid, 'S');
  assert.equal(hit.identiques, false);
  // two numbers on a plain ballot are identical amendments
  assert.equal(amendementForScrutin({ ...s9336, titre: "les amendements identiques n° 1358 et n° 1400" }, list).identiques, true);
});

test('article in plain words', () => {
  assert.equal(articleEnClair('APRÈS ART. 15'), 'après l’article 15');
  assert.equal(articleEnClair('AVANT ART. 2 BIS'), 'avant l’article 2 bis');
  assert.equal(articleEnClair('ART. PREMIER'), 'article premier');
  assert.equal(articleEnClair(''), null);
});

test('figures: French notation, nothing invented', () => {
  assert.deepEqual([...chiffres('0,055 € par giga, 10 000 et 1 358')].sort(), ['0.055', '10000', '1358'].sort());
  assert.deepEqual(chiffresInventes('un rendement de 10 milliards selon ses auteurs', 'rendement de 10Md€'), []);
  assert.deepEqual(chiffresInventes('un taux de 3 %', 'aucun chiffre ici'), ['3 %']);
  // same digits, another size or unit: invented
  assert.deepEqual(chiffresInventes('10 M€', 'un rendement de 10 Md€'), ['10 M']);
  assert.deepEqual(chiffresInventes('15 %', 'une amende de 15 euros'), ['15 %']);
  assert.deepEqual(chiffresInventes('2 milliards', '2 millions d’euros'), ['2 Md']);
  assert.deepEqual(chiffresInventes('0,055 € par Go', '0,055 euro par gigaoctet'), []);
  assert.deepEqual(chiffresInventes('15 % du chiffre d’affaires', 'plafonnée à 15 % du chiffre'), []);
});

test('HTML → text', () => {
  assert.equal(texteBrut('<p>I. – Après l&#8217;article&nbsp;302 bis ZP</p><p>II. &laquo; x &raquo;</p>'), 'I. – Après l’article 302 bis ZP\nII. « x »');
});

const src = {
  dispositif: 'Il est institué une taxe sur la consommation de données numériques due par les opérateurs de communications électroniques, au tarif de 0,055 euro par gigaoctet consommé par les abonnés.',
  expose: 'Cet amendement propose une taxe sur les données numériques. Son rendement serait de 10 milliards d’euros selon les auteurs.',
};

test('gates: a faithful summary passes', () => {
  const v = valider({
    titre: 'Taxe sur les données numériques',
    resume: 'L’amendement institue une taxe sur la consommation de données numériques, due par les opérateurs de communications électroniques, au tarif de 0,055 euro par gigaoctet consommé par les abonnés. Selon ses auteurs, son rendement serait de 10 milliards d’euros.',
    motsCles: ['taxe gigaoctet', 'taxe Go', 'données numériques'],
  }, { s: s9336, src });
  assert.equal(v.ok, true, v.reason);
  assert.ok(v.motsCles.includes('taxe Go'));
});

test('gates: an invented figure is refused', () => {
  const v = valider({
    titre: 'Taxe sur les données numériques',
    resume: 'L’amendement institue une taxe sur la consommation de données numériques due par les opérateurs, au tarif de 0,07 euro par gigaoctet consommé par les abonnés.',
    motsCles: [],
  }, { s: s9336, src });
  assert.equal(v.ok, false);
  assert.match(v.reason, /chiffre/);
});

test('gates: off-topic output is refused, empty output says nothing', () => {
  const off = valider({
    titre: 'Réforme des retraites',
    resume: 'Le texte repousse l’âge légal de départ et modifie le calcul des pensions des fonctionnaires et des salariés du secteur privé.',
    motsCles: [],
  }, { s: s9336, src });
  assert.equal(off.ok, false);
  assert.equal(valider({ titre: '', resume: '', motsCles: [] }, { s: s9336, src }).ok, false);
});

test('gates: an unrelated headline is refused, unrelated search words are dropped', () => {
  const good = 'L’amendement institue une taxe sur la consommation de données numériques, due par les opérateurs de communications électroniques, au tarif de 0,055 euro par gigaoctet consommé par les abonnés.';
  const bad = valider({ titre: 'Suppression des pensions de retraite', resume: good, motsCles: [] }, { s: s9336, src });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /titre/);
  const v = valider({
    titre: 'Taxe sur les données numériques',
    resume: good,
    motsCles: ['taxe Go', 'taxe gigaoctet', 'vaccination obligatoire', 'retraite 9999', 'GAFAM'],
  }, { s: s9336, src });
  assert.equal(v.ok, true, v.reason);
  assert.deepEqual(v.motsCles, ['taxe Go', 'taxe gigaoctet']);
});

test('deletion amendments are their own summary', async () => {
  const { suppressionSimple } = await import('../server/amendement.mjs');
  assert.match(suppressionSimple('Supprimer cet article.', 'article 12').resume, /supprime l’article visé \(article 12\)/);
  assert.match(suppressionSimple('<p>Supprimer les alinéas 3 à 5.</p>'.replace(/<[^>]+>/g, ''), null).resume, /alinéas 3 à 5/);
  assert.equal(suppressionSimple('Supprimer cet article et créer une taxe.', null), null);
});

test('a malformed uid never reaches a URL or a file', async () => {
  const { slimAmendement } = await import('../server/data/amendements.mjs');
  assert.equal(slimAmendement({ uid: '../../index/search' }, 'DLR1').uid, null);
  assert.equal(slimAmendement({ uid: 'AMANR5L17PO838901B3210P1D1N001358/../x' }, 'DLR1').uid, null);
  assert.equal(slimAmendement({ uid: 'AMANR5L17PO838901B3210P1D1N001358' }, 'DLR1').uid, 'AMANR5L17PO838901B3210P1D1N001358');
});

test('a refused first answer gets one second chance, then the refusal is kept', async () => {
  const { makeContexte, amendementForScrutin } = await import('../server/amendement.mjs');
  if (!amendementForScrutin(s9336)) return; // no AN amendment list on this machine
  const prompts = [];
  const tooLong = { titre: 'Taxe sur les données numériques', resume: 'x '.repeat(600), motsCles: [] };
  const written = [];
  const r = await makeContexte(s9336, {
    force: true,
    source: async () => src,
    write: async (uid, value) => written.push(value),
    run: async (p) => { prompts.push(p); return tooLong; },
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /refusée \(motif : trop long\)/);
  assert.equal(r.status, 'ecarte');
  assert.equal(written.length, 1);
  assert.equal(written[0].ecarte, 'trop long');
});

test('an amendment the AN does not serve is « absent », not an error that blocks the queue', async () => {
  const { makeContexte, amendementForScrutin } = await import('../server/amendement.mjs');
  if (!amendementForScrutin(s9336)) return;
  const written = [];
  const r = await makeContexte(s9336, {
    force: true,
    source: async () => { throw Object.assign(new Error('HTTP 404'), { status: 404 }); },
    write: async (uid, v) => written.push(v),
    run: async () => { throw new Error('never called'); },
  });
  assert.equal(r.status, 'absent');
  assert.match(written[0].absent, /404/);
  const r5 = await makeContexte(s9336, {
    force: true,
    source: async () => { throw Object.assign(new Error('HTTP 503'), { status: 503 }); },
    write: async () => { throw new Error('a 5xx is not cached'); },
  });
  assert.equal(r5.status, 'erreur');
});
