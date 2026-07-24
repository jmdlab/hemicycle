/**
 * Discovery entry points for the reader who arrives without a number or a
 * reference. A tap fills the field and runs the search — the cheapest possible
 * start on mobile, and the same row doubles as the rebound from a zero-result
 * screen. Labels are what people say; the query is what the engine matches
 * (synonyms/stemming do the rest).
 */
const TOPICS: ReadonlyArray<{ label: string; query: string }> = [
  { label: "Réseaux sociaux & mineurs", query: "réseaux sociaux mineurs" },
  { label: "Fin de vie", query: "aide à mourir" },
  { label: "Immigration", query: "immigration" },
  { label: "Narcotrafic", query: "narcotrafic" },
  { label: "Budget", query: "budget" },
  { label: "Retraites", query: "retraites" },
  { label: "Écologie", query: "climat" },
  { label: "Agriculture", query: "agriculture" },
];

export function TopicChips({ onPick }: { onPick: (query: string) => void }) {
  return (
    <nav className="mt-6" aria-label="Sujets">
      <h2 className="ui text-[0.8125rem] leading-[1.4] tracking-[0.01em] text-[color:var(--ink-3)]">
        Par sujet
      </h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {TOPICS.map((t) => (
          <button
            key={t.query}
            type="button"
            className="chip"
            onClick={() => onPick(t.query)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
