import { useEffect, useState } from "react";
import { ApiError, fetchBillPage, isAbort } from "@/lib/api";
import type { BillPageData, BillScrutinRow } from "@/lib/types";
import { SortStatus, formatDate } from "./Meta";

type Props = {
  slug: string;
  /** Open a ballot page — same navigation the list uses. */
  onOpenScrutin: (numero: number) => void;
  /** Open another bill page. */
  onOpenLoi: (slug: string) => void;
};

type State =
  | { k: "loading" }
  | { k: "ready"; bill: BillPageData }
  | { k: "error"; message: string };

function Skeleton() {
  return (
    <div aria-hidden>
      <div className="mt-6 h-9 w-3/4 animate-pulse bg-[color:var(--surface)]" />
      <div className="mt-2 h-9 w-1/2 animate-pulse bg-[color:var(--surface)]" />
      <div className="mt-4 h-4 w-2/5 animate-pulse bg-[color:var(--surface)]" />
      <ul className="mt-10">
        {Array.from({ length: 8 }).map((_, i) => (
          <li key={i} className="row">
            <div className="my-3 h-4 w-full animate-pulse bg-[color:var(--surface)]" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One legislative text, every ballot cast on it.
 *
 * The page leads with the answer (the solemn vote, when there is one), then
 * lists the ballots — solemn first, then the most recent procedural votes.
 */
export function BillPage({ slug, onOpenScrutin, onOpenLoi }: Props) {
  const [state, setState] = useState<State>({ k: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ k: "loading" });
    fetchBillPage(slug, ctrl.signal)
      .then((bill) => {
        if (!ctrl.signal.aborted) setState({ k: "ready", bill });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || isAbort(err)) return;
        setState({
          k: "error",
          message:
            err instanceof ApiError && err.code === "not_found"
              ? "Ce texte est introuvable dans les données de l’Assemblée nationale."
              : err instanceof ApiError
                ? err.message
                : "Une erreur inattendue est survenue.",
        });
      });
    return () => ctrl.abort();
  }, [slug]);

  useEffect(() => {
    const previous = document.title;
    document.title = state.k === "ready" ? `${state.bill.titre} — Hémicycle` : "Texte de loi — Hémicycle";
    return () => {
      document.title = previous;
    };
  }, [state]);

  return (
    <main className="mx-auto w-full max-w-[48rem] px-6 pb-24 pt-8 sm:px-8 sm:pt-12">
      {state.k === "loading" ? <Skeleton /> : null}

      {state.k === "error" ? (
        <section className="mt-6">
          <h1 className="font-heading text-[1.75rem] leading-[1.15] tracking-[-0.01em] text-[color:var(--ink)]">
            Texte de loi
          </h1>
          <p className="mt-3 max-w-[62ch] leading-[1.6] text-[color:var(--ink-2)]">{state.message}</p>
        </section>
      ) : null}

      {state.k === "ready" ? (
        <Body bill={state.bill} onOpenScrutin={onOpenScrutin} onOpenLoi={onOpenLoi} />
      ) : null}
    </main>
  );
}

function ScrutinRow({ s, onOpen }: { s: BillScrutinRow; onOpen: (n: number) => void }) {
  return (
    <li className="row">
      <a
        href={`/${s.numero}`}
        onClick={(e) => {
          e.preventDefault();
          onOpen(s.numero);
        }}
        className="block py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--ink)]"
      >
        <span className="block leading-[1.45] text-[color:var(--ink)]">{s.titre}</span>
        <span className="ui mt-1 flex flex-wrap items-center gap-x-2 text-[0.8125rem] text-[color:var(--ink-3)]">
          <span className="num">n° {s.numero}</span>
          <span aria-hidden>·</span>
          <span>{formatDate(s.date)}</span>
          {s.sort ? (
            <>
              <span aria-hidden>·</span>
              <SortStatus sort={s.sort} />
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span className="num">
            {s.pour} pour, {s.contre} contre
          </span>
          {s.final ? (
            <>
              <span aria-hidden>·</span>
              <span>vote sur l’ensemble</span>
            </>
          ) : null}
        </span>
      </a>
    </li>
  );
}

function Body({
  bill,
  onOpenScrutin,
  onOpenLoi,
}: {
  bill: BillPageData;
  onOpenScrutin: (n: number) => void;
  onOpenLoi: (slug: string) => void;
}) {
  const f = bill.final;
  return (
    <>
      <header className="mt-6">
        <p className="ui text-[0.8125rem] tracking-[0.02em] text-[color:var(--ink-3)]">{bill.type}</p>
        <h1 className="font-heading mt-1 max-w-[30ch] text-[1.75rem] leading-[1.15] tracking-[-0.015em] text-[color:var(--ink)] sm:text-[2.125rem]">
          {bill.titre}
        </h1>
        <p className="ui mt-4 flex flex-wrap items-center gap-x-2 gap-y-2 text-[0.8125rem] leading-[1.4] text-[color:var(--ink-3)]">
          <span className="num">
            {bill.total} scrutin{bill.total > 1 ? "s" : ""}
          </span>
          {bill.dateRange[0] ? (
            <>
              <span aria-hidden>·</span>
              <span>
                {formatDate(bill.dateRange[0])} → {formatDate(bill.dateRange[1] ?? bill.dateRange[0])}
              </span>
            </>
          ) : null}
        </p>
      </header>

      {/* The answer first: how the Assemblée settled the text, when it did. */}
      {f ? (
        <section className="mt-8 rounded-[var(--radius-lg)] border border-[color:var(--rule)] p-5">
          <p className="ui flex flex-wrap items-center gap-x-2 text-[0.9375rem] text-[color:var(--ink)]">
            <SortStatus sort={f.sort} />
            <span>
              le {formatDate(f.date)}
              {f.reading ? ` (${f.reading})` : ""} — {f.pour} pour, {f.contre} contre, {f.abstentions}{" "}
              abstentions
            </span>
          </p>
          <p className="mt-2">
            <a
              className="link-quiet underline underline-offset-2"
              href={`/${f.numero}`}
              onClick={(e) => {
                e.preventDefault();
                onOpenScrutin(f.numero);
              }}
            >
              Voir le scrutin solennel n° {f.numero}
            </a>
          </p>
        </section>
      ) : (
        <p className="mt-8 max-w-[62ch] leading-[1.6] text-[color:var(--ink-2)]">
          Pas encore de vote solennel sur l’ensemble du texte — les scrutins ci-dessous portent sur des
          amendements, des articles ou des motions.
        </p>
      )}

      {bill.loi ? (
        <p className="mt-4 max-w-[62ch] leading-[1.6] text-[color:var(--ink-2)]">
          Texte promulgué : loi n° {bill.loi.codeLoi}
          {bill.loi.dateLoi ? ` du ${formatDate(bill.loi.dateLoi)}` : ""}
          {bill.loi.urlLegifrance ? (
            <>
              {" — "}
              <a
                className="link-quiet underline underline-offset-2"
                href={bill.loi.urlLegifrance}
                target="_blank"
                rel="noreferrer"
              >
                texte sur Légifrance
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      <section className="mt-10">
        <h2 className="ui text-[0.8125rem] font-medium leading-[1.2] tracking-[0.02em] text-[color:var(--ink-2)]">
          Tous les scrutins sur ce texte
        </h2>
        <ul className="mt-3">
          {bill.scrutins.map((s) => (
            <ScrutinRow key={s.numero} s={s} onOpen={onOpenScrutin} />
          ))}
        </ul>
        {bill.total > bill.scrutins.length ? (
          <p className="ui mt-3 text-[0.8125rem] text-[color:var(--ink-3)]">
            {bill.total - bill.scrutins.length} autres scrutins de procédure ne sont pas listés ici.
          </p>
        ) : null}
      </section>

      {bill.autres.length > 0 ? (
        <section className="mt-12 border-t border-[color:var(--rule)] pt-6">
          <h2 className="ui text-[0.8125rem] font-medium leading-[1.2] tracking-[0.02em] text-[color:var(--ink-2)]">
            Autres textes récents
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            {bill.autres.map((b) => (
              <li key={b.slug}>
                <a
                  className="link-quiet underline underline-offset-2"
                  href={`/loi/${b.slug}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenLoi(b.slug);
                  }}
                >
                  {b.titre}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
