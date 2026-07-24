import { useEffect, useRef, useState, type RefObject } from "react";
import { fetchSuggest, type Suggestion } from "@/lib/api";
import { formatDate } from "./Meta";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Jump straight to a ballot when a suggestion is chosen. */
  onSelect: (numero: number) => void;
  /** Full reset (clears the field AND any results/filter shown). */
  onClear: () => void;
  busy: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
};

/**
 * The page's one filled button, now a WAI-ARIA combobox: type a number, a
 * reference or a subject and the six best ballots appear under the field. The
 * fetch is debounced and aborted on each keystroke; it only fires while the
 * field is focused, so filling the value from a topic chip or a deep link never
 * pops the menu. Enter on a highlighted row opens it; Enter with nothing
 * highlighted runs the full search (the disambiguation path stays intact).
 */
export function SearchForm({ value, onChange, onSubmit, onSelect, onClear, busy, inputRef }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const focused = useRef(false);

  useEffect(() => {
    const q = value.trim();
    if (!focused.current || q.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      const s = await fetchSuggest(q, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setSuggestions(s);
      setActive(-1);
      setOpen(s.length > 0);
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [value]);

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const choose = (s: Suggestion) => {
    close();
    onSelect(s.numero);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      close();
      return;
    }
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a <= 0 ? suggestions.length - 1 : a - 1));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      choose(suggestions[active]!);
    }
  };

  return (
    <form
      role="search"
      className="mt-10"
      onSubmit={(e) => {
        e.preventDefault();
        close();
        onSubmit();
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative w-full">
          <input
            ref={inputRef}
            type="search"
            enterKeyHint="search"
            role="combobox"
            aria-expanded={open}
            aria-controls="suggest-list"
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? `suggest-${active}` : undefined}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => {
              focused.current = true;
              if (suggestions.length) setOpen(true);
            }}
            onBlur={() => {
              focused.current = false;
              setTimeout(close, 120);
            }}
            onKeyDown={onKeyDown}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Numéro de scrutin, référence de loi ou sujet"
            placeholder={"8431, PJL 1234, ou « réseaux sociaux mineurs »"}
            className="field w-full pr-11 [&::-webkit-search-cancel-button]:appearance-none"
          />
          {value.length > 0 && (
            <button
              type="button"
              aria-label="Effacer la recherche"
              onClick={() => {
                onClear();
                close();
                inputRef?.current?.focus();
              }}
              className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-[1.05rem] leading-none text-[color:var(--ink-3)] hover:text-[color:var(--ink)]"
            >
              ✕
            </button>
          )}
          {open && suggestions.length > 0 && (
            <ul
              id="suggest-list"
              role="listbox"
              className="absolute left-0 right-0 top-[calc(100%+0.4rem)] z-20 overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--rule)] bg-[color:var(--bg)] shadow-[0_12px_32px_rgba(28,26,22,0.16)]"
            >
              {suggestions.map((s, i) => (
                <li
                  key={s.numero}
                  id={`suggest-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(s);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={
                    "cursor-pointer border-b border-[color:var(--rule)] px-4 py-3 last:border-b-0 " +
                    (i === active ? "bg-[color:var(--surface)]" : "")
                  }
                >
                  <div className="text-[0.9375rem] leading-[1.4] text-[color:var(--ink)]">
                    {s.resume}
                  </div>
                  <div className="ui mt-0.5 text-[0.75rem] text-[color:var(--ink-3)]">
                    n° {s.numero} · {formatDate(s.date)}
                    {s.sort ? ` · ${s.sort[0]!.toUpperCase()}${s.sort.slice(1)}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button type="submit" className="btn-primary shrink-0" disabled={busy || value.trim().length === 0}>
          {busy ? "Recherche…" : "Rechercher"}
        </button>
      </div>
      <p className="ui mt-3 text-[0.8125rem] leading-[1.4] tracking-[0.01em] text-[color:var(--ink-3)]">
        Un numéro de scrutin, une référence de texte, ou simplement le sujet du vote.
      </p>
    </form>
  );
}
