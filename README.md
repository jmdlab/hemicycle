# Hémicycle

Un vote de l'Assemblée nationale → une image 16:9 prête à coller dans X/Twitter,
plus un tweet court et neutre. Rien d'autre.

Une seule entrée texte. On y tape indifféremment :

- un **numéro** de scrutin (`5423`)
- une **référence** de texte (`PJL 1234`, `article 45`)
- un **sujet** en clair (`la loi sur les réseaux sociaux pour les moins de 15 ans`)

## Parcours

```
saisie ──► resolving ──┬─ 1 candidat, score ≥ 0.85 ──► rendering ──► done
                       ├─ plusieurs / score bas ─────► choosing ──► rendering ──► done
                       └─ 0 candidat ───────────────► empty
                                                      erreurs ───► qaFailed | error
```

Le chemin « numéro / référence » doit rester **une seule action** : un candidat
unique avec un score ≥ 0.85 saute l'écran de choix et lance le rendu.

### Deep-link

`?n=<numéro>` ou `?q=<recherche>` sont lus au montage et relancent la recherche.
L'URL est mise à jour avec `history.replaceState` (pas de routeur).

## Frontend

| Fichier | Rôle |
|---|---|
| `src/App.tsx` | machine à états (`Phase`), deep-link, `AbortController` |
| `src/components/SearchForm.tsx` | l'unique champ + bouton Générer |
| `src/components/CandidateList.tsx` | désambiguïsation quand le score est bas |
| `src/components/ProgressStepper.tsx` | stepper 2 lignes + squelette 16:9 |
| `src/components/ResultView.tsx` | image, actions, méta, tweet, source |
| `src/components/QaFailedNotice.tsx` | 422 `qa_failed` — rien de copiable |
| `src/components/Notices.tsx` | états vide / erreur |
| `src/components/Meta.tsx` | dates FR, nombres FR, pastille Adopté/Rejeté |
| `src/components/CopyButton.tsx` | bouton copie → ✓ « Copié » pendant 1,8 s |
| `src/lib/types.ts` | types de la machine à états + du contrat API |
| `src/lib/api.ts` | client HTTP, normalisation, codes d'erreur, timeout |
| `src/lib/clipboard.ts` | copie image (Safari) et texte |
| `src/lib/Button.tsx`, `src/lib/cn.ts` | vendorés depuis un autre projet de l'auteur |

### Les trois pièges connus

1. **Clipboard Safari** — le `ClipboardItem` doit recevoir une *promesse* de blob.
   Si on `await fetch()` avant de le construire, iOS perd le blob et ne colle
   rien. Voir `src/lib/clipboard.ts`.
2. **`credentials: "same-origin"`** — conservé par principe (envoi des cookies same-origin sur le fetch de l'image). hemicycle.app est public, sans auth.
3. **Trois tailles d'image, trois usages** — on affiche `preview` (1280×720), on
   copie `pngShare` (2048×1152, sous le plafond de 5 Mo de X et compatible
   presse-papier iOS), on ne télécharge que le master 4K (`png`).

### Le lien source n'est jamais dans le tweet

Convention maison : le tweet part seul, la source de l'Assemblée nationale part
**en réponse**. Le bloc « Source » est donc physiquement hors du bloc tweet dans
le DOM, avec son propre bouton de copie.

### QA en échec = rien

Si le backend renvoie `422 qa_failed`, les chiffres du vote ne se recoupent pas à
la source. On n'affiche **aucune image, aucun tweet, aucun téléchargement** —
une carte générée à partir d'une arithmétique non vérifiée serait un faux. On
explique les contrôles en échec (attendu vs obtenu) et on renvoie à la source.
Pas de gros encadré rouge : bordure neutre + icône d'avertissement.

## Contrat API

Le frontend consomme deux routes (implémentées dans `server/`) :

```
POST /api/hemicycle/resolve  {query}
  → {query, interpretation:"numero"|"reference"|"topic", candidates:Candidate[], note?}
    candidates: [] est une réponse 200 valide → état "empty", surtout pas un 404.

POST /api/hemicycle/render   {numero, legislature}
  → {numero, legislature, preview, pngShare, png, svg, tweet, source, meta, qa}
```

Erreurs — le code machine dans `error` fait foi, `message` n'est qu'un repli :

| HTTP | `error` | UI |
|---|---|---|
| 422 | `qa_failed` | écran QA, avec `qa`, `meta`, `source` |
| 404 | `not_found` | erreur non rejouable |
| 503 | `upstream_unavailable` | erreur rejouable (bouton Réessayer) |
| 500 | `render_failed` | erreur rejouable |

Le client normalise tout ce qu'il reçoit (`src/lib/api.ts`) : payload partiel,
JSON invalide, HTML d'erreur nginx ou backend absent donnent une erreur propre au
lieu d'un écran blanc. Toute requête est coupée à 120 s via `AbortController`.

## Cron

Deux jobs, un lock partagé (fichier de verrou commun, chemin propre au déploiement) pour qu'ils ne
lisent jamais les textes en même temps :

- **06:25 UTC, quotidien** — `scripts/daily.mjs` (open data AN, index des
  textes, députés, sitemap, délégations, lecture des nouveaux textes, SVG).
  Prend le lock en mode attente (`flock -w 7200`).
- **:40 des heures impaires UTC** — `scripts/backfill-consequences.mjs` :
  balaie l'index COMPLET (pas seulement la fenêtre `SCRUTIN_SINCE` du daily)
  et lit les textes dont « Ce que le texte change » manque encore, via le même
  `makeConsequence()` (même prompt, même validation de neutralité, même
  ancrage). Le cache par document est l'état : un ref en cache est sauté, un
  échec est journalisé et retenté au lot suivant. Concurrence 1, pause entre
  items, lot borné (`--limit`, 25 par défaut), exécuté sous
  un limiteur de mémoire et de durée. Cède la place au daily (`flock -n`). Log :
  `logs/backfill-consequences.log`.

Ordre de grandeur réel : les ~8 400 scrutins reposent sur ~74 documents
distincts ; seuls les scrutins portant un `dossierRef` résoluble peuvent avoir
la section. Le backfill est donc un filet (nouveaux textes, fenêtres élargies,
échecs transitoires de fetch), pas un chantier permanent.

## Développement

```bash
npm install
npm run dev      # proxy /api/hemicycle et /storage → service local (port : variable `PORT`)
npm run build    # tsc (strict) && vite build → dist/
```

TypeScript tourne en `strict` avec `noUnusedLocals`, `noUnusedParameters` et
`noUncheckedIndexedAccess`. Le build doit passer sans aucune erreur.

## Design

Tokens uniquement — la feuille de jetons de design importée par `src/index.css`. Zéro couleur,
espacement, ombre ou bordure en dur. Toujours le `<Button>` vendoré, jamais un
`<button>` brut. Pastilles en `font-medium`, casse de phrase, sans fond teinté.
Grands nombres en `font-heading` (Noto Serif), jamais en `font-mono`. Scroll
naturel du body (`min-h-dvh`), cibles tactiles ≥ 44 px, aucun conteneur
scrollable dans une carte.
