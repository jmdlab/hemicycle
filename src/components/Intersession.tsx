import type { Stats } from "../lib/types";

// Bandeau d'intersession.
//
// L'article 28 de la Constitution borne la session ordinaire au premier jour
// ouvrable d'octobre → dernier jour ouvrable de juin. Entre la clôture de l'été
// et cette reprise, l'Assemblée ne tient plus de séance publique : plus aucun
// scrutin, donc plus rien de neuf ici pendant des semaines. Sans ce bandeau, un
// visiteur d'août lit « dernier vote il y a 6 semaines » comme un site à
// l'abandon plutôt que comme un Parlement en intersession.
//
// Déclencheur CALENDAIRE, pas un simple délai : pendant la session ordinaire
// l'Assemblée connaît régulièrement des « semaines sans séance » (art. 28), et
// un seuil en jours afficherait « en vacances » à tort en plein mois de mars.
// Le bandeau ne peut donc apparaître que dans la fenêtre juillet → reprise
// d'octobre, ET seulement si plus rien n'a été voté depuis quelques jours — ce
// qui le garde masqué pendant une session extraordinaire de juillet, puis le
// fait apparaître seul une fois celle-ci close.
//
// Il disparaît TOUT SEUL dès qu'un scrutin plus récent est ingéré, y compris si
// une session extraordinaire est convoquée en septembre. Rien à programmer,
// rien à retirer à la main.

const SEUIL_JOURS = 5;

/** Premier jour ouvrable d'octobre de l'année donnée (art. 28). */
function repriseOctobre(annee: number): Date {
  const d = new Date(Date.UTC(annee, 9, 1));
  const jour = d.getUTCDay(); // 0 = dimanche, 6 = samedi
  if (jour === 6) d.setUTCDate(3);
  else if (jour === 0) d.setUTCDate(2);
  return d;
}

const JOUR_MS = 86_400_000;
const fmtLong = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const fmtCourt = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

export default function Intersession({ stats }: { stats: Stats | null }) {
  const dernier = stats?.dateRange?.[1];
  if (!dernier) return null;

  const dDernier = new Date(`${dernier}T12:00:00Z`);
  if (Number.isNaN(dDernier.getTime())) return null;

  const maintenant = new Date();
  const joursDepuis = Math.floor((maintenant.getTime() - dDernier.getTime()) / JOUR_MS);
  if (joursDepuis < SEUIL_JOURS) return null;

  // Fenêtre d'intersession de l'année en cours : la session ordinaire se termine
  // au dernier jour ouvrable de juin, donc de juillet jusqu'à la reprise
  // d'octobre on est hors session. Une fois cette date passée (octobre à
  // décembre) on est de nouveau EN session : pas de bandeau, et surtout pas de
  // bascule vers l'octobre suivant — elle ferait réapparaître le bandeau tout
  // l'automne avec un décompte absurde.
  const reprise = repriseOctobre(maintenant.getUTCFullYear());
  const moisUtc = maintenant.getUTCMonth() + 1; // 1 = janvier
  const horsSessionOrdinaire = moisUtc >= 7 && maintenant.getTime() < reprise.getTime();
  if (!horsSessionOrdinaire) return null;

  const semaines = Math.round((reprise.getTime() - dDernier.getTime()) / (7 * JOUR_MS));
  const joursRestants = Math.max(0, Math.ceil((reprise.getTime() - maintenant.getTime()) / JOUR_MS));

  return (
    <aside
      role="status"
      className="border-b border-[color:var(--rule)] bg-[color:var(--surface)]"
    >
      <div className="mx-auto w-full max-w-[40rem] px-6 py-6 sm:px-8 sm:py-8">
        <p className="font-heading text-[1.375rem] leading-[1.2] tracking-[-0.01em] text-[color:var(--ink)] sm:text-[1.625rem]">
          L’Assemblée nationale ne siège pas — {semaines} semaines sans aucun vote.
        </p>
        <p className="mt-3 max-w-[62ch] text-[0.9375rem] leading-[1.6] text-[color:var(--ink-2)] sm:text-base">
          Dernier scrutin le {fmtLong.format(dDernier)}, à la clôture de la session
          extraordinaire. La session ordinaire reprend le{" "}
          {fmtCourt.format(reprise)} (dans {joursRestants} jours), comme le prévoit
          l’article 28 de la Constitution. Sauf session extraordinaire, aucun scrutin
          d’ici là : les données de ce site sont à jour.
        </p>
      </div>
    </aside>
  );
}
