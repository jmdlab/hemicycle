/**
 * Floor amendments (séance publique) from the AN open-data archive Amendements.json.zip, and the
 * « vote à main levée » join: an amendment adopted or rejected in séance that no public scrutin names
 * was decided by show of hands (or sitting and standing), so there is no per-deputy record.
 *
 * The archive is ~350 MB and holds one small JSON per amendment. We never download it whole: the zip's
 * central directory (≈17 MB) is read with HTTP Range requests, and only floor entries whose CRC-32
 * changed since the last run are fetched, coalesced into a few large ranges. Pure helpers live here so
 * they can be tested without the network; scripts/refresh-amendements.mjs does the I/O.
 */

import { createHash } from 'node:crypto';
import { inflateRawSync, crc32 } from 'node:zlib';

export const AMENDEMENTS_URL =
  'https://data.assemblee-nationale.fr/static/openData/repository/17/loi/amendements_div_legis/Amendements.json.zip';

/** Organe « Assemblée nationale (séance publique) » of the 17th legislature. Commission amendments are out of scope. */
export const SEANCE_ORGANE = 'PO838901';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_Z64_EOCD = 0x06064b50;
const SIG_Z64_LOCATOR = 0x07064b50;
const LOCAL_HEADER_SLACK = 30 + 1024; // fixed header + room for name and extra field
/** One amendment JSON is a few kB; anything past this is a corrupt or hostile entry. */
export const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

/**
 * End Of Central Directory from the last bytes of the archive → { total, cdSize, cdOffset }.
 * `tailStart` is the absolute offset of `tail[0]`. Archives past 65 535 entries (this one) carry a zip64
 * record, found through its locator just before the classic record.
 */
export function readEocd(tail, tailStart = 0) {
  for (let i = tail.length - 22; i >= Math.max(0, tail.length - 22 - 0xffff); i--) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
    let total = tail.readUInt16LE(i + 10);
    let cdSize = tail.readUInt32LE(i + 12);
    let cdOffset = tail.readUInt32LE(i + 16);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = i - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== SIG_Z64_LOCATOR) throw new Error('zip64 : localisateur absent');
      const at = Number(tail.readBigUInt64LE(loc + 8)) - tailStart;
      if (at < 0 || at + 56 > tail.length || tail.readUInt32LE(at) !== SIG_Z64_EOCD) throw new Error('zip64 : fin de répertoire hors plage');
      total = Number(tail.readBigUInt64LE(at + 32));
      cdSize = Number(tail.readBigUInt64LE(at + 40));
      cdOffset = Number(tail.readBigUInt64LE(at + 48));
    }
    return { total, cdSize, cdOffset };
  }
  throw new Error('fin de répertoire zip introuvable');
}

/** Central directory buffer → [{ name, crc, method, csize, usize, offset }]. */
export function parseCentralDirectory(cd) {
  const out = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === SIG_CENTRAL) {
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    if (cd.readUInt32LE(p + 42) === 0xffffffff || cd.readUInt32LE(p + 20) === 0xffffffff) throw new Error('entrée zip64 non gérée');
    out.push({
      name: cd.toString('utf8', p + 46, p + 46 + nameLen),
      method: cd.readUInt16LE(p + 10),
      crc: cd.readUInt32LE(p + 16),
      csize: cd.readUInt32LE(p + 20),
      usize: cd.readUInt32LE(p + 24),
      offset: cd.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const ENTRY_RE = /^json\/(DLR[0-9A-Z]+)\/([0-9A-Z]+)\/(AMANR5L\d+(PO\d+)[0-9A-Z]+)\.json$/;

/** Path → { dossier, texte, uid, organe } or null. */
export function parseEntryName(name) {
  const m = ENTRY_RE.exec(name);
  return m ? { dossier: m[1], texte: m[2], uid: m[3], organe: m[4] } : null;
}

export const isSeanceEntry = (name) => parseEntryName(name)?.organe === SEANCE_ORGANE;

/**
 * Group entries (sorted by offset) into byte ranges: neighbours closer than `gap` share one request,
 * and no range grows past `max` bytes. Each range is [start, endInclusive, entries].
 */
export function planRanges(entries, { gap = 256 * 1024, max = 8 * 1024 * 1024 } = {}) {
  const sorted = [...entries].sort((a, b) => a.offset - b.offset);
  const ranges = [];
  for (const e of sorted) {
    const end = e.offset + LOCAL_HEADER_SLACK + e.csize - 1;
    const last = ranges[ranges.length - 1];
    if (last && e.offset - last[1] <= gap && end - last[0] + 1 <= max) {
      last[1] = Math.max(last[1], end);
      last[2].push(e);
    } else {
      ranges.push([e.offset, end, [e]]);
    }
  }
  return ranges;
}

/** Inflate one entry out of a range buffer that starts at byte `base` of the archive. */
export function inflateEntry(buf, base, e) {
  const at = e.offset - base;
  if (buf.readUInt32LE(at) !== SIG_LOCAL) throw new Error(`en-tête local corrompu : ${e.name}`);
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const raw = buf.subarray(start, start + e.csize);
  if (raw.length !== e.csize) throw new Error(`plage trop courte : ${e.name}`);
  if (!(e.usize <= MAX_ENTRY_BYTES) || e.csize > MAX_ENTRY_BYTES) throw new Error(`entrée trop grosse : ${e.name}`);
  let out;
  if (e.method === 0) out = raw;
  else if (e.method === 8) out = inflateRawSync(raw, { maxOutputLength: e.usize || 1 });
  else throw new Error(`compression ${e.method} non gérée : ${e.name}`);
  if (out.length !== e.usize || crc32(out) >>> 0 !== e.crc >>> 0) throw new Error(`contrôle CRC en échec : ${e.name}`);
  return out.toString('utf8');
}

const nil = (v) => (v && typeof v === 'object' && v['@xsi:nil'] ? null : v ?? null);
const str = (v) => {
  const x = nil(v);
  return typeof x === 'string' && x.trim() ? x.trim() : null;
};

/** Operative text, tags and spacing stripped, hashed: identical amendments share it by definition. */
export function dispositifHash(html) {
  const t = String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return t ? createHash('sha256').update(t).digest('hex').slice(0, 16) : null;
}

/** One amendment JSON (as published) → the few fields Hémicycle uses. */
export function slimAmendement(json, dossier) {
  const a = json?.amendement ?? json;
  const id = a?.identification ?? {};
  const cycle = a?.cycleDeVie ?? {};
  const auteur = a?.signataires?.auteur ?? {};
  const div = a?.pointeurFragmentTexte?.division ?? {};
  const parent = nil(a?.amendementParentRef);
  return {
    uid: a?.uid ?? null,
    dossier: dossier ?? null,
    texte: str(a?.texteLegislatifRef),
    numero: Number(id.numeroOrdreDepot) || null,
    numeroLong: str(id.numeroLong),
    sousAmendement: !!str(parent),
    article: str(div.articleDesignationCourte) ?? str(div.titre),
    auteurType: str(auteur.typeAuteur),
    auteurRef: str(auteur.acteurRef),
    groupeRef: str(auteur.groupePolitiqueRef),
    suffixe: str(a?.signataires?.suffixe),
    sort: str(cycle.sort),
    dateSort: str(cycle.dateSort),
    seance: str(a?.seanceDiscussionRef),
    dispositif: dispositifHash(a?.corps?.contenuAuteur?.dispositif),
  };
}

/* ── the show-of-hands join ─────────────────────────────────────────────── */

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Decided by a vote: only these two outcomes (Tombé, Retiré, Non soutenu… were never put to a vote). */
export const voteSort = (sort) => {
  const f = fold(sort);
  return f === 'adopte' ? 'adopté' : f === 'rejete' ? 'rejeté' : null;
};

/**
 * Amendment numbers a scrutin title names: « l'amendement n° 1358 », « les amendements n° 12 et 14 »,
 * « le sous-amendement n° 3001 ». `identiques` is true for « … et les amendements identiques suivants ».
 */
export function amendementRefs(titre) {
  const t = fold(titre).replace(/ /g, ' ');
  const nums = new Set();
  // Up to 40 characters of qualifier between the word and « n° »: « amendement de suppression n° 73 »,
  // « de rétablissement », « de rédaction globale », « (rect.) ». Never across another numbered thing.
  for (const m of t.matchAll(/(?:sous-)?amendements?\b([^\d°]{0,40}?)\bn\s*[°o]s?\s*(?:de\s+)?((?:\d+(?:\s*rect\.?)?(?:\s*,\s*|\s+et\s+)?)+)/g)) {
    if (/\barticles?\b|\bscrutin\b/.test(m[1])) continue;
    for (const n of m[2].match(/\d+/g) ?? []) nums.add(Number(n));
  }
  // A title about an amendment whose number cannot be read (« l'amendement n° de 2102 » once) is opaque.
  const opaque = nums.size === 0 && /^(?:l'|l’|les |le )(?:sous-)?amendements?\b/.test(t.trim());
  return { nums, identiques: /\bidentiques?\b/.test(t), opaque };
}

const DAY = 86_400_000;

/** Identical amendments: same text, same article, same operative text — and, being voted together, the same outcome. */
const identityKey = (a) => (a.dispositif ? `${a.texte}|${a.article}|${a.dispositif}|${voteSort(a.sort)}` : null);

/**
 * Floor amendments of one dossier decided without a public scrutin, newest first.
 *
 * `scrutins`: [{ titre, date }] — the public scrutins on that dossier. An amendment is covered when
 *  - a scrutin title names its number and the scrutin date is within a day of the decision (numbers repeat
 *    across readings and across the two parts of a budget bill), or
 *  - it is identical to a covered one (same text, article, operative text and outcome): identical
 *    amendments are always put to one vote, even when the scrutin title names only the first (scrutin
 *    n° 9346 names 1387 alone; the compte rendu shows 1387, 1388 and 1390 adopted together). Timing
 *    cannot tell: identical amendments were seen decided from 0 s to 4 min apart.
 * When in doubt an amendment is left out: hiding a show-of-hands vote is better than calling a recorded
 * vote one, so amendments decided within a day of a scrutin whose title names an amendment without a readable
 * number are left out too. `notAfter` (ms): amendments decided after the scrutins we hold were published are left out —
 * a scrutin on them may simply not be published yet.
 */
const namedCache = new WeakMap(); // scrutins array → { named, opaqueDays }

/** numero → [scrutin day (ms)], and the days of scrutins on an amendment whose number cannot be read. */
function namedNumbers(scrutins) {
  const hit = namedCache.get(scrutins);
  if (hit) return hit;
  const named = new Map();
  const opaqueDays = [];
  for (const s of scrutins) {
    const day = Date.parse(String(s.date ?? '').slice(0, 10));
    const refs = amendementRefs(s.titre);
    if (refs.opaque && Number.isFinite(day)) opaqueDays.push(day);
    for (const n of refs.nums) {
      if (!named.has(n)) named.set(n, []);
      named.get(n).push(day);
    }
  }
  const value = { named, opaqueDays };
  namedCache.set(scrutins, value);
  return value;
}

export function mainLevee(amendements, scrutins, { notAfter = Infinity } = {}) {
  const { named, opaqueDays } = namedNumbers(scrutins);
  const at = (a) => Date.parse(a.dateSort);
  const voted = amendements.filter((a) => a.numero && voteSort(a.sort) && Number.isFinite(at(a)));
  const covered = new Set();
  const identicalKeys = new Set();
  for (const a of voted) {
    const aDay = Date.parse(a.dateSort.slice(0, 10));
    for (const day of named.get(a.numero) ?? []) {
      if (Number.isFinite(day) && Math.abs(aDay - day) > DAY) continue;
      covered.add(a.uid);
      if (identityKey(a)) identicalKeys.add(identityKey(a));
    }
  }
  // In doubt, leave out: no amendment decided within a day of an unreadable amendment scrutin.
  const nearOpaque = (a) => {
    const aDay = Date.parse(a.dateSort.slice(0, 10));
    return opaqueDays.some((d) => Math.abs(aDay - d) <= DAY);
  };
  return voted
    .filter((a) => !covered.has(a.uid) && !identicalKeys.has(identityKey(a)) && at(a) <= notAfter && !nearOpaque(a))
    .sort((a, b) => at(b) - at(a) || b.numero - a.numero);
}
