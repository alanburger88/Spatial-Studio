import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FORMULA_CONDITION_WORDS, FORMULA_FUNCTIONS, type FormulaError } from '@iss/model';
import { Icon } from '../../ui/icons';
import type { Ctx } from './model';

/**
 * The formula view: one line that can be typed, with auto-complete for functions and field paths, and a mistake
 * pointed at where it is. The text is the user's own until it reads; only a formula that reads and type-checks reaches
 * the builder (the screen decides).
 */

interface Suggestion { id: string; insert: string; label: string; note: string; kind: 'function' | 'field' | 'word' }

/** Where the word being typed starts (letters, digits, dots and underscores), or null inside a quoted text or a number. */
function currentToken(text: string, caret: number): { start: number; token: string } | null {
  let start = caret;
  while (start > 0 && /[A-Za-z0-9_.]/.test(text[start - 1])) start--;
  const token = text.slice(start, caret);
  if (!token || /^[0-9]/.test(token)) return null;
  const quotes = (text.slice(0, start).match(/"/g) ?? []).length;
  return quotes % 2 === 1 ? null : { start, token };
}

function suggestionsFor(token: string, ctx: Ctx): Suggestion[] {
  const t = token.toLowerCase();
  const out: Suggestion[] = [];
  for (const f of FORMULA_FUNCTIONS) if (f.name.toLowerCase().startsWith(t)) out.push({ id: `fn-${f.name}`, insert: f.name === 'ISSUE_DATE' ? 'ISSUE_DATE()' : `${f.name}(`, label: f.signature, note: f.words, kind: 'function' });
  const fields: Suggestion[] = [];
  for (const f of ctx.fields) {
    const rank = f.path.toLowerCase().startsWith(t) ? 0 : f.label.toLowerCase().startsWith(t) ? 1 : f.path.toLowerCase().includes(t) || f.label.toLowerCase().includes(t) ? 2 : -1;
    if (rank >= 0 && !(f.documentDate)) fields.push({ id: `f-${f.path}`, insert: f.path, label: f.path, note: f.label, kind: 'field' });
    if (f.type === 'array') for (const c of f.itemFields ?? []) {
      const p = `${f.path}.${c.key}`;
      if (p.toLowerCase().startsWith(t) || c.label.toLowerCase().startsWith(t)) fields.push({ id: `f-${p}`, insert: p, label: p, note: `${f.label}: ${c.label}`, kind: 'field' });
    }
  }
  fields.sort((a, b) => Number(!a.label.toLowerCase().startsWith(t)) - Number(!b.label.toLowerCase().startsWith(t)));
  out.push(...fields.slice(0, 8));
  if (token.length >= 2) for (const w of FORMULA_CONDITION_WORDS) if (w.toLowerCase().startsWith(t)) out.push({ id: `w-${w}`, insert: w, label: w, note: 'Word of a condition', kind: 'word' });
  return out.slice(0, 10);
}

export function FormulaEditor({ text, onText, errors, ctx, disabled, label = 'Formula' }: { text: string; onText: (t: string) => void; errors: FormulaError[]; ctx: Ctx; disabled: boolean; label?: string }) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(text.length);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const tok = currentToken(text, caret);
  const items = useMemo(() => (open && tok ? suggestionsFor(tok.token, ctx) : []), [open, tok?.token, tok?.start, ctx]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = open && items.length > 0;

  useLayoutEffect(() => {
    if (pendingCaret.current !== null && ref.current) { ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current); setCaret(pendingCaret.current); pendingCaret.current = null; }
  });

  const accept = (s: Suggestion) => {
    if (!tok) return;
    const next = `${text.slice(0, tok.start)}${s.insert}${text.slice(caret)}`;
    pendingCaret.current = tok.start + s.insert.length;
    onText(next);
    setOpen(false);
  };

  const first = errors[0];
  const mark = first ? { start: Math.min(first.start, text.length), end: Math.max(Math.min(first.end, text.length), Math.min(first.start + 1, text.length)) } : null;

  return (
    <div className="cf" data-testid="calc-formula-view">
      <label className="cf-label" htmlFor={`${id}-t`}>{label}</label>
      <div className="cf-box">
        <textarea
          id={`${id}-t`} ref={ref} className="textarea mono cf-text" rows={2} spellCheck={false} autoComplete="off" autoCapitalize="off" disabled={disabled}
          data-testid="calc-formula" value={text} aria-invalid={errors.length > 0 || undefined} aria-describedby={errors.length ? `${id}-err` : undefined}
          role="combobox" aria-expanded={shown} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={shown ? `${id}-o${active}` : undefined}
          onChange={(e) => { onText(e.target.value.replace(/\n/g, ' ')); setCaret(e.target.selectionStart); setOpen(true); setActive(0); }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === ' ' && e.ctrlKey) { e.preventDefault(); setOpen(true); setActive(0); return; }
            if (!shown) { if (e.key === 'Enter') e.preventDefault(); return; }
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % items.length); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); }
            else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(items[active]); }
            else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
          }}
        />
        {shown && (
          <ul className="cf-list" id={`${id}-list`} role="listbox" aria-label="Suggestions" data-testid="calc-formula-suggestions">
            {items.map((s, i) => (
              <li key={s.id} id={`${id}-o${i}`} role="option" aria-selected={i === active} className={i === active ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); accept(s); }}>
                <span className="mono cf-sig">{s.label}</span><span className="muted cf-note">{s.note}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {errors.length > 0 && (
        <div className="cf-errors" id={`${id}-err`} role="alert" data-testid="calc-formula-error">
          {mark && (
            <pre className="cf-where mono" aria-hidden="true">{text.slice(0, mark.start)}<mark>{text.slice(mark.start, mark.end) || ' '}</mark>{text.slice(mark.end)}</pre>
          )}
          <ul>
            {errors.slice(0, 4).map((er, i) => (
              <li key={i}><Icon.warning width={13} height={13} /> <span>{er.message}</span> <span className="muted">(characters {Math.min(er.start, text.length) + 1} to {Math.max(er.end, er.start + 1)})</span></li>
            ))}
          </ul>
        </div>
      )}
      <details className="cf-help">
        <summary>Functions and words you can use</summary>
        <ul>
          {FORMULA_FUNCTIONS.map((f) => <li key={f.name}><span className="mono">{f.signature}</span> <span className="muted">{f.words}</span> <span className="mono faint">{f.example}</span></li>)}
        </ul>
      </details>
    </div>
  );
}
