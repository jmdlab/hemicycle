import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Candidate, YearFacet } from "@/lib/types";
import { fetchLatest } from "@/lib/api";
import { SortStatus, VoteCountsInline, formatDate, formatNumber } from "./Meta";

type Props = {
  onPick: (candidate: Candidate) => void;
  busy: boolean;
};

const PAGE = 20;
const POLL_MS = 15_000;

/**
 * Every ballot the Assemblée has published, newest first.
 *
 * Rows are hairline-separated, not cards: a card per ballot means a border, a
 * radius and a shadow each, for no added meaning, while bare rows lose their
 * scan line.
 *
 * The whole archive is already on disk, so there is nowhere to send the reader:
 * the old "Plus de scrutins" link out to the Assemblée's own list was an
 * admission that this page stopped at twenty. It now pages as the reader
 * reaches the bottom — no button, no page count, nothing to decide.
 */
export function LatestList({ onPick, busy }: Props) {
  const [rows, setRows] = useState<Candidate[] | null>(null);
  const [years, setYears] = useState<YearFacet[]>([]);
  const [year, setYear] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);

  const timer = useRef<number | undefined>(undefined);
  const sentinel = useRef<HTMLDivElement | null>(null);
  // Guards against firing twice for the same page: an intersection fires on
  // every scroll tick, not once, so without this a fast scroll queues five
  // identical requests.
  const inFlight = useRef(false);

  // First page, and again whenever the filter changes. Keyed on `year` so that
  // switching filter REPLACES the list rather than appending to it.
  useEffect(() => {
    const ctrl = new AbortController();
    let stopped = false;
    setRows(null);
    setFailed(false);

    const load = () => {
      fetchLatest(PAGE, ctrl.signal, { year })
        .then((r) => {
          if (stopped || ctrl.signal.aborted) return;
          setRows(r.scrutins);
          setTotal(r.total);
          if (r.years.length) setYears(r.years);
          if (r.summarizing) timer.current = window.setTimeout(load, POLL_MS);
        })
        .catch(() => {
          if (!stopped && !ctrl.signal.aborted) setFailed(true);
        });
    };
    load();

    return () => {
      stopped = true;
      ctrl.abort();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [year]);

  const loadMore = useCallback(() => {
    if (inFlight.current || !rows || rows.length >= total) return;
    inFlight.current = true;
    setLoadingMore(true);
    setFailed(false);
    fetchLatest(PAGE, undefined, { offset: rows.length, year })
      .then((r) => {
        // Append by ballot number, not blindly: the nightly refresh can shift
        // offsets under a reader mid-scroll, and a duplicated row is how that
        // shows up.
        setRows((prev) => {
          const seen = new Set((prev ?? []).map((c) => c.numero));
          return [...(prev ?? []), ...r.scrutins.filter((c) => !seen.has(c.numero))];
        });
        setTotal(r.total);
      })
      .catch(() => setFailed(true))
      .finally(() => {
        inFlight.current = false;
        setLoadingMore(false);
      });
    // Note: a failed page shows a retry line (below) rather than dead-ending.
  }, [rows, total, year]);

  // Ask for the next page as the end of the list comes into view.
  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      // Fetch before the reader actually reaches the bottom, so the next rows
      // are usually already there.
      { rootMargin: "600px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [loadMore]);

  if (failed && !rows) return null;

  const done = rows !== null && rows.length >= total;

  return (
    <section className="mt-16" aria-label="Scrutins">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 className="ui text-[0.8125rem] font-medium leading-[1.2] tracking-[0.02em] text-[color:var(--ink-2)]">
          Scrutins
        </h2>
        {total > 0 ? (
          <p className="ui num text-[0.8125rem] text-[color:var(--ink-3)]">
            {formatNumber(total)} au total
          </p>
        ) : null}
      </div>

      {/* Years, newest first — the same order as the list they filter. */}
      {years.length > 1 ? (
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Filtrer par année">
          <FilterChip active={year === null} onClick={() => setYear(null)}>
            Toutes
          </FilterChip>
          {years.map((y) => (
            <FilterChip key={y.annee} active={year === y.annee} onClick={() => setYear(y.annee)}>
              {y.annee}
            </FilterChip>
          ))}
        </div>
      ) : null}

      {rows === null ? (
        <ul className="mt-4" aria-hidden>
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="row">
              <div className="h-4 w-3/4 animate-pulse bg-[color:var(--surface)]" />
              <div className="mt-2 h-3 w-1/2 animate-pulse bg-[color:var(--surface)]" />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="mt-4">
          {rows.map((s) => (
            <li key={s.numero} className="row">
              {/* The whole row is the control. A separate "Voir" button made the
                  affordance a 60px target next to 60ch of text that looked
                  clickable and was not. */}
              <button type="button" className="row-hit" disabled={busy} onClick={() => onPick(s)}>
                <div className="min-w-0 flex-1">
                  <p className="max-w-[58ch] text-base leading-[1.45] text-[color:var(--ink)]">
                    {s.resume ?? s.titre}
                  </p>
                  {/* What the text actually changes, and for whom — the title
                      alone names a subject without saying what is in it. */}
                  {s.detail ? (
                    <p className="mt-1 max-w-[62ch] text-[0.9375rem] leading-[1.5] text-[color:var(--ink-2)]">
                      {s.detail}
                    </p>
                  ) : s.contextDetail ? (
                    // Procedural ballot: the description belongs to the parent
                    // text, so say so rather than letting it read as this vote's.
                    <p className="mt-1 max-w-[62ch] text-[0.9375rem] leading-[1.5] text-[color:var(--ink-2)]">
                      <span className="ui text-[0.75rem] text-[color:var(--ink-3)]">
                        Texte concerné —{" "}
                      </span>
                      {s.contextDetail}
                    </p>
                  ) : null}
                  <p className="ui mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] leading-[1.4] tracking-[0.01em] text-[color:var(--ink-3)]">
                    <span className="num">n° {s.numero}</span>
                    <span aria-hidden>·</span>
                    <span>{formatDate(s.date)}</span>
                    {/* Separator tied to the pill: SortStatus renders nothing
                        for an unknown result, which would leave "date · · 245". */}
                    {s.sort ? <span aria-hidden>·</span> : null}
                    <SortStatus sort={s.sort} />
                    <span aria-hidden>·</span>
                    <VoteCountsInline pour={s.pour} contre={s.contre} abstentions={s.abstentions} />
                  </p>
                  <p className="ui mt-2 text-[0.8125rem] leading-[1.4] tracking-[0.01em] text-[color:var(--ink-2)]">
                    Plus de détails <span aria-hidden>→</span>
                  </p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* The sentinel sits below the list; seeing it is the request for more. */}
      <div ref={sentinel} aria-hidden className="h-px" />

      {rows !== null ? (
        <p
          className="ui mt-6 text-center text-[0.8125rem] text-[color:var(--ink-3)]"
          aria-live="polite"
        >
          {loadingMore ? (
            "Chargement…"
          ) : failed ? (
            <button type="button" className="btn-row" onClick={loadMore}>
              Chargement interrompu — réessayer
            </button>
          ) : done ? (
            "Fin de la liste."
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={active ? "chip chip-on" : "chip"}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
