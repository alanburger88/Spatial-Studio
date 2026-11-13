import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { readingLevel } from '@iss/scenarios';
import type { AssistSource } from '@iss/scenarios';
import { api } from '../api/client';
import { editBlockedReason, useStudio } from '../state/store';
import { Icon } from '../ui/icons';
import { NeedsAi, SuggestionCompare, useBusy } from './common';
import './writing-help.css';

/**
 * "Writing help" for one piece of text: its reading level, and four rewrites (shorter, plainer, warmer, more formal)
 * from a live AI model. Every rewrite is shown beside the original; "Use this" hands the text to `onUse`, which must put
 * it INTO THE FIELD the person is editing, so autosave, validation and undo apply. Nothing is written here.
 */

type Style = 'shorter' | 'plainer' | 'warmer' | 'formal';
const STYLES: Array<{ style: Style; label: string; testId: string; hint: string }> = [
  { style: 'shorter', label: 'Shorter', testId: 'rewrite-shorter', hint: 'Say the same in fewer words' },
  { style: 'plainer', label: 'Plainer', testId: 'rewrite-plainer', hint: 'Simpler words and shorter sentences' },
  { style: 'warmer', label: 'Warmer', testId: 'rewrite-warmer', hint: 'A friendlier tone' },
  { style: 'formal', label: 'More formal', testId: 'rewrite-formal', hint: 'A more formal tone' },
];

/** The reason a person cannot change text (read-only role), or null. */
export function useReadOnlyReason(): string | null {
  const session = useStudio((s) => s.session);
  const r = editBlockedReason(session);
  return r ? `${r}.` : null;
}

/** Records an accepted suggestion in Activity (label and source only; never blocks). */
export function recordAssist(feature: string, label: string, source: AssistSource): void {
  const p = useStudio.getState().project;
  if (p) void api.assistApplied({ projectId: p.projectId, feature, label, source, modelVersion: p.modelVersion });
}

/** "Reading level: Easy (about grade 6) · 14 words", or null when the text is not English or too short. */
export function readingLine(text: string): string | null {
  const r = readingLevel(text);
  return r ? `${r.label} · ${r.words} ${r.words === 1 ? 'word' : 'words'}` : null;
}

/** "42 → 30 characters (12 fewer)". */
export function lengthChange(before: string, after: string): string {
  const d = after.length - before.length;
  return `${before.length} → ${after.length} characters${d === 0 ? '' : ` (${Math.abs(d)} ${d < 0 ? 'fewer' : 'more'})`}`;
}

/**
 * SuggestionCompare whose "Use this" is disabled, with the reason, when the person cannot edit (read-only role)
 * or `blockedReason` says why it cannot be used. They can still read it and discard it.
 */
export function GuardedSuggestion({ blockedReason, ...props }: { blockedReason?: string | null } & Parameters<typeof SuggestionCompare>[0]) {
  const ro = useReadOnlyReason();
  const reason = blockedReason ?? ro;
  return (
    <div className="wh-guarded" data-blocked={reason ? 'true' : undefined}>
      <SuggestionCompare {...props} blockedReason={reason} note={<>{props.note}{reason && <span className="wh-reason" data-testid="assist-blocked-reason">{reason}</span>}</>} />
    </div>
  );
}

interface Result { style: Style; original: string; mode: 'ai' | 'unavailable'; message: string; options: Array<{ text: string; tokenCheck: { ok: boolean; missing: string[]; extra: string[] } }> }

export function WritingHelp({ text, kind, locale, onUse, disabled, extra, testId = 'writing-help', label = 'Writing help' }: {
  text: string; kind: 'message' | 'label' | 'email' | 'sms'; locale?: string; onUse: (text: string) => void; disabled?: boolean; extra?: ReactNode; testId?: string; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [busy, run] = useBusy();
  const [pending, setPending] = useState<Style | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const seq = useRef(0);
  const panelId = useId();
  const english = !locale || locale.toLowerCase().startsWith('en');
  const level = english ? readingLine(text) : null;
  const ro = useReadOnlyReason();
  const blockedUse = ro ?? (disabled ? 'Editing is not available right now.' : null);

  const close = () => { setOpen(false); setResult(null); setDismissed(new Set()); seq.current++; btn.current?.focus(); };
  const rewrite = async (style: Style) => {
    const project = useStudio.getState().project;
    if (!project || !text.trim()) return;
    const my = ++seq.current;
    setPending(style); setResult(null); setDismissed(new Set());
    const r = await run(() => api.assistRewrite(project.projectId, { text, style, kind, ...(locale ? { locale } : {}), project }));
    if (seq.current !== my) return;
    setPending(null);
    if (r) setResult({ style, original: text, mode: r.mode, message: r.message, options: r.options ?? [] });
  };
  const use = (r: Result, t: string) => {
    onUse(t);
    recordAssist('rewrite', `Used a “${STYLES.find((s) => s.style === r.style)!.label.toLowerCase()}” rewrite of ${kind === 'email' ? 'an email text' : kind === 'sms' ? 'the text message' : 'a message'}`, 'ai');
    close();
  };
  const visible = result?.options.map((o, i) => ({ o, i })).filter((x) => !dismissed.has(x.i)) ?? [];

  return (
    <span className="wh" data-open={open ? 'true' : undefined}>
      <button type="button" className="btn sm ghost wh-btn" ref={btn} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => (open ? close() : setOpen(true))} data-testid={testId}>
        <Icon.ai width={12} height={12} /> {label}
      </button>
      {open && (
        <div className="wh-panel" id={panelId} role="group" aria-label={label} data-testid={`${testId}-panel`}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
          <div className="wh-head">
            <span className="wh-level" data-testid="writing-reading-level">
              {level ? <>Reading level: {level}</> : english ? 'Reading level appears once the text has three words.' : 'Reading level is shown for English text only.'}
            </span>
            <button type="button" className="btn sm ghost icon" onClick={close} aria-label="Close writing help"><Icon.close width={12} height={12} /></button>
          </div>
          <div className="wh-actions" role="group" aria-label="Rewrite this text">
            {STYLES.map((s) => (
              <button key={s.style} type="button" className="btn sm" onClick={() => rewrite(s.style)} disabled={busy || !text.trim()} aria-busy={pending === s.style} title={!text.trim() ? 'Write some text first' : s.hint} data-testid={s.testId}>
                {pending === s.style ? <><span className="spinner" aria-hidden="true" /> {s.label}</> : s.label}
              </button>
            ))}
          </div>
          {!text.trim() && <p className="muted wh-note">Write some text first, then ask for a rewrite.</p>}
          {extra}
          <div aria-live="polite" className="wh-results">
            {result?.mode === 'unavailable' && <NeedsAi message={result.message} />}
            {result?.mode === 'ai' && visible.length === 0 && <p className="muted wh-note" data-testid="writing-no-options">{result.options.length ? 'All suggestions discarded.' : result.message || 'The assistant returned no usable suggestion.'}</p>}
            {result?.mode === 'ai' && visible.map(({ o, i }) => {
              const before = english ? readingLine(result.original) : null;
              const after = english ? readingLine(o.text) : null;
              return (
                <GuardedSuggestion key={i} original={result.original} suggestion={o.text} source="ai"
                  blockedReason={blockedUse ?? (o.tokenCheck.ok ? null : 'This suggestion changes the data fields in the text, so it cannot be used.')}
                  note={<span data-testid="writing-suggestion-note">
                    {lengthChange(result.original, o.text)}
                    {before && after && <> · Reading level: {before} → {after}</>}
                    {!o.tokenCheck.ok && <> · Data fields differ{o.tokenCheck.missing.length ? ` (missing ${o.tokenCheck.missing.join(', ')})` : ''}</>}
                  </span>}
                  onAccept={() => use(result, o.text)} onDiscard={() => setDismissed((d) => new Set(d).add(i))} />
              );
            })}
          </div>
        </div>
      )}
    </span>
  );
}
