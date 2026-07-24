import { useEffect, useRef, type ReactNode } from "react";

/**
 * The ballot detail, presented over the list rather than instead of it.
 *
 * Two idioms for the same navigation, because the platforms disagree on what
 * "going one level deeper" looks like:
 *   · narrow — a push view sliding in from the right, dismissed by a back
 *     control at top-left, which is what a touch user's thumb expects;
 *   · wide — a centred modal over a scrim, dismissed by a close control at
 *     top-right, Escape, or a click outside.
 *
 * The URL still changes and history still works, so this is a real navigation
 * that happens to be drawn as an overlay — a shared link opens the same view,
 * and the browser's own back button dismisses it.
 */
export function DetailOverlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement | null>(null);

  // Escape closes, and the page underneath must not scroll while it is covered:
  // a scrim that lets the list move behind it reads as a rendering bug.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Prevent the covered list from scrolling behind the scrim, without moving
    // it: overflow:hidden on the root holds the scroll offset in place, so the
    // reader is exactly where they left off on close. (position:fixed frees the
    // body and drifts the offset — worse for an 8 000-row list.)
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    panel.current?.focus({ preventScroll: true });
    return () => {
      document.documentElement.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Détail du scrutin">
      {/* Clicking the scrim dismisses. The panel stops the event so a click
          inside — selecting text, hitting a button — never closes the view. */}
      <div className="overlay-scrim" onClick={onClose} aria-hidden />
      <div className="overlay-panel" ref={panel} tabIndex={-1}>
        <div className="overlay-bar">
          <button type="button" className="overlay-back" onClick={onClose}>
            <span aria-hidden>←</span> Tous les scrutins
          </button>
          <button
            type="button"
            className="overlay-close"
            onClick={onClose}
            aria-label="Fermer"
          >
            <span aria-hidden>✕</span>
          </button>
        </div>
        <div className="overlay-body">{children}</div>
      </div>
    </div>
  );
}
