import type { Stats } from "@/lib/types";
import { formatNumber } from "./Meta";

/**
 * Aggregate figures for the current year, at the top of the page.
 *
 * Presented flat and without adjectives — the numbers are the Assemblée's own
 * arithmetic, and characterising them ("faible", "en baisse") is exactly the
 * editorialising this app refuses everywhere else.
 */
export function StatsHeader({ stats }: { stats: Stats | null }) {
  if (!stats || !stats.scrutins) return null;
  const year = stats.lastScrutin
    ? new Date(stats.lastScrutin.date).getFullYear()
    : new Date().getFullYear();

  // Least present first. Seat order was the safer default, but it buries the
  // one thing a reader actually wants from this list; the ranking here is the
  // Assemblée's own attendance arithmetic, not our characterisation of it.
  const groupes = [...(stats.groupes ?? [])].sort((a, b) => a.presence - b.presence);
  // Counted per deputy when the pipeline has it; the per-ballot derivation is
  // only a fallback, and it reads about twenty ballots too kind.
  const missed =
    stats.prisMoyenne != null
      ? stats.scrutins - stats.prisMoyenne
      : Math.round(stats.scrutins * (1 - stats.participationAvg));
  // Presence as a fraction of all ballots — counted per deputy when we have it,
  // else the per-ballot average. Drawn as one black bar so the headline number
  // has an immediate visual, in the same row grammar as the per-group bars.
  const presence =
    stats.prisMoyenne != null
      ? stats.prisMoyenne / stats.scrutins
      : stats.participationAvg;


  return (
    <section
      className="mt-10 border-y border-[color:var(--rule)] py-5"
      aria-label="Chiffres de la législature"
    >
      {/* One number, said the way a school report says it: X out of Y.
          A rate needs decoding ("20 % present" — of what? per vote? per day?);
          a count against a total does not.

          The verb is load-bearing. "A manqué" and "était présent" are both
          claims about where someone WAS, and this data cannot support them:
          nothing records attendance in the hemicycle, a deputy not voting may
          be in committee, and — the part that settles it — a deputy may
          delegate their vote, so one press of a button records two votes.
          "N'a pas pris part au vote" is the Assemblée's own wording and is
          exactly what the figure measures. */}
      <p className="font-heading text-2xl leading-[1.3] tracking-[-0.01em] text-[color:var(--ink)]">
        En {year}, un député n’a pas pris part à{" "}
        <span className="num">{formatNumber(missed)}</span> votes sur{" "}
        <span className="num">{formatNumber(stats.scrutins)}</span>.
        <span className="ui mt-2 block text-[0.9375rem] leading-[1.5] text-[color:var(--ink-3)]">
          {stats.prisMoyenne != null && stats.prisEnPersonneMoyenne != null ? (
            <>
              Sur les <span className="num">{formatNumber(stats.prisMoyenne)}</span> auxquels il a
              pris part, <span className="num">
                {formatNumber(stats.prisMoyenne - stats.prisEnPersonneMoyenne)}
              </span>{" "}
              ont été déposés par un collègue à qui il avait délégué sa voix.
            </>
          ) : (
            <>Soit une participation de{" "}
              <span className="num">{Math.round(stats.participationAvg * 100)} %</span>.</>
          )}
        </span>
      </p>

      {/* Presence as a single black bar, in the same row grammar (label · bar ·
          value) as the per-group list below, so it aligns with it. Filled in
          --ink rather than --ink-3: this is the headline figure, the groups are
          the detail under it. */}
      <div className="mt-5 flex items-center gap-3">
        <span className="ui w-24 shrink-0 text-[0.8125rem] text-[color:var(--ink-2)]">
          Présence
        </span>
        <span className="h-2 min-w-px flex-1 bg-[color:var(--surface)]">
          <span
            className="block h-full bg-[color:var(--ink)]"
            style={{ width: `${Math.round(presence * 100)}%` }}
          />
        </span>
        <span className="ui num w-24 shrink-0 text-right text-[0.8125rem] text-[color:var(--ink-2)]">
          {Math.round(presence * 100)} %
        </span>
        <span className="ui hidden w-20 shrink-0 text-right text-[0.8125rem] text-[color:var(--ink-3)] sm:block">
          en moyenne
        </span>
      </div>

      {/* Attendance per group, least present first. */}
      {groupes.length ? (
        <div className="mt-6 border-t border-[color:var(--rule)] pt-5">
          <h2 className="ui text-[0.8125rem] leading-[1.4] tracking-[0.01em] text-[color:var(--ink-3)]">
            Votes auxquels le groupe n’a pas pris part, sur{" "}
            {formatNumber(stats.scrutins)}
          </h2>
          <ul className="mt-3 flex flex-col gap-1.5">
            {groupes.map((g) => (
              <li key={g.abbrev} className="flex items-center gap-3">
                <span
                  className="ui w-24 shrink-0 truncate text-[0.8125rem] text-[color:var(--ink-2)]"
                  title={g.nom}
                >
                  {g.abbrev}
                </span>
                <span className="h-1.5 min-w-px flex-1 bg-[color:var(--surface)]">
                  <span
                    className="block h-full bg-[color:var(--ink-3)]"
                    style={{ width: `${Math.round((1 - g.presence) * 100)}%` }}
                  />
                </span>
                <span className="ui num w-24 shrink-0 text-right text-[0.8125rem] text-[color:var(--ink-2)]">
                  {g.absents != null ? formatNumber(g.absents) : "—"}
                </span>
                <span className="ui hidden w-20 shrink-0 text-right text-[0.8125rem] text-[color:var(--ink-3)] sm:block">
                  {g.membres} sièges
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
