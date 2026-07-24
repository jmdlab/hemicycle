// plain.mjs — the LLM-free layer.
//
// Everything here is derived from the Assemblée's own fields by rule, so it can
// serve an anonymous public audience at any volume: no model call, no API key,
// no rate limit, no per-visitor cost, and a response in microseconds instead of
// tens of seconds. It is also, by construction, incapable of inventing: every
// string is either an official AN field or a fixed label chosen by a regex.
//
// This is the DEFAULT layer. When the owner runs the optional model pass, its
// output replaces these strings for cached rows — but the page never depends on
// it being there.

/* ── summary: the bill's own title, tidied ──────────────────────────────── */

// Only strip the lead when what follows is a VERB PHRASE that can stand alone
// ("…visant à protéger les mineurs" → "Protéger les mineurs"). Stripping before
// "relatif à" or a bare complement leaves broken French — "Projet de loi relatif
// à la protection des enfants" must keep its head.
const LEAD = /^\s*(?:projet|proposition)\s+de\s+(?:loi|résolution)(?:\s+organique|\s+constitutionnelle)?\s+(?:visant\s+à|tendant\s+à|portant)\s+/i;

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * A readable one-liner. `dossierTitre` is an editorial title the AN publishes
 * alongside the ballot and it is already written for humans — far better than
 * anything we could reconstruct from the legal title, and official.
 */
export function plainSummary(s, doc) {
  const dossier = String(s?.dossierTitre ?? '').trim();
  if (dossier) return cap(dossier.replace(LEAD, '').trim());

  // Fallback: strip the legal boilerplate off the ballot title.
  let t = String(s?.titre ?? doc?.titre ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^l['’]ensemble (de la|du|des|de l['’])\s*/i, '');
  t = t.replace(/\s*\((texte de la commission[^)]*|première lecture|deuxième lecture|nouvelle lecture|lecture définitive)\)\s*\.?$/i, '');
  t = t.replace(LEAD, '');
  return cap(t.replace(/\.$/, '').trim());
}

/* ── detail: what KIND of ballot this is, and on which text ─────────────── */

const KIND = [
  [/motion de censure/i, 'Motion de censure'],
  [/motion de rejet préalable/i, 'Motion de rejet préalable'],
  [/question préalable/i, 'Question préalable'],
  [/motion référendaire/i, 'Motion référendaire'],
  [/sous-amendement\s*n[°º]\s*(\d+)/i, 'Sous-amendement n° $1'],
  [/amendement[s]?\s*n[°º]\s*(\d+)/i, 'Amendement n° $1'],
  [/amendement/i, 'Amendement'],
  [/l['’]article\s+(\d+[a-z]*)/i, 'Article $1'],
  [/^l['’]ensemble d/i, 'Vote sur l’ensemble du texte'],
  [/déclaration du gouvernement/i, 'Déclaration du Gouvernement'],
  [/prolongation|prolonger la séance|au-delà/i, 'Organisation de la séance'],
];

const READING = [
  [/première lecture/i, 'première lecture'],
  [/deuxième lecture/i, 'deuxième lecture'],
  [/nouvelle lecture/i, 'nouvelle lecture'],
  [/lecture définitive/i, 'lecture définitive'],
  [/commission mixte paritaire|texte de la cmp/i, 'commission mixte paritaire'],
];

/**
 * What this ballot actually is — "Amendement n° 1 du Gouvernement", "Motion de
 * rejet préalable", "Vote sur l'ensemble du texte" — plus the reading and the
 * text it belongs to. For a procedural ballot this is precisely the information
 * the legal title buries and the summary line cannot carry.
 */
export function plainDetail(s, doc) {
  const titre = String(s?.titre ?? doc?.titre ?? '');
  const bits = [];

  let kind = '';
  for (const [re, label] of KIND) {
    const m = re.exec(titre);
    if (m) { kind = label.replace('$1', m[1] ?? ''); break; }
  }
  if (/du gouvernement/i.test(titre) && /amendement/i.test(kind)) kind += ' du Gouvernement';
  if (kind) bits.push(kind);

  for (const [re, label] of READING) {
    if (re.test(titre)) { bits.push(label); break; }
  }

  const dossier = String(s?.dossierTitre ?? '').trim();
  const line = bits.join(' · ');
  // The summary line already shows the bill; repeating it here is noise. Only
  // name the parent text when the summary shows something else.
  const summaryShowsIt = plainSummary(s, doc) === cap(dossier.replace(LEAD, '').trim());
  if (dossier && !doc?.final && !summaryShowsIt) {
    return line ? `${line} — ${cap(dossier)}` : cap(dossier);
  }
  return line || null;
}

/* ── salience: transparent keyword domains, no model ────────────────────── */

// Leading \b only, no trailing one: /\benfant\b/ fails on "enfants" because the
// plural "s" is itself a word character. Prefix matching is what we want here.
// Matched against ACCENT-FOLDED text. JS `\b` is an ASCII word boundary, so
// /\bsécurité\b/ silently fails — "é" is not a word character, so there is no
// boundary after it. Folding first is the only reliable way. (Same trap that
// made /\bsemble\b/ fire inside "Assemblée" in the neutrality validator.)
const DOMAINS_3 = /\b(sante|hopital|medecin|soin|ecole|scolaire|education|college|lycee|impot|fiscal|taxe|retraite|pension|salaire|smic|pouvoir d'achat|logement|loyer|securite|police|gendarmerie|enfant|mineur|reseaux sociaux|internet|numerique|energie|electricite|carburant|essence|transport|train|alimentation|emploi|chomage|handicap|violence)/;
const DOMAINS_2 = /\b(entreprise|pme|artisan|agricol|agricult|industrie|universite|recherche|justice|prison|immigration|asile|outre-mer|commune|collectivite|sport|culture|defense|armee|climat|environnement|dechet)/;
const PROCEDURAL = /^(motion|l['’]article|sous-amendement|amendement|la prolongation|la demande)/i;

function fold(x) {
  return String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * 0–3, from curated everyday-life domains matched against the official title.
 * Transparent and auditable: the reason is always "this word appeared".
 */
export function keywordSalience(s, doc) {
  const hay = fold(`${s?.dossierTitre ?? ''} ${s?.titre ?? doc?.titre ?? ''}`);
  if (DOMAINS_3.test(hay)) return 3;
  if (DOMAINS_2.test(hay)) return 2;
  if (PROCEDURAL.test(String(s?.titre ?? '').trim())) return 0;
  return 1;
}
