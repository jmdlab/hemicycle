/**
 * Shared helpers for the bot-prerendered HTML pages (/api/hemicycle/og/*).
 *
 * One escaping discipline for every crawler-facing page: these strings end up
 * in title tags, meta content, JSON-LD and visible HTML, and a slip in any of
 * them is either broken markup or XSS on a public site.
 */

export const SITE = process.env.SCRUTIN_SITE || "https://hemicycle.app";

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet",
              "août", "septembre", "octobre", "novembre", "décembre"];

/** "2026-05-18" -> "18 mai 2026"; anything unparseable is returned as-is. */
export function frDate(iso) {
  const t = String(iso ?? "");
  if (t.length >= 10 && t[4] === "-") {
    const y = +t.slice(0, 4), m = +t.slice(5, 7), d = +t.slice(8, 10);
    if (m >= 1 && m <= 12) return `${d} ${MOIS[m - 1]} ${y}`;
  }
  return t;
}

/** Hard cut with an ellipsis. */
export function shorten(v, n) {
  const t = String(v ?? "").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

/**
 * Like shorten, but never cuts mid-word: back up to the last space before the
 * limit so meta text reads cleanly in SERPs and link previews.
 */
export function clipWord(v, n) {
  const t = String(v ?? "").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : cut).replace(/[\s,;:·—–-]+$/u, "") + "…";
}

export function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export const tag = (p, c) => `<meta property="${p}" content="${esc(c)}" />`;
export const metaName = (n, c) => `<meta name="${n}" content="${esc(c)}" />`;

/**
 * Embedding JSON in a <script> is NOT the same as JSON.stringify: `</script>`
 * (or U+2028/U+2029) in any field would break out of the tag → XSS. Escape the
 * tag-significant characters to their \u-forms; the JSON stays valid.
 */
export function ldJson(ld) {
  return JSON.stringify(ld)
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
