import { useEffect, useState } from "react";
import type { Remuneration as Data } from "@/lib/types";
import { fetchRemuneration } from "@/lib/api";

const eur = (v: number) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(v);

/** Millions, to two figures — 100 926 555 € is unreadable as a running total. */
const millions = (v: number) =>
  `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(v / 1e6)} millions`;

/**
 * What a deputy is paid, what a deputy costs, and what the seats have cost so
 * far this year.
 *
 * The two middle figures are deliberately both present. "26 338 € par mois" is
 * wrong as INCOME — the deputy earns 5 953 € net — and right as COST, because
 * the mandate allowance and the staff budget are public money that simply is
 * not the deputy's. Publishing only the pay makes the cost look small;
 * publishing only the total makes the deputy look paid four times over. The
 * confusion lives in the gap between the two, so both are stated.
 *
 * Note what this block still does NOT do: it does not multiply a cost by a
 * non-participation rate. Participation counts recorded positions, not
 * attendance — a deputy who did not vote may have been in committee, and about
 * one recorded vote in six is cast by a colleague holding a delegation. A "cost
 * of absenteeism" built on that would look rigorous and measure nothing.
 */
/**
 * Stand-in drawn while the figures load: same markup, invisible, hidden from
 * assistive tech, so the block keeps its height and the search form below does
 * not jump when the data lands (CLS). Values only set the usual text length.
 */
const PLACEHOLDER = {
  indemnite: { net: 8888 },
  source: { url: "", maj: "00/00/0000" },
  sieges: 577,
  coutMensuel: 88888,
  depuisJanvier: { annee: 2000, total: 88_800_000 },
  sansVotePersonnel: { total: 88_800_000 },
} as unknown as Data;

export function Remuneration() {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchRemuneration(ctrl.signal)
      .then((d) => { if (!ctrl.signal.aborted) setData(d); })
      .catch(() => { if (!ctrl.signal.aborted) setFailed(true); });
    return () => ctrl.abort();
  }, []);

  if (!data) return failed ? null : <RemunerationBody data={PLACEHOLDER} placeholder />;
  return <RemunerationBody data={data} />;
}

function RemunerationBody({ data, placeholder = false }: { data: Data; placeholder?: boolean }) {
  const { indemnite, source, sieges, coutMensuel, depuisJanvier, sansVotePersonnel } =
    data;

  const lines: Array<{ label: string; value: string }> = [
    { label: "Un député touche", value: `${eur(indemnite.net)} € net par mois` },
    { label: "Un député coûte", value: `${eur(coutMensuel)} € par mois` },
    {
      label: `Les ${sieges} députés depuis le 1er janvier ${depuisJanvier.annee}`,
      value: `${millions(depuisJanvier.total)} d’euros`,
    },
  ];
  if (sansVotePersonnel) {
    lines.push({
      // "Absence aux votes", not "absentéisme". The difference is not delicacy:
      // absenteeism claims the deputy was away from the Assemblée, which this
      // data cannot show — a deputy who did not vote may have been in committee.
      // Absence from the VOTE is exactly what is visible, and it holds for both
      // halves of the figure: the ballots they took no part in, and the ones a
      // colleague cast for them, since a delegation is only lawful when the
      // deputy is prevented from attending (ordonnance n°58-1066, art. 1er).
      label: "Le coût de l’absence aux votes",
      value: `${millions(sansVotePersonnel.total)} d’euros`,
    });
  }

  return (
    <section
      className={`mt-10 border-b border-[color:var(--rule)] pb-5${placeholder ? " invisible" : ""}`}
      aria-label={placeholder ? undefined : "Rémunération"}
      aria-hidden={placeholder || undefined}
      inert={placeholder || undefined}
    >
      <dl className="flex flex-col gap-3">
        {lines.map((l) => (
          <div key={l.label}>
            <dt className="ui text-[0.8125rem] leading-[1.4] tracking-[0.01em] text-[color:var(--ink-3)]">
              {l.label}
            </dt>
            <dd className="font-heading num text-xl leading-[1.3] tracking-[-0.01em] text-[color:var(--ink)]">
              {l.value}
            </dd>
          </div>
        ))}
      </dl>

      {/* One line. The caveats that used to live here — what counts as income,
          what a non-vote does and does not prove, what the Règlement docks —
          are all true and all documented in remuneration.mjs, but a reader
          scanning four figures does not stop for a paragraph, and a paragraph
          nobody reads protects nothing. The labels above are written so they
          are correct on their own. */}
      <p className="mt-5 text-[0.9375rem] leading-[1.55] text-[color:var(--ink-3)]">
        Indemnité, frais de mandat et collaborateurs.{" "}
        <a
          className="link-quiet underline underline-offset-2"
          href={source.url}
          target="_blank"
          rel="noreferrer"
        >
          Assemblée nationale
        </a>
        {source.maj ? <span> · chiffres {source.maj}</span> : null}
      </p>
    </section>
  );
}
