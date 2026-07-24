import { useEffect, useMemo, useState } from "react";
import { ApiError, fetchDeputes, isAbort } from "@/lib/api";
import type { DeputeSummary, DeputesList } from "@/lib/types";

type Props = {
  onOpenDepute: (slug: string) => void;
};

type State =
  | { k: "loading" }
  | { k: "ready"; list: DeputesList }
  | { k: "error"; message: string };

function Skeleton() {
  return (
    <div aria-hidden>
      <div className="mt-6 h-9 w-2/3 animate-pulse bg-[color:var(--surface)]" />
      <div className="mt-4 h-4 w-1/2 animate-pulse bg-[color:var(--surface)]" />
      <ul className="mt-10">
        {Array.from({ length: 12 }).map((_, i) => (
          <li key={i} className="row">
            <div className="my-3 h-4 w-full animate-pulse bg-[color:var(--surface)]" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The 577 sitting deputies, grouped by political group in seat-count order —
 * the same convention as the stats header, never sorted by behaviour.
 */
export function DeputesIndex({ onOpenDepute }: Props) {
  const [state, setState] = useState<State>({ k: "loading" });
  const [filter, setFilter] = useState("");

  useEffect(() => {
    const ctrl = new AbortController();
    fetchDeputes(ctrl.signal)
      .then((list) => {
        if (!ctrl.signal.aborted) setState({ k: "ready", list });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || isAbort(err)) return;
        setState({
          k: "error",
          message: err instanceof ApiError ? err.message : "Une erreur inattendue est survenue.",
        });
      });
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    const previous = document.title;
    document.title = "Les députés de l’Assemblée nationale — Hémicycle";
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <main className="mx-auto w-full max-w-[48rem] px-6 pb-24 pt-8 sm:px-8 sm:pt-12">
      {state.k === "loading" ? <Skeleton /> : null}

      {state.k === "error" ? (
        <section className="mt-6">
          <h1 className="font-heading text-[1.75rem] leading-[1.15] tracking-[-0.01em] text-[color:var(--ink)]">
            Députés
          </h1>
          <p className="mt-3 max-w-[62ch] leading-[1.6] text-[color:var(--ink-2)]">{state.message}</p>
        </section>
      ) : null}

      {state.k === "ready" ? (
        <Body list={state.list} filter={filter} setFilter={setFilter} onOpenDepute={onOpenDepute} />
      ) : null}
    </main>
  );
}

/** Accent-insensitive contains, so "seb" finds "Sébastien". */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function Body({
  list,
  filter,
  setFilter,
  onOpenDepute,
}: {
  list: DeputesList;
  filter: string;
  setFilter: (v: string) => void;
  onOpenDepute: (slug: string) => void;
}) {
  const groups = useMemo(() => {
    const q = fold(filter.trim());
    const match = (d: DeputeSummary) =>
      !q ||
      fold(`${d.prenom} ${d.nom}`).includes(q) ||
      fold(d.departement ?? "").includes(q) ||
      fold(d.groupe.abbrev).includes(q);
    const byGroup = new Map<string, { nom: string; couleur: string | null; rows: DeputeSummary[] }>();
    for (const d of list.deputes) {
      if (!match(d)) continue;
      const k = d.groupe.abbrev;
      let g = byGroup.get(k);
      if (!g) byGroup.set(k, (g = { nom: d.groupe.nom ?? k, couleur: d.groupe.couleur, rows: [] }));
      g.rows.push(d);
    }
    return [...byGroup.entries()].sort((a, b) => b[1].rows.length - a[1].rows.length);
  }, [list, filter]);

  return (
    <>
      <header className="mt-6">
        <h1 className="font-heading text-[1.75rem] leading-[1.15] tracking-[-0.015em] text-[color:var(--ink)] sm:text-[2.125rem]">
          Les {list.deputes.length} députés
        </h1>
        <p className="mt-3 max-w-[62ch] leading-[1.6] text-[color:var(--ink-2)]">
          Chaque fiche détaille les positions enregistrées de la députée ou du député sur les{" "}
          {list.scrutins} scrutins publics de la législature.
        </p>
      </header>

      <div className="mt-6">
        <label className="sr-only" htmlFor="depute-filter">
          Filtrer par nom, département ou groupe
        </label>
        <input
          id="depute-filter"
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filtrer par nom, département ou groupe…"
          className="field w-full [&::-webkit-search-cancel-button]:appearance-none"
          autoComplete="off"
        />
      </div>

      {groups.length === 0 ? (
        <p className="mt-8 max-w-[62ch] leading-[1.6] text-[color:var(--ink-2)]">
          Aucun député ne correspond à « {filter.trim()} ».
        </p>
      ) : null}

      {groups.map(([abbrev, g]) => (
        <section key={abbrev} className="mt-10">
          <h2 className="ui flex items-center gap-2 text-[0.8125rem] font-medium leading-[1.2] tracking-[0.02em] text-[color:var(--ink-2)]">
            {g.couleur ? (
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: g.couleur }}
              />
            ) : null}
            {g.nom} ({g.rows.length})
          </h2>
          <ul className="mt-2">
            {g.rows.map((d) => (
              <li key={d.slug} className="row">
                <a
                  href={`/depute/${d.slug}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenDepute(d.slug);
                  }}
                  className="flex items-baseline justify-between gap-4 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--ink)]"
                >
                  <span className="leading-[1.45] text-[color:var(--ink)]">
                    {d.prenom} {d.nom}
                  </span>
                  <span className="ui shrink-0 text-[0.8125rem] text-[color:var(--ink-3)]">
                    {d.departement ?? ""}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
