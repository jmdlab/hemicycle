import type {
  BillPageData,
  Candidate,
  DeputePageData,
  DeputesList,
  GroupPresence,
  GlossaryEntry,
  GroupVote,
  LatestPage,
  Remuneration,
  YearFacet,
  Stats,
  ImageRef,
  Qa,
  QaCheck,
  QaFailure,
  RenderResult,
  ResolveResponse,
  ScrutinPageData,
  Sort,
  Synthese,
  Turnout,
} from "./types";

/** Hard ceiling for a single request. The UI turns this into a retryable error. */
export const REQUEST_TIMEOUT_MS = 120_000;

/** Machine codes the backend is contracted to send in `{ error: ... }`. */
export type ApiErrorCode =
  | "qa_failed"
  | "not_found"
  | "upstream_unavailable"
  | "render_failed"
  | "bad_request"
  | "timeout"
  | "network"
  | "bad_response"
  | "unknown";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly qa?: Qa;
  readonly failure?: QaFailure;

  constructor(init: {
    code: ApiErrorCode;
    message: string;
    status?: number;
    retryable?: boolean;
    qa?: Qa;
    failure?: QaFailure;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status ?? 0;
    this.retryable = init.retryable ?? false;
    if (init.qa) this.qa = init.qa;
    if (init.failure) this.failure = init.failure;
  }
}

/** True when the promise rejected because *the caller* aborted (not a timeout). */
export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

const MESSAGES: Record<string, string> = {
  not_found: "Ce scrutin est introuvable dans les données de l’Assemblée nationale.",
  upstream_unavailable:
    "Les données de l’Assemblée nationale sont momentanément indisponibles.",
  render_failed: "La génération du visuel a échoué.",
  bad_request: "Requête invalide.",
  bad_query: "Ce numéro de scrutin n’est pas valide.",
  timeout: "Le service met trop de temps à répondre.",
  network: "Impossible de joindre le service.",
  bad_response: "Réponse inattendue du service.",
  unknown: "Une erreur est survenue.",
};

const RETRYABLE = new Set<ApiErrorCode>([
  "upstream_unavailable",
  "render_failed",
  "timeout",
  "network",
  "bad_response",
  "unknown",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The Assemblée's own word for the result, or nothing.
 *
 * This used to fall back to "adopté" for anything it did not recognise —
 * including `sort: null`, which the server genuinely emits when the payload has
 * no result code. A ballot of unknown outcome would then be published as
 * adopted, in green, as a fact. On this page that is the worst class of bug
 * there is: not a crash, a confident falsehood. Unknown now renders as nothing.
 */
function sortOf(value: unknown): Sort | null {
  const v = str(value).toLowerCase();
  if (v.startsWith("rejet")) return "rejeté";
  if (v.startsWith("adopt")) return "adopté";
  return null;
}

function normalizeQa(raw: unknown): Qa {
  const r = asRecord(raw);
  const list = Array.isArray(r.checks) ? r.checks : [];
  const checks: QaCheck[] = list.map((entry) => {
    const c = asRecord(entry);
    const check: QaCheck = {
      label: str(c.label) || str(c.id) || "Contrôle",
      ok: c.ok !== false,
    };
    if (typeof c.id === "string") check.id = c.id;
    if (typeof c.expected === "string" || typeof c.expected === "number") {
      check.expected = c.expected;
    }
    if (typeof c.actual === "string" || typeof c.actual === "number") {
      check.actual = c.actual;
    }
    return check;
  });
  return { ok: r.ok === true, checks };
}

function normalizeImage(raw: unknown): ImageRef | null {
  const r = asRecord(raw);
  const url = str(r.url);
  if (!url) return null;
  const img: ImageRef = { url, width: num(r.width), height: num(r.height) };
  if (r.bytes !== undefined) img.bytes = num(r.bytes);
  return img;
}

function normalizeStats(raw: unknown): Stats | null {
  const r = asRecord(raw);
  if (!num(r.scrutins)) return null;
  const range = Array.isArray(r.dateRange) ? r.dateRange : [];
  const last = asRecord(r.lastScrutin);
  return {
    scrutins: num(r.scrutins),
    dateRange: [str(range[0]) || null, str(range[1]) || null],
    participationAvg: num(r.participationAvg),
    participationFinal: num(r.participationFinal),
    partDelegation: num(r.partDelegation),
    prisMoyenne: r.prisMoyenne == null ? null : num(r.prisMoyenne),
    prisMediane: r.prisMediane == null ? null : num(r.prisMediane),
    prisEnPersonneMoyenne: r.prisEnPersonneMoyenne == null ? null : num(r.prisEnPersonneMoyenne),
    finalVotes: num(r.finalVotes),
    adoptes: num(r.adoptes),
    rejetes: num(r.rejetes),
    groupes: (Array.isArray(r.groupes) ? r.groupes : []).reduce<GroupPresence[]>((acc, raw) => {
      const g = asRecord(raw);
      const abbrev = str(g.abbrev);
      if (abbrev) {
        acc.push({
          abbrev,
          nom: str(g.nom) || abbrev,
          membres: num(g.membres),
          presence: num(g.presence),
          // Real denominator and count from the server. Without these the
          // client falls back to rate × period total, which inflates any group
          // that did not exist for the whole period — the very bug the server
          // fix closed, and which never reached the browser until now.
          scrutins: g.scrutins == null ? undefined : num(g.scrutins),
          absents: g.absents == null ? undefined : num(g.absents),
        });
      }
      return acc;
    }, []),
    lastScrutin: num(last.numero) ? { numero: num(last.numero), date: str(last.date) } : null,
  };
}

function normalizeCandidate(raw: unknown): Candidate | null {
  const c = asRecord(raw);
  const numero = num(c.numero, NaN);
  if (!Number.isFinite(numero)) return null;
  return {
    numero,
    legislature: num(c.legislature, 17),
    titre: str(c.titre) || `Scrutin n° ${numero}`,
    date: str(c.date),
    sort: sortOf(c.sort),
    pour: num(c.pour),
    contre: num(c.contre),
    abstentions: num(c.abstentions),
    score: num(c.score),
    sourceUrl: str(c.sourceUrl),
    resume: typeof c.resume === "string" && c.resume.trim() ? c.resume.trim() : null,
    detail: typeof c.detail === "string" && c.detail.trim() ? c.detail.trim() : null,
    contextDetail:
      typeof c.contextDetail === "string" && c.contextDetail.trim() ? c.contextDetail.trim() : null,
    hot: c.hot === true,
    heat: typeof c.heat === "number" ? c.heat : null,
    why: Array.isArray(c.why) ? c.why.filter((w): w is string => typeof w === "string") : [],
  };
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorFromPayload(status: number, payload: unknown): ApiError {
  const body = asRecord(payload);
  const rawCode = str(body.error);
  const code = (rawCode || "unknown") as ApiErrorCode;
  const message = str(body.message) || MESSAGES[code] || MESSAGES.unknown!;

  if (code === "qa_failed") {
    const failure: QaFailure = { qa: normalizeQa(body.qa) };
    const meta = asRecord(body.meta);
    if (Object.keys(meta).length > 0) failure.meta = meta;
    const source = asRecord(body.source);
    if (str(source.url)) {
      failure.source = { url: str(source.url), label: str(source.label) || str(source.url) };
    }
    return new ApiError({
      code: "qa_failed",
      status,
      message,
      retryable: false,
      qa: failure.qa,
      failure,
    });
  }

  return new ApiError({
    code,
    status,
    message,
    retryable: RETRYABLE.has(code),
  });
}

async function post(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, REQUEST_TIMEOUT_MS);
  const relay = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", relay);
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      // nginx basic auth sits in front of the app — cookies must ride along.
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const payload = await readJson(res);
    if (!res.ok) throw errorFromPayload(res.status, payload);
    if (payload === null) {
      throw new ApiError({
        code: "bad_response",
        status: res.status,
        message: MESSAGES.bad_response!,
        retryable: true,
      });
    }
    return payload;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (timedOut) {
      throw new ApiError({
        code: "timeout",
        message: MESSAGES.timeout!,
        retryable: true,
      });
    }
    // Caller-initiated abort: propagate so the caller can ignore it silently.
    if (isAbort(err)) throw err;
    throw new ApiError({
      code: "network",
      message: MESSAGES.network!,
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", relay);
  }
}

/**
 * The most recent ballots, from the Assemblée's open data mirrored locally.
 * Resilient by design: the landing list is a convenience, so any failure is
 * swallowed by the caller and the page still works as a search box.
 */
export async function fetchLatest(
  limit = 20,
  signal?: AbortSignal,
  opts: { offset?: number; year?: string | null } = {},
): Promise<LatestPage> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (opts.offset) q.set("offset", String(opts.offset));
  if (opts.year) q.set("year", opts.year);
  const res = await fetch(`/api/hemicycle/latest?${q}`, {
    signal,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  const payload = asRecord(await readJson(res));
  if (!res.ok) throw errorFromPayload(res.status, payload);
  const list = Array.isArray(payload.scrutins) ? payload.scrutins : [];
  const scrutins: Candidate[] = [];
  for (const raw of list) {
    const c = normalizeCandidate(raw);
    if (c) scrutins.push(c);
  }
  const years: YearFacet[] = [];
  if (Array.isArray(payload.years)) {
    for (const raw of payload.years) {
      const r = asRecord(raw);
      const annee = str(r.annee);
      if (/^\d{4}$/.test(annee)) years.push({ annee, scrutins: num(r.scrutins) });
    }
  }
  return {
    scrutins,
    listUrl: str(payload.listUrl, "https://www.assemblee-nationale.fr/dyn/17/scrutins"),
    builtAt: str(payload.builtAt),
    summarizing: payload.summarizing === true,
    stats: normalizeStats(payload.stats),
    total: num(payload.total, scrutins.length),
    offset: num(payload.offset),
    years,
  };
}

export async function resolveScrutin(
  query: string,
  signal?: AbortSignal,
): Promise<ResolveResponse> {
  const payload = asRecord(await post("/api/hemicycle/resolve", { query }, signal));
  const list = Array.isArray(payload.candidates) ? payload.candidates : [];
  const candidates: Candidate[] = [];
  for (const raw of list) {
    const c = normalizeCandidate(raw);
    if (c) candidates.push(c);
  }
  const interpretation = str(payload.interpretation);
  const out: ResolveResponse = {
    query: str(payload.query, query),
    interpretation:
      interpretation === "numero" || interpretation === "reference" ? interpretation : "topic",
    candidates,
  };
  if (str(payload.note)) out.note = str(payload.note);
  if (payload.ambiguous === true) out.ambiguous = true;
  return out;
}

function normalizeGroup(raw: unknown): GroupVote | null {
  const g = asRecord(raw);
  const abbrev = str(g.abbrev).trim();
  const nom = str(g.nom).trim();
  if (!abbrev && !nom) return null;
  return {
    abbrev: abbrev || nom,
    nom: nom || abbrev,
    membres: num(g.membres),
    pour: num(g.pour),
    contre: num(g.contre),
    abstention: num(g.abstention),
    nonVotant: num(g.nonVotant),
    absent: num(g.absent),
    participation: num(g.participation),
    // Null direction is a deliberate refusal by the backend, not a gap to fill.
    direction: typeof g.direction === "string" && g.direction.trim() ? g.direction.trim() : null,
  };
}

function normalizeGlossary(raw: unknown): GlossaryEntry[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: GlossaryEntry[] = [];
  for (const entry of list) {
    const e = asRecord(entry);
    const term = str(e.term).trim();
    const plain = str(e.plain).trim();
    if (!term || !plain) continue;
    out.push({ key: str(e.key) || term, term, plain });
  }
  return out;
}

function normalizeTurnout(raw: unknown): Turnout | null {
  const t = asRecord(raw);
  if (!num(t.sieges)) return null;
  return {
    sieges: num(t.sieges),
    votants: num(t.votants),
    absents: num(t.absents),
    nonVotants: num(t.nonVotants),
    phrase: str(t.phrase),
  };
}

function normalizeSynthese(raw: unknown): Synthese | null {
  const s = asRecord(raw);
  if (!num(s.votants)) return null;
  return {
    votants: num(s.votants),
    exprimes: num(s.exprimes),
    majorite: num(s.majorite),
    pour: num(s.pour),
    contre: num(s.contre),
    abstention: num(s.abstention),
    nonVotants: num(s.nonVotants),
  };
}

/**
 * One ballot, explained: the plain-French summary, the group-by-group
 * breakdown and the shareable card in a single call.
 *
 * The image fields are missing whenever QA refused the ballot — the caller must
 * render the explanation without a card rather than treat it as an error.
 */
export async function fetchScrutinPage(
  numero: number,
  signal?: AbortSignal,
): Promise<ScrutinPageData> {
  const res = await fetch(`/api/hemicycle/page/${numero}`, {
    signal,
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const payload = asRecord(await readJson(res));
  if (!res.ok) throw errorFromPayload(res.status, payload);

  const groupes: GroupVote[] = [];
  for (const raw of Array.isArray(payload.groupes) ? payload.groupes : []) {
    const g = normalizeGroup(raw);
    if (g) groupes.push(g);
  }

  const source = asRecord(payload.source);
  const texteSrc = asRecord(payload.texteSource);
  const resolved = num(payload.numero, numero);
  const loiRef = asRecord(payload.loi);
  const page: ScrutinPageData = {
    loi: str(loiRef.slug) ? { slug: str(loiRef.slug) } : null,
    // Read from the bill's own articles; both halves or neither, so a
    // consequence is never shown without the premise it rests on.
    mecanisme: str(payload.mecanisme).trim() || null,
    consequence: str(payload.consequence).trim() || null,
    texteSource: str(texteSrc.url)
      ? { ref: str(texteSrc.ref), url: str(texteSrc.url) }
      : null,
    numero: resolved,
    legislature: num(payload.legislature, 17),
    date: str(payload.date),
    sort: sortOf(payload.sort),
    titre: str(payload.titre) || `Scrutin n° ${resolved}`,
    resume: str(payload.resume).trim() || str(payload.titre) || `Scrutin n° ${resolved}`,
    detail: str(payload.detail).trim() || null,
    outcome: str(payload.outcome).trim(),
    turnout: normalizeTurnout(payload.turnout),
    groupes,
    glossaire: normalizeGlossary(payload.glossaire),
    synthese: normalizeSynthese(payload.synthese),
    effectif: num(payload.effectif),
    source: {
      url: str(source.url),
      label: str(source.label) || "Assemblée nationale",
    },
    qa: normalizeQa(payload.qa),
  };

  const preview = normalizeImage(payload.preview);
  const pngShare = normalizeImage(payload.pngShare);
  const png = normalizeImage(payload.png);
  const svgUrl = str(asRecord(payload.svg).url);
  if (preview) page.preview = preview;
  if (pngShare) page.pngShare = pngShare;
  if (png) page.png = png;
  if (svgUrl) page.svg = { url: svgUrl };

  return page;
}

export async function renderScrutin(
  input: { numero: number; legislature: number },
  signal?: AbortSignal,
): Promise<RenderResult> {
  const payload = asRecord(await post("/api/hemicycle/render", input, signal));

  const png = normalizeImage(payload.png);
  const pngShare = normalizeImage(payload.pngShare) ?? png;
  const preview = normalizeImage(payload.preview) ?? pngShare;
  if (!png || !pngShare || !preview) {
    throw new ApiError({
      code: "bad_response",
      message: "Le service n’a pas renvoyé d’image exploitable.",
      retryable: true,
    });
  }

  const source = asRecord(payload.source);
  const svg = asRecord(payload.svg);

  return {
    numero: num(payload.numero, input.numero),
    legislature: num(payload.legislature, input.legislature),
    preview,
    pngShare,
    png,
    svg: { url: str(svg.url) },
    tweet: str(payload.tweet),
    source: {
      url: str(source.url),
      label: str(source.label) || "Assemblée nationale",
    },
    meta: asRecord(payload.meta),
    qa: normalizeQa(payload.qa),
  };
}

/** Constants, so this is a plain GET with no normalisation to get wrong. */
export async function fetchRemuneration(signal?: AbortSignal): Promise<Remuneration> {
  const res = await fetch("/api/hemicycle/remuneration", {
    signal,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error("remuneration indisponible");
  return (await res.json()) as Remuneration;
}

/** Type-ahead suggestion — the trimmed fields a dropdown row needs. */
export type Suggestion = {
  numero: number;
  resume: string;
  date: string;
  sort: string | null;
};

/** Debounced type-ahead. Never throws — an empty list is a fine "no idea yet". */
export async function fetchSuggest(q: string, signal?: AbortSignal): Promise<Suggestion[]> {
  try {
    const res = await fetch(`/api/hemicycle/suggest?q=${encodeURIComponent(q)}`, {
      signal,
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { suggestions?: unknown };
    return Array.isArray(data.suggestions) ? (data.suggestions as Suggestion[]) : [];
  } catch {
    return [];
  }
}

/* ── Bill and deputy pages ─────────────────────────────────────────────────── */

/** Shared GET for the /loi and /depute JSON endpoints — ApiError on failure. */
async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal,
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError({ code: "network", message: MESSAGES.network!, retryable: true });
  }
  const payload = await readJson(res);
  if (!res.ok) throw errorFromPayload(res.status, payload);
  if (payload === null) {
    throw new ApiError({
      code: "bad_response",
      status: res.status,
      message: MESSAGES.bad_response!,
      retryable: true,
    });
  }
  return payload;
}

/** One bill: its solemn vote, every ballot cast on it, and the joined law. */
export async function fetchBillPage(slug: string, signal?: AbortSignal): Promise<BillPageData> {
  return (await getJson(`/api/hemicycle/loi/${encodeURIComponent(slug)}`, signal)) as BillPageData;
}

/** The full roster, slimmed for the index page. */
export async function fetchDeputes(signal?: AbortSignal): Promise<DeputesList> {
  return (await getJson("/api/hemicycle/deputes", signal)) as DeputesList;
}

/** One deputy: identity, aggregates, latest recorded votes, colleagues. */
export async function fetchDeputePage(slug: string, signal?: AbortSignal): Promise<DeputePageData> {
  return (await getJson(`/api/hemicycle/depute/${encodeURIComponent(slug)}`, signal)) as DeputePageData;
}
