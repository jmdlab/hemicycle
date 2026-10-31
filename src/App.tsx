import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchLatest, isAbort, resolveScrutin } from "@/lib/api";
import type { Candidate, Phase, Stats } from "@/lib/types";
import { TopicChips } from "./components/TopicChips";
import { CandidateList } from "@/components/CandidateList";
import { LatestList } from "@/components/LatestList";
import { Remuneration } from "@/components/Remuneration";
import { StatsHeader } from "@/components/StatsHeader";
import { EmptyNotice, ErrorNotice } from "@/components/Notices";
import { ProgressStepper } from "@/components/ProgressStepper";
import { DetailOverlay } from "@/components/DetailOverlay";
import { ScrutinPage } from "@/components/ScrutinPage";
import { SearchForm } from "@/components/SearchForm";
import { BillPage } from "@/components/BillPage";
import { DeputePage } from "@/components/DeputePage";
import { DeputesIndex } from "@/components/DeputesIndex";
import Intersession from "@/components/Intersession";
import { BASE_PATH, canonicalPath, pathForRoute, routeFromPath, type PathRoute, type Route } from "@/lib/route";

/** A single high-confidence hit skips the picker: number/reference = one action. */
const AUTO_PICK_SCORE = 0.85;

/** Deep-link state lives in the query string only — no router. */
function syncUrl(params: Record<string, string> | null): void {
  const url = new URL(window.location.href);
  url.search = "";
  if (params) {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  }
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export default function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [query, setQuery] = useState("");
  const [note, setNote] = useState<string | undefined>(undefined);
  // The only path-based state. The query string keeps doing what it did.
  const [route, setRoute] = useState<Route | null>(() =>
    routeFromPath(window.location.pathname),
  );

  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastRun = useRef<
    { kind: "resolve"; query: string } | { kind: "render"; candidate: Candidate } | null
  >(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const handleFailure = useCallback(
    (err: unknown, ctrl: AbortController) => {
      // A superseded run (new search / reset) must never overwrite the UI.
      if (ctrl.signal.aborted || isAbort(err)) return;
      if (err instanceof ApiError) {
        setPhase({ k: "error", message: err.message, retryable: err.retryable });
        return;
      }
      setPhase({ k: "error", message: "Une erreur inattendue est survenue.", retryable: true });
    },
    [],
  );

  /** Open a routed page (ballot, bill, deputy…). Real navigation, so back/forward work. */
  const openRoute = useCallback((next: PathRoute) => {
    abortRef.current?.abort();
    // The pushed entry carries a flag: closing can then history.back() over it
    // instead of pushing a second entry — otherwise the browser back button
    // reopens the detail we just closed. No scrollTo: the overlay covers the
    // viewport and scrolls internally, so the list keeps the reader's place.
    window.history.pushState({ detail: true }, "", pathForRoute(next));
    setRoute(next);
  }, []);

  const openScrutin = useCallback(
    (numero: number) => openRoute({ k: "scrutin", numero }),
    [openRoute],
  );
  const openLoi = useCallback((slug: string) => openRoute({ k: "loi", slug }), [openRoute]);
  const openDepute = useCallback((slug: string) => openRoute({ k: "depute", slug }), [openRoute]);
  const openDeputes = useCallback(() => openRoute({ k: "deputes" }), [openRoute]);

  const run = useCallback(
    async (raw: string, opts: { forceList?: boolean } = {}) => {
      const q = raw.trim();
      if (!q) return;
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      lastRun.current = { kind: "resolve", query: q };
      setNote(undefined);
      setPhase({ k: "resolving", query: q });
      syncUrl({ q });
      try {
        const res = await resolveScrutin(q, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setNote(res.note);
        if (res.candidates.length === 0) {
          setPhase({ k: "empty", query: q });
          return;
        }
        // Auto-advance whenever the backend says the result is not ambiguous —
        // it now sets `ambiguous=false` only when the top hit clearly dominates
        // (≥2× the runner-up, or a lone real hit), so opening the top candidate
        // straight away is safe even when several ballots matched. `ambiguous`
        // is the authoritative verdict: a genuine near-tie still asks the user.
        const only = !opts.forceList && !res.ambiguous ? res.candidates[0] : undefined;
        if (only && only.score >= AUTO_PICK_SCORE) {
          openScrutin(only.numero);
          return;
        }
        setPhase({ k: "choosing", query: q, candidates: res.candidates });
      } catch (err) {
        handleFailure(err, ctrl);
      }
    },
    [handleFailure, openScrutin],
  );

  const pick = useCallback(
    (candidate: Candidate) => openScrutin(candidate.numero),
    [openScrutin],
  );

  const retry = useCallback(() => {
    const last = lastRun.current;
    if (last?.kind === "resolve") void run(last.query);
  }, [run]);

  // An alias such as `/scrutin/9336` is shown at its canonical address.
  // Same for `/index.html` → `/`; a not-found address is left as typed.
  useEffect(() => {
    const canonical = canonicalPath(window.location.pathname);
    if (canonical) {
      window.history.replaceState(window.history.state, "", `${canonical}${window.location.search}${window.location.hash}`);
    }
  }, [route]);

  const backToList = useCallback(() => {
    // Came from the list (our pushed entry): step back over it, so the entry
    // is consumed and the browser back button doesn't ping-pong into the detail.
    // Arrived by deep link (no flag): replace the URL, never leave the site.
    if (window.history.state?.detail) {
      window.history.back();
    } else {
      window.history.replaceState(null, "", BASE_PATH);
      setRoute(null);
    }
  }, []);

  // Back / forward between the list and a ballot page.
  useEffect(() => {
    // Own the scroll: the overlay restores the reader's place on close, and the
    // browser's automatic restoration would fight it, landing a few hundred
    // pixels off in an 8 000-row list.
    const prevRestore = history.scrollRestoration;
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    const onPop = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if ("scrollRestoration" in history) history.scrollRestoration = prevRestore;
    };
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    lastRun.current = null;
    setNote(undefined);
    setQuery("");
    setPhase({ k: "idle" });
    syncUrl(null);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Deep link: ?n=<numéro> or ?q=<recherche>, read ONCE on first load. It must
  // never re-fire when an article is closed (route -> null): the ?q= left in the
  // URL by a search would re-run and re-open the same article, trapping the user
  // (and repeated Back would eventually surface the old apps.denis.me entry).
  const didDeepLink = useRef(false);
  useEffect(() => {
    if (didDeepLink.current) return;
    didDeepLink.current = true;
    if (route !== null) return; // a /N deep-link is owned by `route`, not this
    const params = new URLSearchParams(window.location.search);
    const initial = (params.get("n") ?? params.get("q") ?? "").trim();
    if (!initial) return;
    setQuery(initial);
    void run(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nothing found → the query stays in the box, ready to be tweaked.
  useEffect(() => {
    if (phase.k === "empty") inputRef.current?.focus();
  }, [phase.k]);

  // Legislature figures: refreshed whenever the list is, so a newly published
  // ballot moves them without a page reload.
  useEffect(() => {
    const ctrl = new AbortController();
    fetchLatest(1, ctrl.signal)
      .then((r) => { if (!ctrl.signal.aborted) setStats(r.stats); })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  const busy = phase.k === "resolving" || phase.k === "rendering";

  return (
    <div className="min-h-dvh">
      {/* `/<numéro>`, `/loi/<slug>`, `/depute/<slug>`, `/deputes` — drawn over
          the list rather than replacing it, so going one level deeper feels
          like navigation rather than a page swap; the URL and history are real
          either way. */}
      {route !== null ? (
        <DetailOverlay onClose={backToList} label={OVERLAY_LABEL[route.k]}>
          {route.k === "scrutin" ? (
            <ScrutinPage numero={route.numero} onOpenLoi={openLoi} onOpenDepute={openDepute} />
          ) : route.k === "loi" ? (
            <BillPage slug={route.slug} onOpenScrutin={openScrutin} onOpenLoi={openLoi} onOpenDepute={openDepute} />
          ) : route.k === "depute" ? (
            <DeputePage
              slug={route.slug}
              onOpenScrutin={openScrutin}
              onOpenDepute={openDepute}
              onOpenDeputes={openDeputes}
            />
          ) : route.k === "deputes" ? (
            <DeputesIndex onOpenDepute={openDepute} />
          ) : (
            <NotFound onHome={backToList} />
          )}
        </DetailOverlay>
      ) : null}

      <Intersession stats={stats} />

      <main className="mx-auto w-full max-w-[56rem] px-6 pb-24 pt-12 sm:px-8 sm:pt-16">
        <header>
          <h1 className="font-heading text-[1.75rem] leading-[1.15] tracking-[-0.01em] text-[color:var(--ink)]">
            Hémicycle
          </h1>
          <p className="mt-2 max-w-[62ch] text-[color:var(--ink-2)]">
            Comprendre ce que l’Assemblée a voté, en un coup d’œil.
          </p>
        </header>

        <StatsHeader stats={stats} />
        <Remuneration />

        {phase.k !== "done" ? (
          <SearchForm
            value={query}
            onChange={setQuery}
            onSubmit={() => void run(query)}
            onSelect={openScrutin}
            onClear={reset}
            busy={busy}
            inputRef={inputRef}
          />
        ) : null}

        {busy ? (
          <ProgressStepper />
        ) : null}

        {phase.k === "choosing" ? (
          <CandidateList candidates={phase.candidates} note={note} onPick={pick} />
        ) : null}

        {phase.k === "empty" ? <EmptyNotice query={phase.query} /> : null}

        {/* Landing list: most arrivals want "the vote that just happened", not a
            search. Hidden once a result is on screen so it never competes with it. */}
        {phase.k === "idle" || phase.k === "empty" ? (
          <>
            <TopicChips
              onPick={(topic) => {
                setQuery(topic);
                void run(topic, { forceList: true });
              }}
            />
            <LatestList onPick={(c) => openScrutin(c.numero)} busy={busy} />
          </>
        ) : null}


        {phase.k === "error" ? (
          <ErrorNotice
            message={phase.message}
            retryable={phase.retryable}
            onRetry={retry}
            onReset={reset}
          />
        ) : null}

        {/* Method, source and cadence — the trust footer. A public product that
            promises "sans parti pris" has to say where the numbers come from and
            how the text is turned into plain French, or the promise is just a
            claim. Kept to three lines; no cookies to disclose because there are
            none. */}
        <footer className="mt-20 border-t border-[color:var(--rule)] pt-6 text-[0.8125rem] leading-[1.6] text-[color:var(--ink-3)]">
          <p className="max-w-[68ch]">
            Données issues de l’open data de l’Assemblée nationale (licence
            Ouverte 2.0), rafraîchies chaque jour. Les résumés en français simple
            sont rédigés automatiquement à partir du texte de loi et vérifiés
            contre ses articles ; le texte officiel fait foi. Aucun cookie, aucun
            traceur.
          </p>
          <p className="mt-2">
            <a
              className="link-quiet underline underline-offset-2"
              href="https://data.assemblee-nationale.fr"
              target="_blank"
              rel="noreferrer"
            >
              data.assemblee-nationale.fr
            </a>
            <span className="mx-2 text-[color:var(--ink-3)]">·</span>
            <a
              className="link-quiet underline underline-offset-2"
              href="https://github.com/jmdlab/hemicycle"
              target="_blank"
              rel="noreferrer"
            >
              Code source sur GitHub
            </a>
          </p>
        </footer>
      </main>
    </div>
  );
}

/** What the overlay announces itself as, per view. */
const OVERLAY_LABEL: Record<Route["k"], string> = {
  scrutin: "Détail du scrutin",
  loi: "Texte de loi",
  depute: "Fiche du député",
  deputes: "Liste des députés",
  introuvable: "Page introuvable",
};

/** Unknown address: say so, and give the way home (the list). */
function NotFound({ onHome }: { onHome: () => void }) {
  // The tab title is the first thing a screen reader says, and a soft 404 must not be indexed.
  useEffect(() => {
    const previous = document.title;
    document.title = "Page introuvable — Hémicycle";
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex";
    document.head.appendChild(robots);
    return () => {
      document.title = previous;
      robots.remove();
    };
  }, []);
  return (
    <main aria-labelledby="introuvable-titre" className="mx-auto w-full max-w-[48rem] px-6 pb-24 pt-8 sm:px-8 sm:pt-12">
      <h1 id="introuvable-titre" className="font-heading text-[1.5rem] leading-[1.2] text-[color:var(--ink)]">
        Page introuvable
      </h1>
      <p className="mt-3 max-w-[58ch] text-base leading-[1.5] text-[color:var(--ink-2)]">
        Cette adresse ne correspond à aucun scrutin, texte ou député.
      </p>
      <a
        href={BASE_PATH}
        className="btn-row"
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          onHome();
        }}
      >
        Retour à l’accueil
      </a>
    </main>
  );
}
