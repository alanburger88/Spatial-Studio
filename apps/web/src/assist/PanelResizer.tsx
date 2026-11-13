import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { create } from 'zustand';

/**
 * The assistant panel's width: dragged from its left edge, remembered on this device, and published as the CSS
 * variable `--assist-w` so the panel and the floating helpers that keep clear of it stay in step.
 */
const KEY = 'iss.assistWidth';
export const ASSIST_W = { min: 340, default: 380, max: 960, step: 24 } as const;
const maxNow = () => Math.max(ASSIST_W.min, Math.min(ASSIST_W.max, Math.round((typeof window === 'undefined' ? 1440 : window.innerWidth) * 0.7)));
const clamp = (w: number) => Math.round(Math.max(ASSIST_W.min, Math.min(maxNow(), w)));
const read = () => { try { const n = Number(localStorage.getItem(KEY)); return Number.isFinite(n) && n > 0 ? clamp(n) : ASSIST_W.default; } catch { return ASSIST_W.default; } };

export const useAssistWidth = create<{ width: number; set(w: number, remember?: boolean): void }>((set) => ({
  width: read(),
  set(w, remember = true) {
    const width = clamp(w);
    if (remember) { try { localStorage.setItem(KEY, String(width)); } catch { /* private mode: the width lasts for this visit */ } }
    set({ width });
  },
}));

/** Keeps `--assist-w` on the page in step with the chosen width (and inside the window when it shrinks). */
export function useAssistWidthVar() {
  const width = useAssistWidth((s) => s.width);
  useEffect(() => { document.documentElement.style.setProperty('--assist-w', `${width}px`); }, [width]);
  useEffect(() => {
    const onResize = () => { const s = useAssistWidth.getState(); if (s.width > maxNow()) s.set(maxNow(), false); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
}

/** The drag handle on the panel's left edge. Arrow keys resize it too; double-click (or Home) returns to the usual width. */
export function PanelResizer() {
  const width = useAssistWidth((s) => s.width);
  const set = useAssistWidth((s) => s.set);
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const lastDown = useRef(0);
  useAssistWidthVar();

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Two presses in quick succession = double-click: back to the usual width. (Handled here because the browser's own
    // double-click event is not reliable once the press has been taken over for dragging.)
    if (e.timeStamp - lastDown.current < 350) { lastDown.current = 0; drag.current = null; set(ASSIST_W.default); return; }
    lastDown.current = e.timeStamp;
    drag.current = { startX: e.clientX, startW: width };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add('assist-resizing');
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    set(drag.current.startW + (drag.current.startX - e.clientX), false);
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    document.body.classList.remove('assist-resizing');
    set(useAssistWidth.getState().width, true);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const by = e.shiftKey ? ASSIST_W.step * 4 : ASSIST_W.step;
    if (e.key === 'ArrowLeft') { e.preventDefault(); set(width + by); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); set(width - by); }
    else if (e.key === 'Home') { e.preventDefault(); set(ASSIST_W.default); }
    else if (e.key === 'End') { e.preventDefault(); set(maxNow()); }
  };

  return (
    <div className="assist-resizer" role="separator" aria-orientation="vertical" aria-label="Resize the assistant panel" aria-valuemin={ASSIST_W.min} aria-valuemax={maxNow()} aria-valuenow={width} tabIndex={0}
      title="Drag to resize. Double-click to reset." data-testid="assist-resizer"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end} onKeyDown={onKeyDown}>
      <span aria-hidden="true" />
    </div>
  );
}
