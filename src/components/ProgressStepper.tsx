import { useEffect, useState } from "react";

/** After this long, reassure rather than leave the user staring at nothing. */
const SLOW_AFTER_MS = 12_000;

/**
 * The wait during a search.
 *
 * Once a two-step "identify → render" affair, but the render phase never
 * happens from here — opening a ballot is a real navigation to its own page, so
 * the second step sat "pending" forever and the reassurance lied about a render
 * in progress. It is now one honest line and a stable-ratio placeholder, no
 * lucide icons (an icon on a serif page is the SaaS tell this brand avoids).
 */
export function ProgressStepper() {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <section className="mt-8" aria-busy="true" aria-live="polite">
      <p className="ui text-[0.8125rem] text-[color:var(--ink-2)]">Recherche en cours…</p>
      {slow ? (
        <p className="ui mt-2 text-[0.75rem] text-[color:var(--ink-3)]">
          C’est un peu plus long que d’habitude.
        </p>
      ) : null}
      {/* The result of a search is a list of ballots, not an image — so the
          skeleton mimics list rows, not a 16:9 card. */}
      <div aria-hidden="true" className="mt-6 flex flex-col gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="animate-pulse motion-reduce:animate-none">
            <div className="h-4 w-3/4 rounded bg-[color:var(--surface)]" />
            <div className="mt-2 h-3 w-1/2 rounded bg-[color:var(--surface)]" />
          </div>
        ))}
      </div>
    </section>
  );
}
