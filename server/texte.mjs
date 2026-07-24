// texte.mjs — fetch and read the actual bill, not just its title.
//
// This is what removes the guesswork. A title states the sponsor's intent
// ("protéger les mineurs"); the articles state the mechanism ("impose aux
// plateformes de vérifier l'âge"). Anything said about what a law does has to
// come from the second, or it is the model's memory wearing a citation.
//
// Everything here is sourced from assemblee-nationale.fr. Extracted text is
// cached on disk; the PDFs are not kept — they are re-fetchable and up to 40×
// heavier than the text we need from them.

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'storage', 'textes');
const INDEX = path.join(ROOT, 'storage', 'index', 'textes.json');
const UA = 'hemicycle/1.0 (+https://hemicycle.app)';

/** Reference prefix → the slug the AN uses in its document URLs. */
const KIND = {
  PRJL: 'projet-loi',
  PION: 'proposition-loi',
  PNRE: 'proposition-resolution-europeenne',
  PNRP: 'proposition-resolution',
  RAPP: 'rapport',
  RINF: 'rapport-information',
  ETDI: 'etude-impact',
  AVCE: 'avis-conseil-etat',
  TACO: 'texte-adopte',
};

/** Documents that carry the text itself, best first. Reports and studies are
 *  about the text; we want the text. */
const PREFERRED = ['PRJL', 'PION', 'PNRE', 'PNRP', 'TACO'];

let _index = null;
let _indexMtime = -1;

/**
 * Dossier → document references, memoised but invalidated on disk change —
 * the same contract as loadIndex() in data/store.mjs, and for the same reason:
 * the nightly pipeline rewrites this file under a long-running API process.
 *
 * Memoising unconditionally had a second, worse failure: the `{}` fallback for
 * a missing file is truthy, so a service that started before the index existed
 * cached "no document for any dossier" permanently, and every bill silently
 * became unreadable.
 */
function loadRefIndex() {
  let mtime = -1;
  try { mtime = fssync.statSync(INDEX).mtimeMs; } catch { /* absent → -1 */ }
  if (_index && mtime === _indexMtime) return _index;
  _index = mtime >= 0 ? JSON.parse(fssync.readFileSync(INDEX, 'utf8')) : {};
  _indexMtime = mtime;
  return _index;
}

/**
 * Parse a reference like `PRJLANR5L17B2632`.
 * @returns {{kind:string, chamber:string, legislature:number, num:string}|null}
 */
export function parseRef(ref) {
  const m = /^([A-Z]{4})(AN|SN)R5[LS](\d+)B(\d+)$/.exec(String(ref ?? ''));
  if (!m) return null;
  return { kind: m[1], chamber: m[2], legislature: Number(m[3]), num: m[4] };
}

/**
 * The PDF URL for an AN document. Senate documents live on senat.fr and are not
 * handled here. The leading zeros matter — `l17b942` 404s where `l17b0942`
 * resolves — and the reference already carries them, so they are never guessed.
 */
export function pdfUrl(ref) {
  const p = parseRef(ref);
  if (!p || p.chamber !== 'AN') return null;
  const slug = KIND[p.kind];
  if (!slug) return null;
  return `https://www.assemblee-nationale.fr/dyn/${p.legislature}/textes/l${p.legislature}b${p.num}_${slug}.pdf`;
}

/** The document most likely to BE the text, for a given dossier. */
export function textRefFor(dossierRef) {
  const refs = loadRefIndex()[dossierRef] ?? [];
  const an = refs.filter((r) => parseRef(r)?.chamber === 'AN');
  for (const kind of PREFERRED) {
    const hit = an.find((r) => parseRef(r)?.kind === kind);
    if (hit) return hit;
  }
  return null;
}

/* ── fetch + extract ────────────────────────────────────────────────────── */

/**
 * Extracted plain text for a document reference, cached on disk.
 * Returns null when the document is not an AN PDF or the fetch fails — callers
 * must treat a missing text as "say nothing", never as "infer instead".
 */
export async function fetchTexte(ref, { force = false, timeoutMs = 60_000 } = {}) {
  const url = pdfUrl(ref);
  if (!url) return null;

  await fs.mkdir(CACHE, { recursive: true });
  const txtPath = path.join(CACHE, `${ref}.txt`);
  if (!force && fssync.existsSync(txtPath)) {
    return { ref, url, text: await fs.readFile(txtPath, 'utf8'), cached: true };
  }

  const pdfPath = path.join(CACHE, `${ref}.pdf`);
  try {
    await execFileP('curl', [
      '-sSL', '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '-A', UA, '-o', pdfPath, url,
    ], { timeout: timeoutMs + 5_000 });

    const head = await fs.readFile(pdfPath, { encoding: 'latin1', flag: 'r' }).then((b) => b.slice(0, 5));
    if (!head.startsWith('%PDF')) throw new Error('réponse non-PDF (page d’erreur ?)');

    await execFileP('pdftotext', ['-layout', pdfPath, txtPath], { timeout: 120_000 });
    const text = await fs.readFile(txtPath, 'utf8');
    return { ref, url, text, cached: false };
  } catch (e) {
    // A missing text and a broken toolchain (curl blocked, pdftotext gone) must
    // not look the same: without this line the whole "texte en clair" pipeline
    // could go dark with nothing in the log to say why.
    console.error('fetchTexte', ref, String(e.message).slice(0, 120));
    await fs.unlink(txtPath).catch(() => {});
    return null;
  } finally {
    // The PDF is a means, not an artefact: 40× the size of the text we keep.
    await fs.unlink(pdfPath).catch(() => {});
  }
}

/* ── split into the two things that matter ──────────────────────────────── */

const RE_EXPOSE = /EXPOS[ÉE]\s+DES\s+MOTIFS/i;
// Single-article bills head their enacting text "Article unique", not
// "Article 1er". They are a large share of propositions de loi, and missing
// them read as "texte indisponible" on bills whose text was right there.
const RE_ARTICLE1 = /^\s*Article\s+(1\s*er|premier|unique|1)\b/im;

/**
 * Separate the sponsors' stated intent from the enacting text.
 *
 * Keeping them apart is the whole point: the exposé des motifs is advocacy
 * written by the people proposing the law, and presenting it as a neutral
 * description of the text would repeat their framing. The articles are what
 * actually takes effect.
 */
export function splitTexte(raw) {
  const text = String(raw ?? '').replace(/\r/g, '');
  if (!text.trim()) return { expose: null, articles: null };

  const mE = RE_EXPOSE.exec(text);
  const mA = RE_ARTICLE1.exec(text);

  let expose = null;
  if (mE) {
    const start = mE.index + mE[0].length;
    const end = mA && mA.index > start ? mA.index : Math.min(text.length, start + 20_000);
    expose = clean(text.slice(start, end));
  }
  const articles = mA ? clean(text.slice(mA.index)) : null;
  return { expose: expose || null, articles: articles || null };
}

function clean(s) {
  return s
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    // Page furniture from the PDF layout: bare page numbers and running heads.
    .filter((l) => !/^\s*[–-]?\s*\d{1,4}\s*[–-]?\s*$/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Everything a caller needs for one ballot's underlying text. */
export async function texteForScrutin(s) {
  const ref = textRefFor(s?.dossierRef);
  if (!ref) return null;
  const got = await fetchTexte(ref);
  if (!got) return null;
  const { expose, articles } = splitTexte(got.text);
  if (!expose && !articles) return null;
  return { ref, url: got.url, expose, articles, cached: got.cached };
}
