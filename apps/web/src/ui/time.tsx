/** Time wording shared by the version history, review, activity and release screens. */
export function fmtAbs(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function fmtWhen(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 && new Date(iso).toDateString() === new Date(now).toDateString()) return `today ${new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(new Date(iso).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) }) + ' ' + new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
export function When({ iso }: { iso: string | null | undefined }) {
  return <time dateTime={iso ?? undefined} title={fmtAbs(iso)}>{fmtWhen(iso)}</time>;
}
