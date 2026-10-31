import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import {
  readEocd,
  parseCentralDirectory,
  parseEntryName,
  isSeanceEntry,
  planRanges,
  inflateEntry,
  slimAmendement,
  dispositifHash,
  amendementRefs,
  mainLevee,
} from '../server/data/amendements.mjs';

/* ── a small zip built by hand, with a zip64 end record like the AN archive's ── */
function buildZip(files, { zip64 = false, extra = 0, comment = '' } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(raw), 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(n.length, 26);
    lh.writeUInt16LE(extra, 28); // local extra field (zip64 archives carry one per entry)
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(raw), 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, Buffer.alloc(extra, 0xab), data);
    centrals.push(ch, n);
    offset += 30 + n.length + extra + data.length;
  }
  const cd = Buffer.concat(centrals);
  const cdOffset = offset;
  const tail = [];
  if (zip64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeBigUInt64LE(BigInt(files.length), 24);
    z.writeBigUInt64LE(BigInt(files.length), 32);
    z.writeBigUInt64LE(BigInt(cd.length), 40);
    z.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cdOffset + cd.length), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(z, loc);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(zip64 ? 0xffff : files.length, 8);
  e.writeUInt16LE(zip64 ? 0xffff : files.length, 10);
  e.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12);
  e.writeUInt32LE(zip64 ? 0xffffffff : cdOffset, 16);
  const c = Buffer.from(comment);
  e.writeUInt16LE(c.length, 20);
  return Buffer.concat([...locals, cd, ...tail, e, c]);
}

const SEANCE = 'json/DLR5L17N54629/PRJLANR5L17B3210/AMANR5L17PO838901B3210P1D1N000459.json';
const COMMISSION = 'json/DLR5L17N54629/PRJLANR5L17B3210/AMANR5L17PO59048B3210P0D1N000012.json';
const AMDT = JSON.stringify({
  amendement: {
    uid: 'AMANR5L17PO838901B3210P1D1N000459',
    texteLegislatifRef: 'PRJLANR5L17B3210',
    identification: { numeroOrdreDepot: '459', numeroLong: 'I-459' },
    pointeurFragmentTexte: { division: { articleDesignationCourte: 'APRÈS ART. 4' } },
    signataires: { auteur: { typeAuteur: 'Député', acteurRef: 'PA1', groupePolitiqueRef: 'PO2' }, suffixe: { '@xsi:nil': 'true' } },
    cycleDeVie: { sort: 'Adopté', dateSort: '2026-10-16T18:20:26+02:00' },
    amendementParentRef: { '@xsi:nil': 'true' },
    corps: { contenuAuteur: { dispositif: '<p>I. – Le code est ainsi modifié&nbsp;:</p>' } },
  },
});

for (const zip64 of [false, true]) {
  test(`zip ${zip64 ? 'zip64' : 'classic'}: end record → central directory → one entry`, () => {
    const zip = buildZip([[COMMISSION, '{}'], [SEANCE, AMDT]], { zip64 });
    const tailStart = Math.max(0, zip.length - 65_557);
    const eocd = readEocd(zip.subarray(tailStart), tailStart);
    assert.equal(eocd.total, 2);
    const entries = parseCentralDirectory(zip.subarray(eocd.cdOffset, eocd.cdOffset + eocd.cdSize));
    assert.deepEqual(entries.map((e) => e.name), [COMMISSION, SEANCE]);
    const floor = entries.filter((e) => isSeanceEntry(e.name));
    assert.equal(floor.length, 1);
    const [[start, end, list]] = planRanges(floor);
    const json = JSON.parse(inflateEntry(zip.subarray(start, Math.min(end + 1, zip.length)), start, list[0]));
    const slim = slimAmendement(json, 'DLR5L17N54629');
    assert.equal(slim.numero, 459);
    assert.equal(slim.article, 'APRÈS ART. 4');
    assert.equal(slim.suffixe, null);
    assert.equal(slim.sousAmendement, false);
    assert.equal(slim.sort, 'Adopté');
  });
}

test('zip64 sentinel without locator → explicit error', () => {
  const zip = buildZip([[SEANCE, AMDT]], { zip64: true });
  const broken = Buffer.concat([zip.subarray(0, zip.length - 22 - 20), Buffer.alloc(20), zip.subarray(zip.length - 22)]);
  assert.throws(() => readEocd(broken, 0), /localisateur/);
});

test('entry names: only floor (PO838901) entries count', () => {
  assert.deepEqual(parseEntryName(SEANCE), {
    dossier: 'DLR5L17N54629',
    texte: 'PRJLANR5L17B3210',
    uid: 'AMANR5L17PO838901B3210P1D1N000459',
    organe: 'PO838901',
  });
  assert.equal(isSeanceEntry(COMMISSION), false);
  assert.equal(parseEntryName('json/../x/y.json'), null);
});

test('planRanges: neighbours merge, far entries and the size cap split', () => {
  const e = (offset, csize = 100) => ({ offset, csize });
  const r = planRanges([e(5000), e(0), e(10_000_000)], { gap: 10_000, max: 1_000_000 });
  assert.equal(r.length, 2);
  assert.equal(r[0][0], 0);
  assert.equal(r[0][2].length, 2);
  const capped = planRanges([e(0, 600_000), e(600_100, 600_000)], { gap: 10_000, max: 1_000_000 });
  assert.equal(capped.length, 2);
});

test('dispositifHash ignores markup, entities, accents and spacing', () => {
  assert.equal(dispositifHash('<p>Supprimer cet article.</p>'), dispositifHash('Supprimer&nbsp;cet   ARTICLE'));
  assert.notEqual(dispositifHash('Supprimer cet article.'), dispositifHash('Rédiger ainsi cet article.'));
  assert.equal(dispositifHash(''), null);
});

test('amendementRefs reads the numbers a scrutin title names', () => {
  assert.deepEqual([...amendementRefs("l'amendement n° 1358 de M. X après l'article 2").nums], [1358]);
  assert.deepEqual([...amendementRefs('les amendements n° 12 et 14').nums].sort((a, b) => a - b), [12, 14]);
  assert.deepEqual([...amendementRefs('le sous-amendement n° 3001 rect.').nums], [3001]);
  assert.equal(amendementRefs("l'amendement n° 312 et les amendements identiques suivants").identiques, true);
  assert.equal(amendementRefs("l'article 5 du projet de loi").nums.size, 0);
});

/* ── the show-of-hands join, on real PLF 2027 records ── */
const T = 'PRJLANR5L17B3210';
const am = (numero, article, sort, dateSort, dispositif, part = 1) => ({
  uid: `AMANR5L17PO838901B3210P${part}D1N${String(numero).padStart(6, '0')}`,
  texte: T, numero, article, sort, dateSort, dispositif,
});
// Scrutin n° 8708 (14/10) names 312 « et les amendements identiques suivants »: 660, 2241 and 3448 went with it
// (compte rendu: 193 votants, 135 pour, 53 contre).
const CHAIN = [
  am(312, 'ART. LIMINAIRE', 'Adopté', '2026-10-14T16:59:32+02:00', '5b9e1dd3d1d16529'),
  am(660, 'ART. LIMINAIRE', 'Adopté', '2026-10-14T16:59:33+02:00', '5b9e1dd3d1d16529'),
  am(2241, 'ART. LIMINAIRE', 'Adopté', '2026-10-14T16:59:35+02:00', '5b9e1dd3d1d16529'),
  am(3448, 'ART. LIMINAIRE', 'Adopté', '2026-10-14T16:59:37+02:00', '5b9e1dd3d1d16529'),
];
const S8708 = { titre: "l'amendement n° 312 de M. Le Coq et les amendements identiques suivants de suppression de l'article liminaire du projet de loi de finances pour 2027 (première lecture).", date: '2026-10-14' };
// Scrutin n° 9346 (30/10) names 1387 alone; the compte rendu shows 1387, 1388 and 1390 adopted together.
const TRIO = [
  am(1387, 'ART. 17', 'Adopté', '2026-10-30T10:26:10+01:00', '6662a557d8d070dd'),
  am(1388, 'ART. 17', 'Adopté', '2026-10-30T10:26:11+01:00', '6662a557d8d070dd'),
  am(1390, 'ART. 17', 'Adopté', '2026-10-30T10:26:12+01:00', '6662a557d8d070dd'),
];
const S9346 = { titre: "l'amendement n° 1387 de M. Coquerel à l'article 17 (examen prioritaire) du projet de loi de finances pour 2027 (première lecture).", date: '2026-10-30' };
// Amendment n° 459, after art. 4, adopted 16/10 18:20 by show of hands: compte rendu « (L'amendement n° 459,
// repoussé par la commission et le gouvernement, est adopté.) », no scrutin announced, no tally.
const A459 = am(459, 'APRÈS ART. 4', 'Adopté', '2026-10-16T18:20:26+02:00', '96872f8f024ffd83');

test('real case: amendment n° 459 (PLF 2027) is a show-of-hands vote', () => {
  const out = mainLevee([...CHAIN, ...TRIO, A459], [S8708, S9346]);
  assert.deepEqual(out.map((a) => a.numero), [459]);
});

test('identical amendments follow the scrutin that names one of them, title wording aside', () => {
  assert.equal(mainLevee(CHAIN, [S8708]).length, 0);
  assert.equal(mainLevee(TRIO, [S9346]).length, 0);
  assert.equal(mainLevee(CHAIN, []).length, 4); // no scrutin at all → all four were show of hands
});

test('an identical text on another article, or with the other outcome, is not covered', () => {
  const other = am(424, 'ART. 5', 'Adopté', '2026-10-14T17:30:00+02:00', '5b9e1dd3d1d16529');
  const rejected = { ...CHAIN[1], uid: 'x', sort: 'Rejeté' };
  assert.deepEqual(mainLevee([...CHAIN, other, rejected], [S8708]).map((a) => a.uid), [other.uid, 'x']);
});

test('a scrutin more than a day away does not cover a reused number (other reading or budget part)', () => {
  const later = am(312, 'ART. 3', 'Rejeté', '2026-11-20T11:00:00+01:00', 'ffff', 2);
  const out = mainLevee([CHAIN[0], later], [S8708]);
  assert.deepEqual(out.map((a) => a.uid), [later.uid]);
});

test('only adopted / rejected amendments, and none decided after notAfter', () => {
  const fallen = am(10, 'ART. 1', 'Tombé', '2026-10-16T10:00:00+02:00', 'a');
  const withdrawn = am(11, 'ART. 1', 'Retiré', '2026-10-16T10:00:00+02:00', 'b');
  const pending = am(12, 'ART. 1', null, null, 'c');
  assert.deepEqual(mainLevee([fallen, withdrawn, pending, A459], []).map((a) => a.numero), [459]);
  assert.equal(mainLevee([A459], [], { notAfter: Date.parse('2026-10-16T16:00:00Z') }).length, 0);
  assert.equal(mainLevee([A459], [], { notAfter: Date.parse('2026-10-16T17:00:00Z') }).length, 1);
});

test('newest first', () => {
  const a = am(1, 'ART. 1', 'Rejeté', '2026-10-15T10:00:00+02:00', 'p');
  const b = am(2, 'ART. 1', 'Rejeté', '2026-10-16T10:00:00+02:00', 'q');
  assert.deepEqual(mainLevee([a, b], []).map((x) => x.numero), [2, 1]);
});

test('amendementRefs: qualifiers between the word and n° (real titles)', () => {
  // Scrutin n° 99 and ~190 others: « l'amendement de suppression n° 73 ».
  assert.deepEqual([...amendementRefs("l'amendement de suppression n° 73 de M. X à l'article 2").nums], [73]);
  assert.deepEqual([...amendementRefs("l'amendement de rétablissement n° 12").nums], [12]);
  assert.deepEqual([...amendementRefs("l'amendement de rédaction globale n° 5 rect.").nums], [5]);
  assert.deepEqual([...amendementRefs("l'amendement (rect.) n° 8").nums], [8]);
  // Never borrow the number of an article or of another scrutin.
  assert.equal(amendementRefs("l'amendement après l'article n° 3").nums.size, 0);
});

test('inflateEntry: a CRC mismatch or an oversized entry is refused', () => {
  const zip = buildZip([[SEANCE, AMDT]]);
  const tailStart = 0;
  const eocd = readEocd(zip, tailStart);
  const [e] = parseCentralDirectory(zip.subarray(eocd.cdOffset, eocd.cdOffset + eocd.cdSize));
  assert.ok(inflateEntry(zip, 0, e).includes('AMANR5L17PO838901'));
  assert.throws(() => inflateEntry(zip, 0, { ...e, crc: e.crc ^ 1 }), /CRC/);
  assert.throws(() => inflateEntry(zip, 0, { ...e, usize: 64 * 1024 * 1024 }), /trop grosse/);
});

test('zip: a local extra field and an archive comment are read past', () => {
  const zip = buildZip([[SEANCE, AMDT]], { zip64: true, extra: 32, comment: 'archive AN '.repeat(40) });
  const tailStart = Math.max(0, zip.length - 65_557);
  const eocd = readEocd(zip.subarray(tailStart), tailStart);
  const [e] = parseCentralDirectory(zip.subarray(eocd.cdOffset, eocd.cdOffset + eocd.cdSize));
  assert.equal(slimAmendement(JSON.parse(inflateEntry(zip, 0, e)), 'DLR5L17N54629').numero, 459);
});

test('amendementRefs: a stray « de » after n° (scrutin n° 2414) still gives the number', () => {
  const t = "l'amendement n° de 2102 de M. Travert à l'article 26 ter du projet de loi de simplification de la vie économique (première lecture).";
  assert.deepEqual([...amendementRefs(t).nums], [2102]);
  assert.equal(amendementRefs(t).opaque, false);
});

test('a scrutin on an amendment whose number cannot be read hides that day (when in doubt, leave out)', () => {
  const opaque = { titre: "l'amendement n° xx de M. X à l'article 4 du projet de loi de finances pour 2027 (première lecture).", date: '2026-10-16' };
  assert.equal(amendementRefs(opaque.titre).opaque, true);
  assert.equal(mainLevee([A459], [opaque]).length, 0);
  // A ratification « portant amendement » of a treaty is not about an amendment.
  const treaty = { titre: "l'article unique du projet de loi autorisant la ratification de la résolution portant amendement de l'article 6", date: '2026-10-16' };
  assert.equal(mainLevee([A459], [treaty]).length, 1);
});
