/**
 * Consecutive ballots on the same text (dossierRef), newest first, as runs:
 * `head` is the most recent vote, `rest` the earlier ones in list order.
 * A ballot without dossierRef is a run of its own. Computed over the whole
 * loaded list, so a run cut by a page boundary merges when the next page lands.
 *
 * The key names the TEXT and which of its runs this is, counted from the top
 * (« PLF#0 »), not the newest ballot: a new vote landing on a run that the
 * reader has opened must not close it.
 */
export type Run<T> = { key: string; head: T; rest: T[] };

export function groupRuns<T extends { numero: number; dossierRef?: string | null }>(rows: T[]): Run<T>[] {
  const out: Run<T>[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && r.dossierRef && last.head.dossierRef === r.dossierRef) {
      last.rest.push(r);
      continue;
    }
    let key = `n${r.numero}`;
    if (r.dossierRef) {
      const nth = seen.get(r.dossierRef) ?? 0;
      seen.set(r.dossierRef, nth + 1);
      key = `${r.dossierRef}#${nth}`;
    }
    out.push({ key, head: r, rest: [] });
  }
  return out;
}

/**
 * A refreshed first page laid over the rows already loaded: the fresh rows
 * replace their stale copies, and everything older than the fresh page is
 * kept, so a reader deep in the list does not lose what they scrolled to.
 * Rows are newest first by ballot number.
 */
export function mergeHead<T extends { numero: number }>(fresh: T[], prev: T[] | null): T[] {
  const tail = fresh[fresh.length - 1];
  if (!prev || !tail) return tail ? fresh : (prev ?? []);
  const oldest = tail.numero;
  return [...fresh, ...prev.filter((c) => c.numero < oldest)];
}
