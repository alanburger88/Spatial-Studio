import { useEffect, useRef, useState } from 'react';
import type { MappingStamp } from '@iss/model';
import { useStudio } from '../../state/store';

/** Who makes a change and when, for the mapping commands (studio user names only; the commands stay pure). */
export function stampNow(): MappingStamp {
  const name = useStudio.getState().session?.user?.name?.trim() || 'Local user';
  return { by: name.slice(0, 80), at: new Date().toISOString() };
}

/** Saves text as a file the browser downloads. */
export function downloadText(fileName: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const TYPE_WORDS: Record<string, string> = { string: 'Text', enum: 'Choice', cents: 'Amount (cents)', int: 'Whole number', points: 'Points', number: 'Number', date: 'Date', bool: 'Yes / no', array: 'List' };

/** Shows a value from a synthetic example in plain words. */
export function exampleText(v: unknown, type: string): string {
  if (v === null || v === undefined || v === '') return '—';
  if (type === 'cents' && typeof v === 'number') return `${v.toLocaleString('en-US')} (${(v / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })})`;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.length ? `${v.length} row${v.length === 1 ? '' : 's'}, e.g. ${JSON.stringify(v[0]).slice(0, 80)}` : 'no rows';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  return String(v);
}

export const ROW_HEIGHT = 46;
/**
 * Only the rows in view are drawn when a list is long (hundreds of fields). Returns the slice to draw and the blank space
 * above and below it, so the scroll bar and keyboard order stay right.
 */
export function useWindow(count: number, rowHeight = ROW_HEIGHT, threshold = 120) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => setTop(el.scrollTop);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => setHeight(el.clientHeight || 600)) : null;
    ro?.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); ro?.disconnect(); };
  }, []);
  if (count <= threshold) return { ref, start: 0, end: count, before: 0, after: 0, windowed: false };
  const start = Math.max(0, Math.floor(top / rowHeight) - 10);
  const end = Math.min(count, Math.ceil((top + height) / rowHeight) + 10);
  return { ref, start, end, before: start * rowHeight, after: (count - end) * rowHeight, windowed: true };
}
