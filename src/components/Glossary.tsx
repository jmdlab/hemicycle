import type { GlossaryEntry } from "@/lib/types";

type Props = { entries: GlossaryEntry[] };

/**
 * The words the ballot uses, restated in words that need no prior knowledge.
 *
 * A plain definition list, everything visible at once: no accordion, no
 * tooltip, no icon. The whole point of the section is that the reader does not
 * have to click — a term hidden behind a disclosure is a term nobody reads.
 * Term in sans so it reads as a label, definition in serif so it reads as prose.
 */
export function Glossary({ entries }: Props) {
  if (entries.length === 0) return null;
  return (
    <dl className="mt-4 flex flex-col gap-5">
      {entries.map((entry) => (
        <div key={entry.key}>
          <dt className="ui text-[0.9375rem] font-medium leading-[1.4] text-[color:var(--ink)]">
            {entry.term}
          </dt>
          <dd className="mt-1 max-w-[62ch] leading-[1.6] text-[color:var(--ink-2)]">
            {entry.plain}
          </dd>
        </div>
      ))}
    </dl>
  );
}
