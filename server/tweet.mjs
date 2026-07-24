// tweet.mjs — neutral French caption for a scrutin card.
//
// DEFAULT PATH IS MODEL-FREE. `fallbackTweet` is a pure format-string over the
// Assemblée's own fields: it cannot be biased because no model touched it, it
// costs nothing, and it answers instantly — which is what lets this run as a
// public site. It is the default, not a degraded mode.
//
// With SCRUTIN_LLM=on, a model may draft instead, and a deterministic validator
// decides whether to keep it. On violation we do NOT ask the model to fix
// itself — a model arguing its way into compliance is how bias survives — we
// simply take the format-string.
//
// The tweet never carries the source URL: house convention is the AN link goes
// in a reply, not in the main tweet.

import { createRequire } from 'node:module';
import { checkNeutrality, explain, RULES_FR } from './neutrality.mjs';
import { plainSummary } from './plain.mjs';

const require = createRequire(import.meta.url);
// Loaded lazily, not at import: index.mjs pulls these modules in at boot for
// their cache-read paths, and a public service must not fail to start because a
// file in another project moved. Path overridable for the same reason.
const CLI_PATH = process.env.SCRUTIN_CLAUDE_CLI || '/home/ubuntu/www/denis.me/river-brain/lib/claude-cli.cjs';
const runText = (...a) => require(CLI_PATH).runText(...a);

const MAX = 260;

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
  'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export function frDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  if (!m) return String(iso ?? '');
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** Shorten an official title on a word boundary, never mid-word. */
function shorten(titre, max) {
  const t = String(titre ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > 20 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, '') + '…';
}

/**
 * Deterministic, always-neutral caption. Degradation ladder: drop the trailing
 * sentence, then the abstentions clause, then shorten the title — never a
 * mid-word truncation.
 */
export function fallbackTweet(s) {
  const { numero, date, sort, synthese: y, effectif } = s;
  // The Assemblée publishes a human-written title for the bill alongside the
  // legal one; it is far more readable and equally official.
  const titre = plainSummary(s) || s.titre;
  const resultat = sort === 'adopté' ? 'Adoptée' : 'Rejetée';
  const d = frDate(date);

  const build = (titleMax, withTail, withAbst) => {
    const short = shorten(titre, titleMax);
    // A truncated title already ends in "…" — don't stack a second full stop.
    const sep = short.endsWith('…') ? '' : '.';
    const parts = [
      `Assemblée nationale, scrutin n°${numero} du ${d} : ${short}${sep} ${resultat}.`,
      withAbst
        ? `${y.pour} pour, ${y.contre} contre, ${y.abstention} abstentions.`
        : `${y.pour} pour, ${y.contre} contre.`,
      `Majorité absolue : ${y.majorite} sur ${y.exprimes} exprimés.`,
    ];
    if (withTail) parts.push(`${y.votants} votants sur ${effectif} sièges.`);
    return parts.join(' ');
  };

  for (const [tm, tail, abst] of [
    [110, true, true], [110, false, true], [90, false, true],
    [90, false, false], [60, false, false], [40, false, false],
  ]) {
    const t = build(tm, tail, abst);
    if (t.length <= MAX) return t;
  }
  return build(30, false, false).slice(0, MAX);
}

function buildPrompt(s) {
  const { numero, date, titre, sort, synthese: y, effectif } = s;
  const absents = effectif - y.votants - (y.nonVotants ?? 0);
  return `Tu rédiges une légende factuelle pour un graphique de scrutin de l'Assemblée nationale.

DONNÉES (seule source autorisée) :
  scrutin      : n°${numero}, ${frDate(date)}
  objet        : ${titre}
  résultat     : ${sort === 'adopté' ? 'Adoptée' : 'Rejetée'}
  pour ${y.pour} · contre ${y.contre} · abstentions ${y.abstention}
  votants ${y.votants} · exprimés ${y.exprimes} · majorité absolue ${y.majorite}
  non-votants ${y.nonVotants ?? 0} · absents ${absents} sur ${effectif} sièges

RÈGLES ABSOLUES :
${RULES_FR.map((r, i) => `${i + 1}. ${r}`).join('\n')}
${RULES_FR.length + 1}. Français, ${MAX} caractères maximum, espaces compris.
${RULES_FR.length + 2}. Contenu : l'objet du vote, le résultat, et les chiffres marquants.

Réponds UNIQUEMENT par le texte de la légende. Pas de guillemets, pas de commentaire.`;
}

/**
 * Generate the caption. Never throws: on any failure it returns the fallback.
 * @returns {Promise<{text:string, source:'llm'|'fallback', reason?:string}>}
 */
export async function makeTweet(s, opts = {}) {
  const fallback = fallbackTweet(s);
  if (opts.noLlm) return { text: fallback, source: 'fallback', reason: 'llm désactivé' };

  let draft;
  try {
    draft = await runText(buildPrompt(s), {
      model: 'haiku',
      channel: 'scrutin',
      tools: [],                 // public surface: no Read/Bash/Write
      cache: true,               // deterministic input → free on re-render
      timeoutMs: 60_000,
      label: 'scrutin.tweet',
    });
  } catch (e) {
    return { text: fallback, source: 'fallback', reason: `appel échoué: ${e.message}` };
  }

  const text = String(draft ?? '')
    .trim()
    .replace(/^["'«»\s]+|["'«»\s]+$/g, '')
    .replace(/\s+/g, ' ');

  const verdict = checkNeutrality(text, { maxLen: MAX, verbatim: [s.titre] });
  if (!verdict.ok) {
    return { text: fallback, source: 'fallback', reason: `neutralité refusée — ${explain(verdict)}` };
  }
  return { text, source: 'llm' };
}
