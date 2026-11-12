import { useEffect, useRef, type ReactNode } from 'react';
import { useStudio } from '../state/store';
import { Icon } from './icons';

export function ScreenHeader(props: { id: string; title: string; subtitle: string; badge?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="screen-head">
      <div style={{ minWidth: 0 }}>
        <div className="screen-kicker">Screen {props.id.slice(1)} / 12 · {props.id}</div>
        <h1>{props.title}</h1>
        <p>{props.subtitle}</p>
      </div>
      <div className="actions">
        {props.badge}
        {props.actions}
      </div>
    </header>
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

export function Dialog({ title, onClose, children, footer, labelledBy = 'dialog-title' }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    const el = ref.current;
    el?.querySelector<HTMLElement>('button, [href], input, select, textarea')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); (opener.current as HTMLElement | null)?.focus?.(); };
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
  return <span className={`sev ${severity}`}><span aria-hidden="true">{icon}</span>{severity}</span>;
}

export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '−' : ''}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}
