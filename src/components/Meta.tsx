import type { Sort } from "@/lib/types";
import { cn } from "@/lib/cn";

const DATE_FMT = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const NUM_FMT = new Intl.NumberFormat("fr-FR");

/** ISO (or anything Date can parse) → « 12 mars 2025 ». Falls back to the raw string. */
export function formatDate(value: string | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return DATE_FMT.format(d);
}

export function formatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return NUM_FMT.format(value);
}

/**
 * Outcome as a rounded, coloured pill — hairline border and coloured label on a
 * transparent ground, never a tinted box (house rule). The tones are deep and
 * matte on purpose: they read as a signal at a glance without borrowing the
 * Bootstrap green/red that every French parliamentary-data site already ships.
 */
export function SortStatus({ sort, className }: { sort: Sort | null | undefined; className?: string }) {
  if (!sort) return null;
  const adopted = sort === "adopté";
  return (
    <span className={cn("pill", adopted ? "pill-adopte" : "pill-rejete", className)}>
      {adopted ? "Adopté" : "Rejeté"}
    </span>
  );
}

/** Pour / Contre / Abstentions — big numerals in Noto Serif, never mono. */
export function VoteCounts({
  pour,
  contre,
  abstentions,
}: {
  pour: number | undefined;
  contre: number | undefined;
  abstentions: number | undefined;
}) {
  const cells: Array<{ label: string; value: number | undefined }> = [
    { label: "Pour", value: pour },
    { label: "Contre", value: contre },
    { label: "Abstentions", value: abstentions },
  ];
  return (
    <dl className="grid grid-cols-3 gap-3">
      {cells.map((cell) => (
        <div key={cell.label}>
          <dt className="ui text-[0.8125rem] text-[color:var(--ink-3)]">{cell.label}</dt>
          <dd className="font-heading num mt-0.5 text-2xl leading-[1.1] tracking-[-0.01em] text-[color:var(--ink)]">
            {formatNumber(cell.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Compact inline « Pour 245 · Contre 200 · Abstentions 12 » for dense lists. */
export function VoteCountsInline({
  pour,
  contre,
  abstentions,
}: {
  pour: number | undefined;
  contre: number | undefined;
  abstentions: number | undefined;
}) {
  return (
    <span className="ui num text-[color:var(--ink-3)]">
      {formatNumber(pour)} pour · {formatNumber(contre)} contre · {formatNumber(abstentions)} abst.
    </span>
  );
}
