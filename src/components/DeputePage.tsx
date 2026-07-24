import { useEffect, useState } from "react";
import { ApiError, fetchDeputePage, isAbort } from "@/lib/api";
import type { DeputePageData, DeputeVoteRow } from "@/lib/types";
import { formatDate } from "./Meta";

type Props = {
  slug: string;
  onOpenScrutin: (numero: number) => void;
  onOpenDepute: (slug: string) => void;
  onOpenDeputes: () => void;
};

type State =
  | { k: "loading" }
  | { k: "ready"; dep: DeputePageData }
  | { k: "error"; message: string };

const fmtPct = (x: number) => `${Math.round((x ?? 0) * 100)} %`;

function Skeleton() {
  return (
    <div aria-hidden>
      <div className="mt-6 h-9 w-2/3 animate-pulse bg-[color:var(--surface)]" />
      <div className="mt-4 h-4 w-1/2 animate-pulse bg-[color:var(--surface)]" />
      <div className="mt-8 h-24 w-full animate-pulse rounded-[var(--radius-lg)] bg-[color:var(--surface)]" />
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

/** The colour dot groups wear everywhere else on the site. */
function GroupDot({ couleur }: { couleur: string | null }) {
  if (!couleur) return null;
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 rounded-full align-middle"
      style={{ backgroundColor: couleur }}
    />
  );
}

/**
 * One deputy: identity, recorded positions, latest votes.
 *
 * Positions are the ones the Assemblée recorded — a missing scrutin is never
 * presented as an absence, because committee work is invisible to this data.
 */
export function DeputePage({ slug, onOpenScrutin, onOpenDepute, onOpenDeputes }: Props) {
  const [state, setState] = useState<State>({ k: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ k: "loading" });
    fetchDeputePage(slug, ctrl.signal)
      .then((dep) => {
        if (!ctrl.signal.aborted) setState({ k: "ready", dep });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || isAbort(err)) return;
        setState({
          k: "error",
          message:
            err instanceof ApiError && err.code === "not_found"
              ? "Cette députée ou ce député est introuvable parmi les mandats en cours."
              : err instanceof ApiError
                ? err.message
                : "Une erreur inattendue est survenue.",
        });
      });
    return () => ctrl.abort();
  }, [slug]);

  useEffect(() => {
    const previous = document.title;
    document.title =
      state.k === "ready"
        ? `${state.dep.prenom} ${state.dep.nom} — votes à l’Assemblée — Hémicycle`
        : "Député — Hémicycle";
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
            Député
          </h1>
          <p className="mt-3 max-w-[62ch] leading-[1.6] text-[color:var(--ink-2)]">{state.message}</p>
        </section>
      ) : null}

      {state.k === "ready" ? (
        <Body
          dep={state.dep}
          onOpenScrutin={onOpenScrutin}
          onOpenDepute={onOpenDepute}
          onOpenDeputes={onOpenDeputes}
        />
      ) : null}
    </main>
  );
}

function VoteRow({ v, onOpen }: { v: DeputeVoteRow; onOpen: (n: number) => void }) {
  return (
    <li className="row">
      <a
        href={`/${v.numero}`}
        onClick={(e) => {
          e.preventDefault();
          onOpen(v.numero);
        }}
        className="block py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--ink)]"
      >
        <span className="block leading-[1.45] text-[color:var(--ink)]">
          {v.titre ?? `Scrutin n° ${v.numero}`}
        </span>
        <span className="ui mt-1 flex flex-wrap items-center gap-x-2 text-[0.8125rem] text-[color:var(--ink-3)]">
          {v.date ? <span>{formatDate(v.date)}</span> : null}
          <span aria-hidden>·</span>
          <span className="font-medium text-[color:var(--ink-2)]">
            a voté {v.position}
            {v.parDelegation ? " (par délégation)" : ""}
          </span>
        </span>
      </a>
    </li>
  );
}

function Body({
  dep,
  onOpenScrutin,
  onOpenDepute,
  onOpenDeputes,
}: {
  dep: DeputePageData;
  onOpenScrutin: (n: number) => void;
  onOpenDepute: (slug: string) => void;
  onOpenDeputes: () => void;
}) {
  const st = dep.stats;
  const circo = dep.departement
    ? `${dep.departement}${dep.circo ? ` (${dep.circo}e circonscription)` : ""}`
    : null;

  return (
    <>
      <header className="mt-6">
        <p className="ui text-[0.8125rem] tracking-[0.02em] text-[color:var(--ink-3)]">
          <a
            className="link-quiet underline underline-offset-2"
            href="/deputes"
            onClick={(e) => {
              e.preventDefault();
              onOpenDeputes();
            }}
          >
            Députés
          </a>
        </p>
        <h1 className="font-heading mt-1 text-[1.75rem] leading-[1.15] tracking-[-0.015em] text-[color:var(--ink)] sm:text-[2.125rem]">
          {dep.prenom} {dep.nom}
        </h1>
        <p className="ui mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.875rem] leading-[1.5] text-[color:var(--ink-2)]">
          <GroupDot couleur={dep.groupe.couleur} />
          <span>{dep.groupe.nom ?? dep.groupe.abbrev}</span>
          {circo ? (
            <>
              <span aria-hidden>·</span>
              <span>{circo}</span>
            </>
          ) : null}
        </p>
        {dep.dateDebutMandat ? (
          <p className="ui mt-1 text-[0.8125rem] text-[color:var(--ink-3)]">
            Mandat en cours depuis le {formatDate(dep.dateDebutMandat)}
            {dep.profession ? ` · ${dep.profession}` : ""}
          </p>
        ) : null}
      </header>

      <section className="mt-8 rounded-[var(--radius-lg)] border border-[color:var(--rule)] p-5">
        <h2 className="ui text-[0.8125rem] font-medium leading-[1.2] tracking-[0.02em] text-[color:var(--ink-2)]">
          En chiffres
        </h2>
        <p className="mt-3 leading-[1.6] text-[color:var(--ink)]">
          <span className="num">{st.votes}</span> positions exprimées sur{" "}
          <span className="num">{st.scrutinsDepuisMandat}</span> scrutins publics depuis le début du
          mandat (participation {fmtPct(st.participation)}).
        </p>
        <p className="ui mt-2 flex flex-wrap items-center gap-x-2 text-[0.875rem] text-[color:var(--ink-2)]">
          <span className="num">{st.pour} pour</span>
          <span aria-hidden>·</span>
          <span className="num">{st.contre} contre</span>
          <span aria-hidden>·</span>
          <span className="num">{st.abstention} abstentions</span>
          {st.parDelegation ? (
            <>
              <span aria-hidden>·</span>
              <span className="num">{st.parDelegation} par délégation</span>
            </>
          ) : null}
        </p>
        <p className="ui mt-3 max-w-[62ch] text-[0.75rem] leading-[1.5] text-[color:var(--ink-3)]">
          Un scrutin sans position enregistrée ne signifie pas nécessairement une absence : le travail
          en commission n’apparaît pas dans les scrutins publics.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="ui text-[0.8125rem] font-medium leading-[1.2] tracking-[0.02em] text-[color:var(--ink-2)]">
          Ses derniers votes
        </h2>
        {dep.derniersVotes.length > 0 ? (
          <>
            <ul className="mt-3">
              {dep.derniersVotes.map((v) => (
                <VoteRow key={v.numero} v={v} onOpen={onOpenScrutin} />
              ))}
            </ul>
            {dep.totalVotes > dep.derniersVotes.length ? (
              <p className="ui mt-3 text-[0.8125rem] text-[color:var(--ink-3)]">
                {dep.totalVotes - dep.derniersVotes.length} autres positions enregistrées depuis le
                début de la législature.
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-3 max-w-[62ch] leading-[1.6] text-[color:var(--ink-2)]">
            Aucune position nominative enregistrée pour ce mandat.
          </p>
        )}
      </section>

      {dep.collegues.length > 0 ? (
        <section className="mt-12 border-t border-[color:var(--rule)] pt-6">
          <h2 className="ui text-[0.8125rem] font-medium leading-[1.2] tracking-[0.02em] text-[color:var(--ink-2)]">
            Dans le même groupe
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            {dep.collegues.map((c) => (
              <li key={c.slug}>
                <a
                  className="link-quiet underline underline-offset-2"
                  href={`/depute/${c.slug}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenDepute(c.slug);
                  }}
                >
                  {c.prenom} {c.nom}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
