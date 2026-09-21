# scrutin — data layer

Everything the app knows about Assemblée nationale ballots. Zero runtime
dependencies (Node 22 `fetch` + `node:zlib` + a small inline ZIP reader), zero
network access at request time: the API only ever reads `storage/`.

```
scripts/refresh-data.mjs   ── downloads, normalizes, indexes (cron nightly)
server/data/
  index.mjs      barrel: getScrutin, resolve, verify, stats
  store.mjs      storage paths, atomic writes, memoised readers
  zip.mjs        inline ZIP reader (no unzipper/adm-zip dependency)
  groups.mjs     organeRef -> group identity, incl. pinned aliases
  normalize.mjs  raw AN JSON -> normalized schema
  qa.mjs         arithmetic gates
  text.mjs       folding, tokenising, bill/reading/law-code extraction
  search.mjs     BM25 index builder + query resolution
  law.mjs        codeLoi -> dossier -> scrutins
```

## Usage

```js
import { getScrutin, resolve, verify, stats, lookupLaw } from './server/data/index.mjs';

getScrutin(8431);            // one normalized ballot, or null
resolve('réseaux sociaux');  // {interpretation, candidates[], ambiguous, note}
verify(8431);                // {ok, checks:[...]} for one ballot
verify();                    // sweep every ballot -> per-gate failure counts
lookupLaw('2026-630');       // {status:'ok'|'no_public_ballot'|'unknown_law', ...}
stats();                     // corpus counts
```

## Refresh

```bash
node scripts/refresh-data.mjs              # normal run (~3 s warm, ~5 s cold)
node scripts/refresh-data.mjs --force      # ignore ETag cache
node scripts/refresh-data.mjs --skip-download
```

Idempotent. Downloads are skipped when the remote `ETag`/`Last-Modified` is
unchanged, and a normalized record is only rewritten when its content actually
differs — a nightly run typically touches a handful of files.

Cron:

```
17 4 * * * cd <REPO_ROOT> && mkdir -p logs && node scripts/refresh-data.mjs >> logs/refresh.log 2>&1
```

A long-running API process does **not** need restarting afterwards: `loadIndex`
invalidates its memo when `search.json` changes on disk.

### Sources

| Source | Content |
|---|---|
| `…/17/loi/scrutins/Scrutins.json.zip` | 8 434 ballots (26 MB) |
| `…/17/loi/dossiers_legislatifs/Dossiers_Legislatifs.json.zip` | 2 985 dossiers (10 MB) |
| `…/17/amo/deputes_actifs_mandats_actifs_organes/AMO10_…zip` | 7 132 organes (5 MB) |

There is **no per-scrutin JSON endpoint**. `…/scrutins/8429.json` answers HTTP
200 with an HTML body — never use it. The bulk ZIP is the only correct source.

## Normalized schema

```jsonc
{
  "numero": 8431, "legislature": 17, "date": "2026-07-21",
  "titre": "l'ensemble de la proposition de loi visant à protéger les mineurs…",
  "sort": "adopté",                    // | "rejeté"
  "typeVote": { "code": "SPS", "libelle": "scrutin public solennel" },
  "typeMajorite": "Majorité absolue des suffrages exprimés",
  "demandeur": "Conférence des Présidents",
  "synthese": { "votants": 426, "exprimes": 360, "majorite": 181,
                "pour": 279, "contre": 81, "abstention": 66, "nonVotants": 2 },
  "effectif": 577,                     // Σ membres — computed, never hardcoded
  "groupes": [ { "organeRef": "PO845401", "abbrev": "RN",
                 "nom": "Rassemblement National", "couleur": "#313567",
                 "membres": 122, "pour": 0, "contre": 2, "abstention": 14,
                 "nonVotant": 1, "absent": 105, "positionMajoritaire": "contre" } ],
  "dossierRef": "DLR5L17N53187",
  "dossierTitre": "Protéger les mineurs des risques…",
  "sourceUrl": "https://www.assemblee-nationale.fr/dyn/17/scrutins/8431"
}
```

**Group order is fixed: `membres` descending.** Never reorder by voting
behaviour — which group appears first is an editorial claim about who mattered,
and the data layer does not make claims.

## Things the raw data will get you wrong

Each of these was validated across all 8 434 ballots.

**The Assembly is not 577 members.** Seats fall vacant between by-elections:
577 × 4 519, 575 × 2 316, 576 × 1 567, 574 × 32. Hardcoding 577 is wrong 46 % of
the time. `effectif` is computed as `Σ membres` and used everywhere.

**The majority threshold has two rules.** Ordinary ballots need an absolute
majority of votes cast; motions de censure need an absolute majority of sitting
members. And the censure threshold is *not* a fixed 289 — it tracks the vacancy
count (289 at 576-577 seats, 288 at 574-575). One formula covers both and
reproduces `nbrSuffragesRequis` exactly, 0 failures over 8 434:

```
majorité = ⌊base/2⌋ + 1      base = effectif for censure, exprimés otherwise
```

**`nonVotantsVolontaires` is a trap.** At group level it mirrors the abstention
count (identical number, empty nominal list) while the synthesis reports 0.
Summing it "fails" on 6 203 ballots and subtracting it double-counts
abstentions. It is not used. Absences are derived instead:

```
absent = membres − pour − contre − abstention − nonVotant
```

**Two group refs do not resolve.** `PO847173` (used by 3 041 ballots) is the
original *Union des droites pour la République*, dissolved and re-registered as
`PO872880`; only the new ref ships in AMO10. `PO0` is a placeholder in 14 early
ballots. Both are pinned in `groups.mjs` — without them ~36 % of ballots would
render a raw `PO847173` label.

**Use `libelleAbrege`, not `libelleAbrev`.** For `PO872880` the former is `UDR`
(what the AN publishes) and the latter the administrative `UDDPLR`. Likewise
`EcoS`/`Dem` vs `ECOS`/`DEM`.

**`objet.referenceLegislative` is null in all 8 434 records.** Unusable.
`dossierRef` is present on only 30.9 %.

## QA gates

`verify(record)` returns `{ok, checks:[{id,label,ok,expected,actual}]}`.
Current sweep over all 8 434 ballots:

| Gate | Failures |
|---|---|
| `sum_pour` / `sum_contre` / `sum_abstention` | 0 |
| `votants` (pour+contre+abstentions) | 0 |
| `exprimes` (pour+contre) | 0 |
| `majorite_formula` | 0 |
| `effectif_plausible` (550–577) | 0 |
| `absents_non_negatifs` | 0 |
| `ventilation_complete` | 0 |
| `sum_non_votants` | **1** |

The single failure is an upstream data anomaly, not a bug: scrutin n°1 (motion
de censure, 2024-10-08) reports 10 non-votants in the synthesis but 21 across
its groups. Left visible on purpose rather than papered over.

## Search

BM25 (k1 = 1.2, b = 0.75) over accent-folded, stopworded titles — 4 154 terms.
`resolve(query)` picks one of three paths:

- pure digits → `numero`, direct lookup, no search;
- `loi n° 2024-1177` → `reference`, via the law index;
- anything else → `topic`, BM25.

Only 2.6 % of ballots (222 of 8 434) are final votes on a whole text; 76 % are
amendments. So final votes get a ×2.5 boost, and results collapse to the best
ballot per bill (265 bills, extracted by regex from the title) — otherwise a
search returns eight amendments to the same text.

**`resolve` never auto-picks.** It returns at most 8 candidates and sets
`ambiguous: true` with an explanatory `note` whenever more than one bill or more
than one reading matches. Choosing among them is the caller's job.

## Laws

`codeLoi` lives on the `PROM-PUB` act inside a dossier; ballots reference the
dossier through `dossierRef`. Only **24 of 134** promulgated laws in the export
trace to a ballot. That is expected — most texts are adopted by show of hands,
and `dossierRef` is missing from 69 % of ballots. `lookupLaw` therefore
distinguishes `no_public_ballot` (law exists, no recorded ballot) from
`unknown_law`, and never returns a bare empty list that a caller could misread
as "nobody voted".

## Note for whoever owns the repo root

`storage/` must stay gitignored — it holds ~80 MB of
regenerated derived data (8 434 normalized files, a 5.5 MB index, 40 MB of
ZIPs) and is fully rebuildable with one command.
