/**
 * Search-result states, in the app's own editorial voice.
 *
 * No shadcn Button, no Luma tokens, no lucide icon — those belong to the shared
 * design system, not to this brand. The house rule is spelt out in SearchForm:
 * on a serif page an icon on a button is the SaaS tell. So these use the same
 * .btn-* classes and plain text as everything else on the page.
 */

export function EmptyNotice({ query }: { query: string }) {
  return (
    <section className="mt-8 rounded-[var(--radius-lg)] border border-[color:var(--control)] p-5">
      <h2 className="ui text-[0.9375rem] font-medium text-[color:var(--ink)]">Aucun scrutin trouvé</h2>
      <p className="mt-2 max-w-[62ch] leading-[1.6] text-[color:var(--ink-2)]">
        Rien ne correspond à « {query} ». Essayez un numéro de scrutin (par exemple 5423), la
        référence du texte, ou reformulez le sujet avec les mots employés dans le texte de loi.
      </p>
    </section>
  );
}

export function ErrorNotice({
  message,
  retryable,
  onRetry,
  onReset,
}: {
  message: string;
  retryable: boolean;
  onRetry: () => void;
  onReset: () => void;
}) {
  return (
    <section className="mt-8 rounded-[var(--radius-lg)] border border-[color:var(--control)] p-5">
      <h2 className="ui text-[0.9375rem] font-medium text-[color:var(--ink)]">
        La recherche n’a pas abouti
      </h2>
      <p className="mt-2 max-w-[62ch] leading-[1.6] text-[color:var(--ink-2)]">{message}</p>
      <div className="mt-5 flex flex-wrap gap-2">
        {retryable ? (
          <button
            type="button"
            className="btn-ghost inline-flex min-h-11 items-center"
            onClick={onRetry}
          >
            Réessayer
          </button>
        ) : null}
        <button type="button" className="btn-row" onClick={onReset}>
          Nouvelle recherche
        </button>
      </div>
    </section>
  );
}
