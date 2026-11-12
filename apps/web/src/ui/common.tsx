import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStudio } from '../state/store';
import { Icon } from './icons';

/**
 * Compact one-line screen header: title, an "About this view" disclosure (the long description) and actions.
 * The description stays in the DOM for assistive technology and opens on demand for sighted users.
 */
export function ScreenHeader(props: { id: string; title: string; subtitle: string; badge?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="screen-head" data-screen={props.id}>
      <h1>{props.title}</h1>
      {props.subtitle && (
        <details className="screen-about">
          <summary aria-label={`About ${props.title}`} title="About this view"><Icon.info /></summary>
          <p className="screen-about-pop">{props.subtitle}</p>
        </details>
      )}
      <div className="actions">
        {props.badge}
        {props.actions}
        <SideToggles />
      </div>
    </header>
  );
}

/**
 * Narrow windows (≤ 1100px): side panels marked `data-side="left|right"` + `data-side-title` become slide-out
 * drawers (see app.css). This renders one toggle per panel found in the current screen. Wide windows render nothing.
 */
export function SideToggles() {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 1100px)').matches);
  const [panels, setPanels] = useState<Array<{ title: string; side: string }>>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1100px)');
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const sides = () => Array.from(document.querySelectorAll<HTMLElement>('#main [data-side]'));
  useEffect(() => {
    if (!narrow) { sides().forEach((el) => el.removeAttribute('data-side-open')); setOpen(null); setPanels([]); return; }
    const scan = () => {
      const next = sides().map((el) => ({ title: el.dataset.sideTitle ?? 'Panel', side: el.dataset.side ?? 'right' }));
      setPanels((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
    };
    scan();
    const mo = new MutationObserver(scan);
    const main = document.getElementById('main');
    if (main) mo.observe(main, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [narrow]);
  useEffect(() => {
    if (!narrow) return;
    sides().forEach((el) => { if (el.dataset.sideTitle === open) el.setAttribute('data-side-open', ''); else el.removeAttribute('data-side-open'); });
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    const onDown = (e: MouseEvent) => { const t = e.target as HTMLElement; if (!t.closest('[data-side-open]') && !t.closest('.side-toggles') && !t.closest('.dialog-backdrop')) setOpen(null); };
    window.addEventListener('keydown', onKey); document.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open, narrow, panels]);
  if (!narrow || panels.length === 0) return null;
  return (
    <div className="side-toggles" role="group" aria-label="Side panels">
      {panels.map((p) => (
        <button key={p.title} type="button" className="btn sm" aria-pressed={open === p.title} aria-expanded={open === p.title} onClick={() => setOpen(open === p.title ? null : p.title)} data-testid={`side-toggle-${p.side}`}>{p.title}</button>
      ))}
    </div>
  );
}

/**
 * A thing with a readable name and a technical code (component ID, field path, record ID, locale).
 * Business view shows the name with the code on hover; Technical view shows both.
 */
export function Named({ name, code, strong }: { name: ReactNode; code: string; strong?: boolean }) {
  const mode = useStudio((s) => s.viewMode);
  const label = strong ? <strong>{name}</strong> : name;
  if (mode === 'technical') return <span className="named">{label} <span className="chip code">{code}</span></span>;
  return <span className="named" title={code}>{label}</span>;
}

/** Renders children only in Technical view (engine internals: run IDs, hashes, raw expressions). */
export function Tech({ children }: { children: ReactNode }) {
  const mode = useStudio((s) => s.viewMode);
  return mode === 'technical' ? <>{children}</> : null;
}

/** Renders children only in Business view. */
export function Biz({ children }: { children: ReactNode }) {
  const mode = useStudio((s) => s.viewMode);
  return mode === 'business' ? <>{children}</> : null;
}

/**
 * Proof disclosure: technical evidence (hashes, run IDs, JSON) shown inline in Technical view and
 * collapsed behind a "Proof" toggle in Business view. Content always stays available.
 */
export function Proof({ children, label = 'Proof', testId }: { children: ReactNode; label?: string; testId?: string }) {
  const mode = useStudio((s) => s.viewMode);
  if (mode === 'technical') return <div className="proof open" data-testid={testId}>{children}</div>;
  return (
    <details className="proof" data-testid={testId}>
      <summary><Icon.info /> {label}</summary>
      <div className="proof-body">{children}</div>
    </details>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="empty" role="status" aria-live="polite"><span className="spinner" /><span>{label}</span></div>;
}

export function ErrorState({ title = 'Something went wrong', message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <div className="empty" role="alert">
      <strong>{title}</strong>
      <span className="muted" style={{ maxWidth: 480 }}>{message}</span>
      {onRetry && <button className="btn" onClick={onRetry}><Icon.reset /> Retry</button>}
    </div>
  );
}

export function Empty({ title, message, children }: { title: string; message?: string; children?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{message && <span>{message}</span>}{children}</div>;
}

const dialogStack: object[] = [];

export function Dialog({ title, onClose, children, footer, labelledBy = 'dialog-title' }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    const el = ref.current;
    el?.querySelector<HTMLElement>('button, [href], input, select, textarea')?.focus();
    // Only the top-most open dialog reacts to Escape (nested dialogs, e.g. the image library over Styles & brand).
    const token = {};
    dialogStack.push(token);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && dialogStack[dialogStack.length - 1] === token) { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); const i = dialogStack.indexOf(token); if (i >= 0) dialogStack.splice(i, 1); (opener.current as HTMLElement | null)?.focus?.(); };
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref}>
        <header id={labelledBy}>{title}<button className="btn ghost icon" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close dialog"><Icon.close /></button></header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStudio((s) => s.toasts);
  const dismiss = useStudio((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)} data-testid={t.kind === 'error' ? 'toast-error' : 'toast'}>
          <strong>{t.title}</strong>
          {t.message && <span className="muted">{t.message}</span>}
        </div>
      ))}
    </div>
  );
}

export function SeverityLabel({ severity }: { severity: string }) {
  const icon = severity === 'info' ? '●' : severity === 'warning' ? '▲' : '■';
  return <span className={`sev sev-label ${severity}`}><span aria-hidden="true">{icon}</span>{severity}</span>;
}

export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '−' : ''}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}
