import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

type Props = {
  /** The actual copy work. Must be called straight from the click handler. */
  onCopy: () => Promise<void>;
  label: string;
  copiedLabel?: string;
  failedLabel?: string;
  /** "ghost" = hairline outline (payoff actions). "row" = underlined text. */
  tone?: "ghost" | "row";
  className?: string;
};

const FLASH_MS = 1500;

/**
 * Confirmation is a label swap, nothing else — no toast, no icon, no colour
 * change. On a page this quiet, a moving element is the loudest thing on it.
 */
export function CopyButton({
  onCopy,
  label,
  copiedLabel = "Copié",
  failedLabel = "Échec de la copie",
  tone = "ghost",
  className,
}: Props) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function flash(next: "copied" | "failed") {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), FLASH_MS);
  }

  return (
    <button
      type="button"
      className={cn(tone === "ghost" ? "btn-ghost" : "btn-row", className)}
      aria-live="polite"
      onClick={() => {
        // No await before the call: Safari needs the clipboard write to start
        // inside the user-gesture task.
        onCopy().then(
          () => flash("copied"),
          () => flash("failed"),
        );
      }}
    >
      {state === "copied" ? copiedLabel : state === "failed" ? failedLabel : label}
    </button>
  );
}
