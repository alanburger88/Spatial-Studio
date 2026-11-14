import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { isSupportedLanguage, type FieldType, type Project } from '@iss/model';
import { useStudio } from '../../state/store';
import { formatMoney, Tech } from '../../ui/common';
import { localeLabel } from '../../ui/plain';
import { centsToText, enumLabel, ISO_DATE, MONEY_TEXT, plainProblem, textToCents, type Problem, type Rec } from './explorerModel';

/** Everything the tree of fields needs from the editor, shared through context so rows stay small. */
export interface EditorCtx {
  project: Project;
  record: Rec;
  /** The record with its calculated values (available credit, totals …). */
  values: Rec;
  readOnly: boolean;
  problems: Problem[];
  /** Replace the value at a path (`undefined` clears it). */
  set: (segs: Array<string | number>, value: unknown) => void;
  /** A request to open and focus a field: `n` changes on every request. */
  jump: { path: string; n: number } | null;
  /** Values a blocker is about (opened from the Blockers screen): shown highlighted. */
  highlight: string[];
}
export const EditorContext = createContext<EditorCtx | null>(null);
export const useEditor = () => { const c = useContext(EditorContext); if (!c) throw new Error('EditorContext missing'); return c; };

export const problemsAt = (problems: Problem[], path: string) => problems.filter((p) => p.path === path);

export interface InputProps {
  type: FieldType;
  value: unknown;
  onChange: (v: unknown) => void;
  label: string;
  /** Path used to find the control when a problem is jumped to. */
  path: string;
  testId?: string;
  enumValues?: string[];
  required?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  describedBy?: string;
  compact?: boolean;
  isLocale?: boolean;
}

/** Amount in dollars with two decimals, stored as whole cents. */
function MoneyInput({ value, onChange, label, path, testId, disabled, invalid, id, describedBy, compact }: InputProps) {
  const stored = Number.isInteger(value) ? centsToText(value as number) : value === undefined || value === null ? '' : String(value);
  const [text, setText] = useState(stored);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(stored); }, [stored, focused]);
  return (
    <span className={`dx-money${compact ? ' compact' : ''}`}>
      <span aria-hidden="true" className="dx-unit">$</span>
      <input id={id} className="input" inputMode="decimal" autoComplete="off" value={text} disabled={disabled} aria-label={compact ? `${label} in dollars` : undefined}
        aria-invalid={invalid || undefined} aria-describedby={describedBy} data-dx-path={path} data-testid={testId}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); setText(stored); }}
        onChange={(e) => {
          const t = e.target.value;
          if (!MONEY_TEXT.test(t)) return;
          setText(t);
          const c = textToCents(t);
          if (c !== undefined) onChange(c); else if (t.trim() === '' || t === '-') onChange(undefined);
        }} />
    </span>
  );
}

/** One typed control. Text, dollars, whole number, date, yes/no switch or a choice with readable names. */
export function ScalarInput(p: InputProps) {
  const { type, value, onChange, label, path, testId, disabled, invalid, id, describedBy, compact } = p;
  const common = { id, disabled, 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy, 'data-dx-path': path, 'data-testid': testId } as const;
  const aria = compact ? { 'aria-label': label } : {};
  if (type === 'cents') return <MoneyInput {...p} />;
  if (type === 'bool') {
    const on = value === true;
    return (
      <button type="button" role="switch" aria-checked={on} className={`dx-switch${on ? ' on' : ''}`} {...common} aria-label={compact ? label : undefined}
        onClick={() => onChange(!on)}>
        <span className="dx-knob" aria-hidden="true" /><span className="dx-switch-text">{on ? 'Yes' : 'No'}</span>
      </button>
    );
  }
  if (type === 'enum') {
    const values = p.enumValues ?? [];
    const cur = value === undefined || value === null ? '' : String(value);
    const okLocale = !!p.isLocale && isSupportedLanguage(cur);
    const name = (v: string) => (p.isLocale ? localeLabel(v) : enumLabel(v));
    return (
      <select className="select" value={cur} {...common} {...aria} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}>
        {!p.required && <option value="">Not set</option>}
        {p.required && cur === '' && <option value="">Choose…</option>}
        {!values.includes(cur) && cur !== '' && <option value={cur}>{okLocale ? name(cur) : `${cur} (not allowed)`}</option>}
        {values.map((v) => <option key={v} value={v}>{name(v)}</option>)}
      </select>
    );
  }
  if (type === 'int' || type === 'points') {
    const shown = value === undefined || value === null ? '' : String(value);
    return <input className="input" type="number" step={1} value={shown} {...common} {...aria} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />;
  }
  if (type === 'date') {
    const text = typeof value === 'string' ? value : '';
    // A value that is not a date (typed in the JSON view) is shown as text so it can be seen and fixed.
    const bad = value !== undefined && value !== null && value !== '' && (typeof value !== 'string' || !ISO_DATE.test(value));
    if (bad) return <input className="input" type="text" value={typeof value === 'string' ? value : JSON.stringify(value)} {...common} {...aria} aria-invalid onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />;
    return <input className="input" type="date" value={text} {...common} {...aria} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />;
  }
  const text = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return <input className="input" type="text" value={text} autoComplete="off" {...common} {...aria} onChange={(e) => onChange(e.target.value)} />;
}

export function RequiredMark() { return <><span aria-hidden="true" className="dx-req">*</span><span className="dx-sr"> (required)</span></>; }

/** A labelled control with its problem and, for calculated values, a read-only value. */
export function FieldRow({ path, label, type, required, enumValues, value, derived, derivedValue, clearable, extra, onChange, testId, isLocale, problemPath }: {
  path: string; label: string; type: FieldType; required?: boolean; enumValues?: string[]; value: unknown; derived?: boolean; derivedValue?: unknown; clearable?: boolean; extra?: ReactNode;
  onChange: (v: unknown) => void; testId?: string; isLocale?: boolean; problemPath?: string;
}) {
  const ed = useEditor();
  const technical = useStudio((st) => st.viewMode) === 'technical';
  const id = `dxf-${(testId ?? path).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const probs = problemsAt(ed.problems, problemPath ?? path);
  const absent = value === undefined || value === null || value === '';
  if (derived) {
    const shown = derivedValue === null || derivedValue === undefined ? '—' : type === 'cents' ? formatMoney(derivedValue as number) : String(derivedValue);
    return (
      <div className="dx-field derived" data-testid={`dx-f-${path}`}>
        <span className="dx-label" id={`${id}-l`}>{label}<Tech><span className="chip code">{path}</span></Tech></span>
        <div className="dx-control"><output aria-labelledby={`${id}-l`} className="dx-calc">{shown}</output><span className="dx-note">calculated</span></div>
      </div>
    );
  }
  return (
    <div className={`dx-field${probs.length ? ' bad' : ''}${ed.highlight.includes(problemPath ?? path) ? ' highlight' : ''}`} data-dx-field={problemPath ?? path} data-highlight={ed.highlight.includes(problemPath ?? path) ? 'yes' : undefined}>
      <label className="dx-label" htmlFor={id}>{label}{required && <RequiredMark />}<Tech><span className="chip code">{path}</span></Tech></label>
      <div className="dx-control">
        <ScalarInput type={type} value={value} onChange={onChange} label={label} path={problemPath ?? path} testId={testId ?? `dx-f-${path}`} enumValues={enumValues} required={required}
          disabled={ed.readOnly} invalid={probs.length > 0} id={id} describedBy={probs.length ? `${id}-p` : undefined} isLocale={isLocale} />
        {clearable && !required && !absent && type !== 'bool' && !ed.readOnly && (
          <button type="button" className="btn ghost sm icon dx-clear" aria-label={`Clear ${label}`} title="Clear this value" onClick={() => onChange(undefined)}>×</button>
        )}
        {extra}
      </div>
      {probs.length > 0 && <div className="dx-problem" id={`${id}-p`} data-testid="dx-field-problem">{probs.map((p) => <span key={p.message}>{plainProblem(p.message, technical)}</span>)}</div>}
    </div>
  );
}
