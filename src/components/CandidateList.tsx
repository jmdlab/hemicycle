import type { Candidate } from "@/lib/types";
import { SortStatus, VoteCountsInline, formatDate } from "./Meta";

/**
 * Disambiguation, in the same clickable-row idiom as the main list — not a
 * shadcn Button with Luma tokens. Shows the plain-French `resume`, not the
 * official `titre`: this used to be the one place the jargon the app exists to
 * remove was put back at the top.
 */
export function CandidateList({
  candidates,
  note,
  onPick,
}: {
  candidates: Candidate[];
  note?: string;
  onPick: (candidate: Candidate) => void;
}) {
  const single = candidates.length === 1;
  return (
    <section className="mt-8" aria-label="Scrutins correspondants">
      <h2 className="ui text-[0.8125rem] font-medium leading-[1.2] tracking-[0.02em] text-[color:var(--ink-2)]">
        {single ? "Est-ce bien ce scrutin ?" : "Quel scrutin ?"}
      </h2>
      {note ? <p className="ui mt-1 text-[0.8125rem] text-[color:var(--ink-3)]">{note}</p> : null}
      <ul className="mt-3">
        {candidates.map((c) => (
          <li key={`${c.legislature}-${c.numero}`} className="row">
            <button type="button" className="row-hit" onClick={() => onPick(c)}>
              <div className="min-w-0 flex-1">
                <p className="max-w-[58ch] text-base leading-[1.45] text-[color:var(--ink)]">
                  {c.resume ?? c.titre}
                </p>
                <p className="ui mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] leading-[1.4] tracking-[0.01em] text-[color:var(--ink-3)]">
                  <span className="num">n° {c.numero}</span>
                  {c.date ? <span aria-hidden>·</span> : null}
                  {c.date ? <span>{formatDate(c.date)}</span> : null}
                  {c.sort ? <span aria-hidden>·</span> : null}
                  <SortStatus sort={c.sort} />
                  <span aria-hidden>·</span>
                  <VoteCountsInline pour={c.pour} contre={c.contre} abstentions={c.abstentions} />
                </p>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
