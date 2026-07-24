/**
 * Clipboard helpers.
 *
 * The image path is deliberately written the awkward way: Safari drops the
 * blob if you `await fetch()` *before* constructing the ClipboardItem, because
 * the write must happen in the same user-gesture task. Passing the promise into
 * ClipboardItem is the only shape that works on iOS.
 */

/** Can this browser put a PNG on the clipboard at all? */
export function canCopyImage(): boolean {
  return (
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  );
}

/** Can this browser copy plain text? */
export function canCopyText(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";
}

export async function copyImage(url: string): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("unsupported");
  }
  // Promise-valued ClipboardItem is REQUIRED by Safari (it drops the blob if
  // you await fetch first). `credentials: "same-origin"` is required too — the
  // site sits behind nginx basic auth and the fetch would 401 otherwise.
  const item = new ClipboardItem({
    "image/png": fetch(url, { credentials: "same-origin" }).then((r) => {
      if (!r.ok) throw new Error(`fetch ${r.status}`);
      return r.blob();
    }),
  });
  await navigator.clipboard.write([item]);
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Legacy fallback for browsers without the async clipboard API.
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(el);
  if (!ok) throw new Error("copy failed");
}
