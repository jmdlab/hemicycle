/**
 * Wire types for the Scrutin API.
 *
 * These mirror the contract implemented by `server/`. Every optional field is
 * optional on purpose: the frontend must degrade gracefully if the backend
 * ships a partial payload rather than crash the whole view.
 */

export type Sort = "adopté" | "rejeté";

export type Interpretation = "numero" | "reference" | "topic";

export interface Candidate {
  numero: number;
  legislature: number;
  titre: string;
  date: string;
  /** null quand l’Assemblée ne publie pas de code de résultat — jamais deviné. */
  sort: Sort | null;
  pour: number;
  contre: number;
  abstentions: number;
  /** 0 → 1 confidence. `>= 0.85` with a single candidate auto-advances. */
  score: number;
  sourceUrl: string;
  /** Plain-French one-liner. Null while the batch is still being computed. */
  resume?: string | null;
  /** What the text concretely changes, and for whom. Descriptive only. */
  detail?: string | null;
  /** For a procedural ballot: what the PARENT text does. Labelled as such. */
  contextDetail?: string | null;
  /** Notable ballot — see the scoring note in server/summarize.mjs. */
  hot?: boolean;
  /** 0 → 100. Mechanical signals + a bounded topic-salience score. */
  heat?: number | null;
  /** Why it scored: "vote serré", "motion de censure", … */
  why?: string[];
}

export interface ResolveResponse {
  query: string;
  interpretation: Interpretation;
  candidates: Candidate[];
  note?: string;
  /**
   * Backend verdict: several bills or readings matched. Authoritative — the UI
   * must always let the user choose when this is true, whatever the score says.
   */
  ambiguous?: boolean;
}

export interface ImageRef {
  url: string;
  width: number;
  height: number;
  bytes?: number;
}

export interface SourceRef {
  url: string;
  label: string;
}

export interface RenderMeta {
  titre?: string;
  date?: string;
  sort?: Sort;
  pour?: number;
  contre?: number;
  abstentions?: number;
  nonVotants?: number;
  [key: string]: unknown;
}

export interface QaCheck {
  id?: string;
  label: string;
  ok: boolean;
  expected?: string | number;
  actual?: string | number;
}

export interface Qa {
  ok: boolean;
  checks: QaCheck[];
}

export interface RenderResult {
  numero: number;
  legislature: number;
  /** 1280×720 — what we display in the browser. */
  preview: ImageRef;
  /** 2048×1152 — what we put on the clipboard (under Twitter's 5 MB cap). */
  pngShare: ImageRef;
  /** 4K master — download / open in a new tab only. */
  png: ImageRef;
  svg: { url: string };
  tweet: string;
  source: SourceRef;
  meta: RenderMeta;
  qa: Qa;
}

/** 422 `qa_failed`: the source figures don't reconcile, nothing was rendered. */
export interface QaFailure {
  qa: Qa;
  meta?: RenderMeta;
  source?: SourceRef;
  candidate?: Candidate;
}

export type Phase =
  | { k: "idle" }
  | { k: "resolving"; query: string }
  | { k: "choosing"; query: string; candidates: Candidate[] }
  | { k: "rendering"; candidate: Candidate }
  | { k: "done"; result: RenderResult }
  | { k: "empty"; query: string }
  | { k: "qaFailed"; fail: QaFailure }
  | { k: "error"; message: string; retryable: boolean };

/* ── One ballot, explained (`GET /api/hemicycle/page/:numero`) ─────────────── */

/** How one parliamentary group split on a ballot. Seat order, as served. */
export interface GroupVote {
  abbrev: string;
  nom: string;
  membres: number;
  pour: number;
  contre: number;
  abstention: number;
  nonVotant: number;
  absent: number;
  /** 0 → 1. Share of the group that actually took part. */
  participation: number;
  /**
   * « a majoritairement voté pour », or **null** when under half the group
   * turned out: the backend refuses to attribute a position to a group whose
   * members were absent. Never synthesise one client-side.
   */
  direction: string | null;
}

/** A term from the ballot, restated in words that need no prior knowledge. */
export interface GlossaryEntry {
  key: string;
  term: string;
  plain: string;
}

export interface Turnout {
  sieges: number;
  votants: number;
  absents: number;
  nonVotants: number;
  phrase: string;
}

export interface Synthese {
  votants: number;
  exprimes: number;
  majorite: number;
  pour: number;
  contre: number;
  abstention: number;
  nonVotants: number;
}

/**
 * The per-ballot page payload. The image fields are absent whenever `qa.ok` is
 * false — a ballot whose figures don't reconcile gets the explanation and the
 * group table, but no card and nothing copyable.
 */
export interface ScrutinPageData {
  /** This ballot's bill page (/loi/<slug>), when the title names a bill. */
  loi?: { slug: string } | null;
  /** What the enacting articles concretely oblige, forbid or create. */
  mecanisme?: string | null;
  /** What necessarily follows from that mechanism. Entailment only. */
  consequence?: string | null;
  /** The AN document the mechanism was read from. */
  texteSource?: { ref: string; url: string } | null;
  numero: number;
  legislature: number;
  date: string;
  /** null quand l’Assemblée ne publie pas de code de résultat — jamais deviné. */
  sort: Sort | null;
  /** The legal title, verbatim. */
  titre: string;
  /** Plain-French one-liner — what the page leads with. */
  resume: string;
  detail: string | null;
  /** « Il fallait 181 voix sur 360 suffrages exprimés… » */
  outcome: string;
  turnout: Turnout | null;
  groupes: GroupVote[];
  glossaire: GlossaryEntry[];
  synthese: Synthese | null;
  effectif: number;
  source: SourceRef;
  qa: Qa;
  preview?: ImageRef;
  pngShare?: ImageRef;
  png?: ImageRef;
  svg?: { url: string };
}

export interface GroupPresence {
  /** Scrutins pour lesquels ce groupe existait — le dénominateur réel. */
  scrutins?: number;
  /** Scrutins de ce groupe sans participation, compté sur ce dénominateur. */
  absents?: number;
  abbrev: string;
  nom: string;
  membres: number;
  /** 0 → 1. Share of the group's seats occupied for a vote, averaged. */
  presence: number;
}

export interface Stats {
  scrutins: number;
  dateRange: [string | null, string | null];
  /** Mean votants / seats across every ballot. */
  participationAvg: number;
  /** Same, restricted to solemn votes on a whole text. */
  participationFinal: number;
  /** Part des votes enregistrés déposés par un délégué et non par le titulaire. */
  partDelegation: number;
  /** Scrutins auxquels un député a pris part, comptés par personne. */
  prisMoyenne: number | null;
  prisMediane: number | null;
  /** Dont ceux que le député a déposés lui-même, sans délégation. */
  prisEnPersonneMoyenne: number | null;
  finalVotes: number;
  adoptes: number;
  rejetes: number;
  groupes: GroupPresence[];
  lastScrutin: { numero: number; date: string } | null;
}

/** One year of the archive, for the list's filter row. */
export type YearFacet = { annee: string; scrutins: number };

/** A page of the ballot list, plus the facets the list needs to page and filter. */
export type LatestPage = {
  scrutins: Candidate[];
  listUrl: string;
  builtAt: string;
  summarizing: boolean;
  stats: Stats | null;
  /** Ballots matching the current filter, all pages together. */
  total: number;
  offset: number;
  years: YearFacet[];
};

/** Ce que touche un député, transcrit de la page de l'Assemblée. */
export type Remuneration = {
  source: { url: string; label: string; maj: string };
  indemnite: { depuis: string; base: number; residence: number; fonction: number; brut: number; net: number };
  autres: Array<{ cle: string; nom: string; montant: number; depuis?: string; quoi: string }>;
  retenues: {
    scrutinOrdinaire: boolean;
    regles: Array<{ article: string; quand: string; combien: string }>;
    reglementUrl: string;
  };
  sieges: number;
  /** Indemnité + frais de mandat + crédit collaborateurs, par député et par mois. */
  coutMensuel: number;
  depuisJanvier: { annee: number; jours: number; joursAnnee: number; total: number };
  /** Part de ce coût correspondant aux scrutins sans vote personnel du député. */
  sansVotePersonnel: { part: number; scrutins: number; scrutinsTotal: number; total: number } | null;
};

/* ── Bill pages (`GET /api/hemicycle/loi/:slug`) ───────────────────────────── */

/** One ballot row on a bill page. */
export interface BillScrutinRow {
  numero: number;
  date: string;
  titre: string;
  sort: Sort | null;
  pour: number;
  contre: number;
  abstentions: number;
  final: boolean;
  reading: string | null;
}

export interface BillPageData {
  slug: string;
  /** Accented display title, re-extracted from an original ballot title. */
  titre: string;
  type: string;
  /** Promulgated law, when the dossier joined one. */
  loi: { codeLoi: string; dateLoi: string | null; urlLegifrance: string | null } | null;
  total: number;
  dateRange: [string | null, string | null];
  final: {
    numero: number; date: string; sort: Sort | null;
    pour: number; contre: number; abstentions: number; reading: string | null;
  } | null;
  /** Solemn votes first, then most recent procedural ballots (capped). */
  scrutins: BillScrutinRow[];
  /** Other recent bills — internal navigation. */
  autres: Array<{ slug: string; titre: string }>;
}

/* ── Deputy pages (`GET /api/hemicycle/depute/:slug`, `/deputes`) ──────────── */

export interface DeputeGroupe {
  abbrev: string;
  nom: string | null;
  couleur: string | null;
}

/** One roster row on the /deputes index. */
export interface DeputeSummary {
  slug: string;
  civ: string | null;
  prenom: string;
  nom: string;
  groupe: DeputeGroupe;
  departement: string | null;
  circo: string | null;
  votes: number;
  participation: number;
}

export interface DeputesList {
  generatedAt: string;
  scrutins: number;
  deputes: DeputeSummary[];
}

/** One hydrated vote row on a deputy page. */
export interface DeputeVoteRow {
  numero: number;
  position: string;
  parDelegation: boolean;
  titre: string | null;
  date: string | null;
  sort: Sort | null;
}

export interface DeputePageData {
  slug: string;
  civ: string | null;
  prenom: string;
  nom: string;
  groupe: DeputeGroupe;
  departement: string | null;
  numDepartement: string | null;
  circo: string | null;
  dateDebutMandat: string | null;
  profession: string | null;
  stats: {
    votes: number;
    pour: number;
    contre: number;
    abstention: number;
    nonVotant: number;
    parDelegation: number;
    scrutinsDepuisMandat: number;
    participation: number;
  };
  derniersVotes: DeputeVoteRow[];
  totalVotes: number;
  collegues: Array<{ slug: string; civ: string | null; prenom: string; nom: string }>;
}
