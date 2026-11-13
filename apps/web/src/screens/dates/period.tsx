import { useEffect, useId, useState } from 'react';
import { dayWords, inEffect, isIsoDay, notInEffectWords, periodInWords, type Command, type EffectivePeriod } from '@iss/model';
import { useResolution, useStudio } from '../../state/store';
import './dates.css';

/**
 * Effective periods in the studio: the short chip a rule or an alternative carries in its list, the "not in effect on
 * <day>" marker for the preview date, and the "In effect from / until" fields used by the rule editor, the
 * alternatives editor and conditional sections. Every change is one command through the bus; the engine's refusals
 * (order, no date source) are shown in its own words. A document without a date source shows none of these.
 */

/** "from 1 Jan 2027", "until 1 Mar 2027", "from 1 Jan 2027 until 1 Mar 2027". */
export function periodShort(p: EffectivePeriod): string {
  return [p.from ? `from ${dayWords(p.from)}` : '', p.until ? `until ${dayWords(p.until)}` : ''].filter(Boolean).join(' ');
}

/** The day the current preview is worked out for: "As issued on", or the customer's own date. Null when there is none. */
export function useDocumentDay(): string | null {
  const res = useResolution();
  return res?.documentDate?.date ?? null;
}

export function PeriodChip({ period, testId }: { period: EffectivePeriod | undefined; testId?: string }) {
  if (!period || (!period.from && !period.until)) return null;
  return <span className="chip info dt-period-chip" title={`In effect ${periodInWords(period)}`} data-testid={testId}>{periodShort(period)}</span>;
}

/** "Not in effect on 31 Dec 2026", visible (never hidden) for an item outside its period on the preview day. */
export function NotInEffectChip({ period, day, testId }: { period: EffectivePeriod | undefined; day: string | null; testId?: string }) {
  if (!period || inEffect(period, day) || !day) return null;
  return <span className="chip warning dt-off-chip" title={notInEffectWords(period, day)} data-testid={testId}>Not in effect on {dayWords(day)}</span>;
}

type Result = { ok: true } | { ok: false; message: string };

/**
 * "In effect from / until": two optional dates. A completed date (or clearing one) is one command. `command` builds it
 * from the new period (null = always in effect). Disabled with a reason when `disabledReason` is set.
 */
export function PeriodEditor({ period, command, testId, label = 'In effect', disabledReason, compact }: {
  period: EffectivePeriod | undefined;
  command: (period: EffectivePeriod | null) => Command;
  testId: string;
  label?: string;
  disabledReason?: string | null;
  compact?: boolean;
}) {
  const id = useId();
  const [from, setFrom] = useState(period?.from ?? '');
  const [until, setUntil] = useState(period?.until ?? '');
  const [error, setError] = useState<string | null>(null);
  // The model is the truth: when it changes (undo, another editor), the fields follow it.
  useEffect(() => { setFrom(period?.from ?? ''); setUntil(period?.until ?? ''); setError(null); }, [period?.from, period?.until]);

  const commit = (nextFrom: string, nextUntil: string) => {
    const f = isIsoDay(nextFrom) ? nextFrom : '';
    const u = isIsoDay(nextUntil) ? nextUntil : '';
    if (f === (period?.from ?? '') && u === (period?.until ?? '')) { setError(null); return; }
    const next: EffectivePeriod | null = f || u ? { ...(f ? { from: f } : {}), ...(u ? { until: u } : {}) } : null;
    const out = useStudio.getState().dispatch(command(next)) as Result;
    setError(out.ok ? null : out.message);
  };
  const onChange = (which: 'from' | 'until', v: string) => {
    if (which === 'from') setFrom(v); else setUntil(v);
    // A whole date typed or picked is a change; an empty field is committed when the person leaves it.
    if (isIsoDay(v)) commit(which === 'from' ? v : from, which === 'until' ? v : until);
  };
  const onBlur = (which: 'from' | 'until') => {
    const v = which === 'from' ? from : until;
    if (v === '' && (which === 'from' ? period?.from : period?.until)) commit(which === 'from' ? '' : from, which === 'until' ? '' : until);
  };
  const disabled = !!disabledReason;
  return (
    <div className={`dt-period ${compact ? 'compact' : ''}`} data-testid={testId} role="group" aria-labelledby={`${id}-l`}>
      <span className="dt-period-label" id={`${id}-l`}>{label}</span>
      <label className="dt-period-field">
        <span>from</span>
        <input type="date" className="input" value={from} disabled={disabled} onChange={(e) => onChange('from', e.target.value)} onBlur={() => onBlur('from')} aria-describedby={error ? `${id}-e` : `${id}-h`} data-testid={`${testId}-from`} />
      </label>
      <label className="dt-period-field">
        <span>until</span>
        <input type="date" className="input" value={until} disabled={disabled} onChange={(e) => onChange('until', e.target.value)} onBlur={() => onBlur('until')} aria-describedby={error ? `${id}-e` : `${id}-h`} data-testid={`${testId}-until`} />
      </label>
      {(period?.from || period?.until) && !disabled && <button type="button" className="btn sm ghost" onClick={() => commit('', '')} data-testid={`${testId}-clear`}>Always in effect</button>}
      <span className="hint dt-period-hint" id={`${id}-h`}>{disabledReason ?? (period ? `In effect ${periodInWords(period)}. “Until” is the first day it no longer applies.` : 'Always in effect. Leave both empty unless it should start or stop on a day.')}</span>
      {error && <div className="callout error dt-period-error" role="alert" id={`${id}-e`} data-testid={`${testId}-error`}>{error}</div>}
    </div>
  );
}
