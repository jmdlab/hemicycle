# Liste des scrutins noyée par un seul texte (ouvert le 07/10/2026)

## But
JM, 07/10/2026 : « j'ai plein d'entrées "Apporter une réponse intégrale au phénomène des violences sexuelles et sexistes
contre les femmes et les enfants", c'est normal ? ». La page d'accueil doit rester lisible quand l'Assemblée vote des
dizaines d'amendements du même texte dans la même séance.

## État vérifié (07/10, 22:35 UTC)
- Les données sont justes : 126 scrutins distincts du dossier `DLR5L17N54776` dans `storage/normalized/` (7 le 01/10,
  68 le 02/10, 26 le 05/10, 25 le 06/10), aucun titre en double. Source : assemblee-nationale.fr, un scrutin par
  amendement ou article.
- Cause de l'effet : `server/plain.mjs` → `plainSummary()` rend le titre du dossier comme ligne principale de chaque
  scrutin ; ce qui distingue le vote (« Amendement n° 235 », « Article 21 ») n'est que dans la petite ligne de
  `plainDetail()`. La liste montre donc 126 fois le même gros titre.

## Piste (à juger sur maquette, `shared/DESIGN.md` d'abord)
Dans la liste, regrouper les scrutins consécutifs d'un même `dossierRef` et d'une même date en une seule carte :
titre du texte, « 25 votes le 6 octobre : 9 adoptés, 16 rejetés », le vote sur l'ensemble mis en avant s'il existe,
et un dépliant ou une page du texte pour le détail. Recherche et pages de scrutin inchangées.

## Pièges
- Pas de conteneur défilant dans une carte. Vérifier sur téléphone (420 px) par capture.
- Les scrutins sans `dossierRef` (motions, déclarations) restent des cartes seules.
