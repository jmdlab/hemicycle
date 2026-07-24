import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ApiError, fetchScrutinPage, isAbort } from "@/lib/api";
import { canCopyImage, copyImage } from "@/lib/clipboard";
import type { ScrutinPageData } from "@/lib/types";
import { CopyButton } from "./CopyButton";
import { ShareButton } from "./ShareButton";
import { SortStatus, VoteCountsInline, formatDate } from "./Meta";

type Props = {
  numero: number;
  /** Open this ballot's bill page (/loi/<slug>) — all votes on the same text. */
  onOpenLoi?: (slug: string) => void;
};

/**
 * One ballot, explained.
 *
 * The order of the page IS the message: what was voted, then the image that
 * says how it went, then what it means in French anyone can read, then who
 * stood where, then the words themselves. Nothing here asks the reader to
 * already know how the Assemblée works.
 */

type State =
  | { k: "loading" }
  | { k: "ready"; page: ScrutinPageData }
  | { k: "error"; message: string };

/**
 * `detail` is sometimes a sentence about the text ("Le texte oblige les
 * plateformes à…") and sometimes a procedural label ("Vote sur l'ensemble du
 * texte · commission mixte paritaire"). The first belongs in the prose, the
 * second in the meta line — printing both in both places reads as a stutter.
 */
function isSentence(detail: string | null): boolean {
  if (!detail) return false;
  if (detail.includes("·")) return false;
  return /[.!?]$/.test(detail.trim()) && detail.trim().length > 40;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="ui text-[0.8125rem] font-medium leading-[1.2] tracking-[0.02em] text-[color:var(--ink-2)]">
      {children}
    </h2>
  );
}


function Skeleton() {
  return (
    <div aria-hidden>
      <div className="mt-6 h-9 w-3/4 animate-pulse bg-[color:var(--surface)]" />
      <div className="mt-2 h-9 w-1/2 animate-pulse bg-[color:var(--surface)]" />
      <div className="mt-4 h-4 w-2/5 animate-pulse bg-[color:var(--surface)]" />
      <div className="mt-8 aspect-video w-full animate-pulse rounded-[var(--radius-lg)] bg-[color:var(--surface)]" />
      <div className="mt-10 flex flex-col gap-3">
        <div className="h-4 w-full animate-pulse bg-[color:var(--surface)]" />
        <div className="h-4 w-11/12 animate-pulse bg-[color:var(--surface)]" />
        <div className="h-4 w-3/5 animate-pulse bg-[color:var(--surface)]" />
      </div>
      <ul className="mt-10">
        {Array.from({ length: 8 }).map((_, i) => (
          <li key={i} className="row">
            <div className="flex items-center gap-4">
              <div className="h-4 w-40 shrink-0 animate-pulse bg-[color:var(--surface)]" />
              <div className="h-2.5 flex-1 animate-pulse bg-[color:var(--surface)]" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The card is an image, and now the only place the per-group split is shown —
 * so its alt text has to carry the substance for anyone who cannot see it:
 * the subject, the outcome, the counts, and how many were absent.
 */
function cardAlt(page: ScrutinPageData): string {
  const y = page.synthese;
  const t = page.turnout;
  const parts = [
    `${page.resume}.`,
    // Same rule as the pill: an absent result is said, not guessed. The
      // ternary reintroduced the exact falsehood sortOf was fixed to stop.
      `Scrutin n° ${page.numero} du ${formatDate(page.date)}${page.sort ? `, ${page.sort}` : ""}.`,
  ];
  if (y) parts.push(`${y.pour} pour, ${y.contre} contre, ${y.abstention} abstentions.`);
  if (t) parts.push(`${t.votants} votants sur ${t.sieges} sièges, ${t.absents} absents.`);
  parts.push("Le graphique détaille le vote de chaque groupe politique.");
  return parts.join(" ");
}

export function ScrutinPage({ numero, onOpenLoi }: Props) {
  const [state, setState] = useState<State>({ k: "loading" });
  const imageCopy = useMemo(() => canCopyImage(), []);

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ k: "loading" });
    fetchScrutinPage(numero, ctrl.signal)
      .then((page) => {
        if (!ctrl.signal.aborted) setState({ k: "ready", page });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || isAbort(err)) return;
        setState({
          k: "error",
          message:
            err instanceof ApiError ? err.message : "Une erreur inattendue est survenue.",
        });
      });
    return () => ctrl.abort();
  }, [numero]);

  // The tab title is part of what gets shared when someone sends the link on.
  useEffect(() => {
    const previous = document.title;
    document.title =
      state.k === "ready" ? `${state.page.resume} — Scrutin` : `Scrutin n° ${numero}`;
    return () => {
      document.title = previous;
    };
  }, [state, numero]);

  return (
    <main className="mx-auto w-full max-w-[48rem] px-6 pb-24 pt-8 sm:px-8 sm:pt-12">
      {state.k === "loading" ? <Skeleton /> : null}

      {state.k === "error" ? (
        <section className="mt-6">
          <h1 className="font-heading text-[1.75rem] leading-[1.15] tracking-[-0.01em] text-[color:var(--ink)]">
            Scrutin n° {numero}
          </h1>
          <p className="mt-3 max-w-[62ch] leading-[1.6] text-[color:var(--ink-2)]">
            {state.message}
          </p>
        </section>
      ) : null}

      {state.k === "ready" ? (
        <Body page={state.page} imageCopy={imageCopy} onOpenLoi={onOpenLoi} />
      ) : null}
    </main>
  );
}

function Body({
  page,
  imageCopy,
  onOpenLoi,
}: {
  page: ScrutinPageData;
  imageCopy: boolean;
  onOpenLoi?: (slug: string) => void;
}) {
  // A sentence-shaped detail belongs in the analysis; a label-shaped one stays meta.
  const proseDetail = isSentence(page.detail) ? page.detail : null;
  const metaDetail = proseDetail ? null : page.detail;
  const fileName = `scrutin-${page.legislature}-${page.numero}.png`;
  const failedChecks = page.qa.checks.filter((c) => !c.ok);
  const t = page.turnout;

  return (
    <>
      {/* 1 — what was voted, in French anyone can read. */}
      <header className="mt-6">
        <h1 className="font-heading max-w-[26ch] text-[1.75rem] leading-[1.15] tracking-[-0.015em] text-[color:var(--ink)] sm:text-[2.125rem]">
          {page.resume}
        </h1>
        <p className="ui mt-4 flex flex-wrap items-center gap-x-2 gap-y-2 text-[0.8125rem] leading-[1.4] text-[color:var(--ink-3)]">
          <span className="num">n° {page.numero}</span>
          <span aria-hidden>·</span>
          <span>{formatDate(page.date)}</span>
          {page.sort ? <span aria-hidden>·</span> : null}
          <SortStatus sort={page.sort} />
          {metaDetail ? (
            <>
              <span aria-hidden>·</span>
              <span>{metaDetail}</span>
            </>
          ) : null}
        </p>
        {/* The bill page aggregates every ballot on this text — one hop from
            an amendment to the whole story of its bill. */}
        {page.loi && onOpenLoi ? (
          <p className="ui mt-2 text-[0.8125rem]">
            <a
              className="link-quiet underline underline-offset-2"
              href={`/loi/${page.loi.slug}`}
              onClick={(e) => {
                e.preventDefault();
                onOpenLoi(page.loi!.slug);
              }}
            >
              Tous les scrutins sur ce texte de loi
            </a>
          </p>
        ) : null}
      </header>

      {/* 2 — the visual, high on the page: it is both the fastest read of the
             result and the thing people actually share. */}
      {page.preview && page.png ? (
        <section className="mt-8">
          <a
            href={page.png.url}
            target="_blank"
            rel="noreferrer"
            className="block aspect-video w-full overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--rule)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--ink)] focus-visible:outline-offset-2"
            title="Ouvrir l’image en pleine résolution"
          >
            <img
              src={page.preview.url}
              width={page.preview.width || 1280}
              height={page.preview.height || 720}
              alt={cardAlt(page)}
              className="h-full w-full object-cover"
            />
          </a>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <ShareButton numero={page.numero} title={page.resume} />
            {imageCopy && page.pngShare ? (
              <CopyButton
                label="Copier l’image"
                // The 2048×1152 variant: the 4K master busts X's 5 MB cap and
                // breaks the iOS clipboard.
                onCopy={() => copyImage(page.pngShare?.url ?? page.png?.url ?? "")}
                // min-height wins over .btn-ghost's height: 44px on touch.
                className="min-h-11"
              />
            ) : null}
            <a
              className="btn-ghost inline-flex min-h-11 items-center"
              href={page.png.url}
              download={fileName}
            >
              Télécharger le PNG
            </a>
          </div>
          {!imageCopy ? (
            <p className="ui mt-2 text-[0.75rem] text-[color:var(--ink-3)]">
              La copie d’image n’est pas disponible sur ce navigateur — utilisez le téléchargement.
            </p>
          ) : null}
          {/* The vote in text, not only in the image: on a slow connection the
              answer "how many for/against" must not wait for a 1280×720 webp,
              and a screen reader or a copy-paste needs words, not pixels. */}
          {page.synthese ? (
            <p className="ui mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-[color:var(--ink-3)]">
              <VoteCountsInline
                pour={page.synthese.pour}
                contre={page.synthese.contre}
                abstentions={page.synthese.abstention}
              />
              {t?.phrase ? (
                <>
                  <span aria-hidden>·</span>
                  <span>{t.phrase}</span>
                </>
              ) : null}
            </p>
          ) : null}
        </section>
      ) : (
        // No card. Say why, plainly, and offer nothing copyable: a visual built
        // on figures that don't reconcile would be a false document.
        <section className="mt-8 rounded-[var(--radius-lg)] border border-[color:var(--control)] p-5">
          <h2 className="ui text-[0.9375rem] font-medium text-[color:var(--ink)]">
            {page.qa.ok ? "Le visuel n’a pas pu être généré" : "Aucun visuel pour ce scrutin"}
          </h2>
          <p className="mt-2 max-w-[62ch] leading-[1.6] text-[color:var(--ink-2)]">
            {page.qa.ok
              ? "La carte partageable n’a pas pu être produite cette fois-ci. Les chiffres ci-dessous restent ceux publiés par l’Assemblée nationale."
              : "Les chiffres publiés par l’Assemblée nationale pour ce scrutin ne se recoupent pas. Une carte construite dessus serait fausse : aucune n’a donc été produite. Le détail ci-dessous reste affiché tel quel, à vérifier à la source."}
          </p>
          {/* The text promised "les chiffres ci-dessous" but showed none. Here
              they are, from the same official payload — the moment we ask for
              trust ("vérifiez à la source") is the wrong moment to show nothing. */}
          {page.synthese ? (
            <p className="ui mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-[color:var(--ink-2)]">
              <VoteCountsInline
                pour={page.synthese.pour}
                contre={page.synthese.contre}
                abstentions={page.synthese.abstention}
              />
              {t?.phrase ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="text-[color:var(--ink-3)]">{t.phrase}</span>
                </>
              ) : null}
            </p>
          ) : null}
          {failedChecks.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-1">
              {failedChecks.map((check, i) => (
                <li
                  key={check.id ?? `${check.label}-${i}`}
                  className="ui text-[0.8125rem] text-[color:var(--ink-2)]"
                >
                  {check.label}
                  {check.expected !== undefined || check.actual !== undefined ? (
                    <span className="num text-[color:var(--ink-3)]">
                      {" "}
                      — attendu {check.expected ?? "—"}, obtenu {check.actual ?? "—"}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      )}

      {/* 3 — the analysis, and it is about the TEXT. The vote arithmetic lives
             on the card; repeating it here as prose crowded out the only thing
             a reader cannot get anywhere else: what the law says and what it
             does. Two paragraphs, nothing else. */}
      {page.mecanisme && page.consequence ? (
        <section className="mt-12 border-t border-[color:var(--rule)] pt-6">
          <SectionTitle>Le texte en clair</SectionTitle>
          <p className="mt-3 max-w-[62ch] leading-[1.6] text-[color:var(--ink)]">
            {page.mecanisme}
          </p>

          <h3 className="ui mt-8 text-[0.8125rem] font-medium leading-[1.2] tracking-[0.02em] text-[color:var(--ink-2)]">
            Les conséquences directes
          </h3>
          <p className="mt-3 max-w-[62ch] leading-[1.6] text-[color:var(--ink)]">
            {page.consequence}
          </p>

          {page.texteSource ? (
            <p className="mt-5 text-[0.9375rem] leading-[1.55] text-[color:var(--ink-3)]">
              <a
                className="link-quiet underline underline-offset-2"
                href={page.texteSource.url}
                target="_blank"
                rel="noreferrer"
              >
                Lire le texte de loi sur assemblee-nationale.fr
              </a>
            </p>
          ) : null}

          {/* Method disclosure, next to the thing it qualifies. A generated
              summary that does not say it is generated invites "the site lied"
              on the first slip; said plainly, a slip is a quality miss, not a
              deception. */}
          {page.mecanisme ? (
            <p className="ui mt-6 max-w-[62ch] text-[0.75rem] leading-[1.5] text-[color:var(--ink-3)]">
              Ces deux paragraphes sont rédigés automatiquement à partir du texte
              de loi, sans intervention partisane, et vérifiés contre les articles.
              En cas de doute, le texte officiel fait foi.
            </p>
          ) : null}
        </section>
      ) : null}

      {/* The page ends on the analysis. Vote arithmetic, glossary and a source
          block used to follow — three screens of material that answer questions
          the reader did not ask, on a page whose promise is "en un coup d'œil".
          The numbers are already in the image, and the link to the law itself
          sits with the analysis it supports. */}
    </>
  );
}
