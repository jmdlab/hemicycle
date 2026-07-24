import { useState } from "react";

/**
 * Share this ballot — the whole point of the product.
 *
 * On a phone this is one tap into the native share sheet, where the card
 * preview and the link go wherever the reader already talks. On a desktop, or a
 * browser without the Web Share API, it copies the link and says so, because a
 * button that silently does nothing is worse than no button.
 *
 * The URL is what carries the preview: the bot route in the server renders
 * Open Graph tags for it, so a pasted link unfurls into the card and the plain
 * summary on X, WhatsApp and the rest.
 */
export function ShareButton({ numero, title }: { numero: number; title: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${location.origin}/${numero}`;

  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title, text: title, url });
        return;
      } catch (err) {
        // The reader cancelled the sheet — that is not a failure, and falling
        // through to copy would make the button claim an action they refused.
        if (err instanceof Error && err.name === "AbortError") return;
        // A real share failure: fall through to copy rather than leave the tap
        // feeling broken.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — nothing more we can offer */
    }
  };

  return (
    <button type="button" className="btn-ghost inline-flex min-h-11 items-center" onClick={share}>
      <span aria-live="polite">{copied ? "Lien copié" : "Partager"}</span>
    </button>
  );
}
