# Amendements : contexte, accordéon, liens — 31/10/2026

**But.** JM sur hemicycle.app/9336 : « Ça montre rien. Zéro contexte ». Plus : replier la liste par texte, `/scrutin/N` → `/N`.

**État vérifié (commit 7024b411e, en service).**
- `server/amendement.mjs` : scrutin → amendement (date du jour ou lendemain ; ambigu = rien), texte AN `dyn/opendata/<uid>.json`,
  résumé Sonnet + contrôles (chiffres avec unité, neutralité, titre ancré, mots-clés filtrés), cache `storage/amendements-contexte/<uid>.json`
  (`GATES_VERSION` : refus et résumés d'avant un changement de contrôles sont refaits). Suppressions simples sans modèle.
- Page : `ScrutinPage.tsx` `AmendementSection` ; HTML robots : bloc dans `server/index.mjs`. Recherche : `motsPourRecherche`.
- Remplissage : cron `:52` UTC, `scripts/backfill-amendements-contexte.mjs` (verrou partagé `hemicycle-conseq.lock`, 12 min),
  sonde `cron-hemicycle-amendements-fresh` (6 h). Log `logs/backfill-amendements-contexte.log`.
- Liste : `src/lib/runs.ts` + `LatestList.tsx`. Routes : `src/lib/route.ts`. Tests : `npm test` (46).

**Prochaine étape.** Laisser le cron couvrir les 3 188 scrutins sur amendement. Option (root, bouton de pose) : redirection nginx
`^/scrutins?/(\d+)/?$ → /$1` 301. Option : titre de partage (og:title) propre aux amendements.

**Pièges.** Jamais `storage/*` dans git (coordonnées des membres). Le client lit la page champ par champ (`api.ts`) :
tout nouveau champ serveur doit y être ajouté, sinon il disparaît. Déployer : `npm run build` + `sudo -n systemctl restart hemicycle.service`.
