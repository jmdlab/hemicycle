import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Candidate, YearFacet } from "@/lib/types";
import { fetchLatest } from "@/lib/api";
import { groupRuns, mergeHead, type Run } from "@/lib/runs";
import { SortStatus, VoteCountsInline, formatDate, formatNumber } from "./Meta";

type Props = {
  onPick: (candidate: Candidate) => void;
  busy: boolean;
};

const PAGE = 20;
// Pages that only lengthen a closed run add nothing on screen, so the sentinel
// stays in view and asks again. Those pages are fetched larger, and only so
// many in a row before the reader is asked (a 400-vote budget text would
// otherwise pull the archive down with no scrolling at all).
const RUN_PAGE = 50;
const MAX_SILENT_PAGES = 10;
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
 *
 * Consecutive votes on one text (JM, 31/10: « garde la dernière ») show only
 * the newest as a card; the earlier ones sit in a closed disclosure under it,
 * opened in place — no inner scroller.
 */
export function LatestList({ onPick, busy }: Props) {
  const [rows, setRows] = useState<Candidate[] | null>(null);
  const [years, setYears] = useState<YearFacet[]>([]);
  const [year, setYear] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  // More ballots after the loaded ones (from the server's `remaining`).
  const [more, setMore] = useState(false);
  // Auto-loaded pages in a row that added no visible row; at the cap, wait for the reader.
  const silent = useRef(0);
  const [paused, setPaused] = useState(false);
  // « Chargement… » is read aloud only for a page the reader asked for, not for silent auto-fill.
  const [announce, setAnnounce] = useState(false);
  // Open runs, by ballot number: a run's set of ballots only grows (a newer
  // vote on top, an older page below), so the flag can never move to another
  // run — a run key counted from the top shifts when a vote lands elsewhere.
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const numerosOf = (run: Run<Candidate>) => [run.head.numero, ...run.rest.map((r) => r.numero)];
  const isRunOpen = (run: Run<Candidate>) => numerosOf(run).some((n) => open.has(n));
  const toggle = (run: Run<Candidate>) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (numerosOf(run).some((n) => next.has(n))) for (const n of numerosOf(run)) next.delete(n);
      else next.add(run.head.numero);
      return next;
    });
  // Bumped on every filter change: a page requested for the old filter is dropped on arrival.
  const gen = useRef(0);

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
    let first = true;
    setRows(null);
    setFailed(false);
    setOpen(new Set());
    gen.current++;
    silent.current = 0;
    setPaused(false);

    const load = () => {
      fetchLatest(PAGE, ctrl.signal, { year })
        .then((r) => {
          if (stopped || ctrl.signal.aborted) return;
          // A re-poll lays the fresh first page over what is loaded rather than
          // replacing it: a reader deep in the list keeps their place.
          setRows((prev) => mergeHead(r.scrutins, prev));
          if (first) setMore(r.remaining === null ? r.scrutins.length < r.total : r.remaining > 0);
          first = false;
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

  const loadMore = useCallback((byReader = false) => {
    const last = rows?.[rows.length - 1];
    if (inFlight.current || !rows || !last || !more) return;
    if (byReader) {
      silent.current = 0;
      setPaused(false);
    }
    inFlight.current = true;
    const mine = gen.current;
    setLoadingMore(true);
    setAnnounce(byReader);
    setFailed(false);
    const shown = groupRuns(rows).length;
    // By ballot number, not offset: the nightly refresh can add or drop a
    // ballot under a reader mid-scroll, and a shifted offset skips a row.
    const before = last.numero;
    fetchLatest(silent.current ? RUN_PAGE : PAGE, undefined, { before, year })
      .then((r) => {
        if (gen.current !== mine) return;
        const seen = new Set(rows.map((c) => c.numero));
        const next = [...rows, ...r.scrutins.filter((c) => !seen.has(c.numero))];
        setRows((prev) => {
          if (!prev) return prev;
          const have = new Set(prev.map((c) => c.numero));
          return [...prev, ...r.scrutins.filter((c) => !have.has(c.numero))];
        });
        setTotal(r.total);
        const hasMore = r.remaining === null ? next.length < r.total : r.remaining > 0;
        setMore(hasMore);
        if (groupRuns(next).length > shown) silent.current = 0;
        else if (++silent.current >= MAX_SILENT_PAGES && hasMore) setPaused(true);
      })
      .catch(() => {
        if (gen.current === mine) setFailed(true);
      })
      .finally(() => {
        inFlight.current = false;
        setLoadingMore(false);
      });
    // Note: a failed page shows a retry line (below) rather than dead-ending.
  }, [rows, more, year]);

  // Ask for the next page as the end of the list comes into view.
  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!paused && entries.some((e) => e.isIntersecting)) loadMore();
      },
      // Fetch before the reader actually reaches the bottom, so the next rows
      // are usually already there.
      { rootMargin: "600px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [loadMore, paused]);

  if (failed && !rows) return null;

  const done = rows !== null && !more;
  const runs = rows ? groupRuns(rows) : [];

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
        <div
          className="mt-3 flex flex-wrap gap-2"
          role="group"
          aria-label="Filtrer par année"
        >
          <FilterChip active={year === null} onClick={() => setYear(null)}>
            Toutes
          </FilterChip>
          {years.map((y) => (
            <FilterChip
              key={y.annee}
              active={year === y.annee}
              onClick={() => setYear(y.annee)}
            >
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
          {runs.map((run, i) => {
            const isOpen = isRunOpen(run);
            const panel = `run-${run.head.numero}`;
            // The last loaded run may continue on the next page: its count is a floor until then.
            const floor = more && i === runs.length - 1;
            return (
              <ScrutinRow key={run.key} s={run.head} follow={false} busy={busy} onPick={onPick}>
                {run.rest.length > 0 ? (
                  <div className="run">
                    <button
                      type="button"
                      className="run-toggle"
                      aria-expanded={isOpen}
                      aria-controls={isOpen ? panel : undefined}
                      onClick={() => toggle(run)}
                    >
                      <span className="run-chevron" aria-hidden />
                      <span>
                        {floor ? "Au moins " : ""}
                        <span className="num">{formatNumber(run.rest.length)}</span>{" "}
                        {run.rest.length > 1 ? "autres votes" : "autre vote"} sur ce texte
                      </span>
                    </button>
                    {isOpen ? (
                      <ul id={panel}>
                        {run.rest.map((r) => (
                          <ScrutinRow key={r.numero} s={r} follow busy={busy} onPick={onPick} />
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </ScrutinRow>
            );
          })}
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
            <span aria-hidden={!announce}>Chargement…</span>
          ) : failed ? (
            <button type="button" className="btn-row" onClick={() => loadMore(true)}>
              Chargement interrompu — réessayer
            </button>
          ) : paused ? (
            <button type="button" className="btn-row" onClick={() => loadMore(true)}>
              Charger les votes suivants
            </button>
          ) : done ? (
            "Fin de la liste."
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

/**
 * One ballot. `follow` = an earlier vote on the text of the card above, shown
 * inside its accordion: indented, smaller, no title, no « Plus de détails »
 * (the whole row stays one click target).
 */
function ScrutinRow({
  s,
  follow,
  busy,
  onPick,
  children,
}: {
  s: Candidate;
  follow: boolean;
  busy: boolean;
  onPick: (candidate: Candidate) => void;
  /** Under the card, inside its item: the disclosure of earlier votes on the text. */
  children?: ReactNode;
}) {
  return (
    <li className={follow ? "row row-follow" : "row"}>
      <button type="button" className="row-hit" disabled={busy} onClick={() => onPick(s)}>
        <div className={follow ? "min-w-0 flex-1 pl-6" : "min-w-0 flex-1"}>
          {follow ? null : (
            <p className="max-w-[58ch] text-base leading-[1.45] text-[color:var(--ink)]">
              {s.resume ?? s.titre}
            </p>
          )}
          {/* What the text actually changes, and for whom — the title alone
            names a subject without saying what is in it. */}
          {s.detail ? (
            <p
              className={
                follow
                  ? "max-w-[62ch] text-[0.8125rem] leading-[1.5] text-[color:var(--ink-2)]"
                  : "mt-1 max-w-[62ch] text-[0.9375rem] leading-[1.5] text-[color:var(--ink-2)]"
              }
            >
              {s.detail}
            </p>
          ) : follow ? null : s.contextDetail ? (
            // Procedural ballot: the description belongs to the parent text,
            // so say so rather than letting it read as this vote's.
            <p className="mt-1 max-w-[62ch] text-[0.9375rem] leading-[1.5] text-[color:var(--ink-2)]">
              <span className="ui text-[0.75rem] text-[color:var(--ink-3)]">Texte concerné — </span>
              {s.contextDetail}
            </p>
          ) : null}
          <p
            className={
              (follow ? (s.detail ? "mt-1 " : "") : "mt-2 ") +
              "ui flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] leading-[1.4] tracking-[0.01em] text-[color:var(--ink-3)]"
            }
          >
            <span className="num">n° {s.numero}</span>
            <span aria-hidden>·</span>
            <span>{formatDate(s.date)}</span>
            {/* Separator tied to the pill: SortStatus renders nothing for an
              unknown result, which would leave "date · · 245". */}
            {s.sort ? <span aria-hidden>·</span> : null}
            <SortStatus sort={s.sort} />
            <span aria-hidden>·</span>
            <VoteCountsInline pour={s.pour} contre={s.contre} abstentions={s.abstentions} />
          </p>
          {follow ? null : (
            <p className="mt-2 ui text-[0.8125rem] leading-[1.4] tracking-[0.01em] text-[color:var(--ink-2)]">
              Plus de détails <span aria-hidden>→</span>
            </p>
          )}
        </div>
      </button>
      {children}
    </li>
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
