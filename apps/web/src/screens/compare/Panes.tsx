import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComposedPages } from '../../api/client';
import { useStudio } from '../../state/store';
import { wordDiff } from './wordDiff';
import { pageBoxFromCss } from '../../doc/pageBox';

/**
 * The panes of the side-by-side view. Each one shows a real composition of one side and can outline parts of it by
 * component id (`data-node-id`, which both the paged and the web renderer put on every part), and scroll to one.
 */

export interface PaneControl {
  scroller: HTMLElement;
  /** Scrolls the part into view; false when this output does not show it. */
  scrollToNode: (id: string) => boolean;
}
export interface PaneProps {
  /** Components to outline (the parts that differ and are present on this side). */
  marks: string[];
  /** The difference chosen in the list: outlined more strongly. */
  focusId: string | null;
  register: (c: PaneControl | null) => void;
  /** Which component ids this output actually shows (null while it is not drawn). */
  onFound: (found: Set<string> | null) => void;
}

const SAFE_ID = /^[\w.-]+$/;
// The page size comes from the composed CSS: the two versions compared may use different paper.

const fixCss = (css: string) => css.replace(/:root/g, ':host').replace(/(^|[\s,}])body\{/g, '$1:host{');

/** CSS that outlines parts: dashed for a part that differs, solid and heavier for the one chosen. Pattern and weight, not colour alone. */
function markCss(marks: string[], focusId: string | null, mark: string, focus: string, focusSoft: string): string {
  const sel = (id: string) => `[data-node-id="${id}"]`;
  const m = marks.filter((id) => SAFE_ID.test(id) && id !== focusId);
  const parts: string[] = [];
  if (m.length) parts.push(`${m.map(sel).join(',')}{outline:2px dashed ${mark}!important;outline-offset:2px}`);
  if (focusId && SAFE_ID.test(focusId)) parts.push(`${sel(focusId)}{outline:4px solid ${focus}!important;outline-offset:2px;background-color:${focusSoft}!important}`);
  return parts.join('');
}

function useWidth(ref: React.RefObject<HTMLElement>): number {
  const [w, setW] = useState(420);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el); setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function scrollInto(scroller: HTMLElement, el: Element) {
  const r = el.getBoundingClientRect(), c = scroller.getBoundingClientRect();
  scroller.scrollTop += r.top - c.top - 48;
}

/** The colours the outlines use, read from the theme tokens so they follow light and dark. */
function useMarkColours(scrollerRef: React.RefObject<HTMLElement>) {
  const theme = useStudio((s) => s.theme);
  const [cols, setCols] = useState({ mark: 'currentColor', focus: 'currentColor', soft: 'transparent' });
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const get = (n: string, fb: string) => cs.getPropertyValue(n).trim() || fb;
    const next = { mark: get('--cmp-mark', 'currentColor'), focus: get('--cmp-focus', 'currentColor'), soft: get('--cmp-focus-soft', 'transparent') };
    setCols((c) => (c.mark === next.mark && c.focus === next.focus && c.soft === next.soft ? c : next));
  }, [theme, scrollerRef]);
  return cols;
}

/* ------------------------------------------------------------ PDF pages */

function PageHost({ css, html, scale, extra, index, total }: { css: string; html: string; scale: number; extra: string; index: number; total: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const box = useMemo(() => pageBoxFromCss(css), [css]);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${fixCss(css)}:host{display:block;background:transparent!important}.page{box-shadow:none!important;margin:0!important}${extra}</style>${html}`;
  }, [css, html, extra]);
  return (
    <figure className="cmp-page" data-page={index}>
      <figcaption className="muted">Page {index} of {total}</figcaption>
      <div className="cmp-page-frame" style={{ width: box.w * scale, height: box.h * scale }} role="img" aria-label={`Composed page ${index} of ${total}`}>
        <div ref={ref} className="cmp-page-host" style={{ width: box.w, height: box.h, transform: `scale(${scale})` }} />
      </div>
    </figure>
  );
}

export function PagesPane({ data, marks, focusId, register, onFound }: PaneProps & { data: ComposedPages }) {
  const scroller = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const w = useWidth(scroller);
  const scale = Math.min(1, Math.max(0.2, (w - 28) / pageBoxFromCss(data.snapshot.css).w));
  const { mark, focus, soft } = useMarkColours(scroller);
  const extra = useMemo(() => markCss(marks, focusId, mark, focus, soft), [marks, focusId, mark, focus, soft]);
  const pages = data.snapshot.pages;

  useEffect(() => {
    const hostsOf = () => [...(root.current?.querySelectorAll('.cmp-page-host') ?? [])] as HTMLElement[];
    register({
      scroller: scroller.current!,
      scrollToNode: (id) => {
        if (!SAFE_ID.test(id)) return false;
        for (const h of hostsOf()) { const el = h.shadowRoot?.querySelector(`[data-node-id="${id}"]`); if (el) { scrollInto(scroller.current!, el); return true; } }
        return false;
      },
    });
    return () => register(null);
  }, [register]);

  // Runs after every page has drawn itself.
  useEffect(() => {
    const found = new Set<string>();
    for (const h of [...(root.current?.querySelectorAll('.cmp-page-host') ?? [])] as HTMLElement[]) h.shadowRoot?.querySelectorAll('[data-node-id]').forEach((el) => found.add(el.getAttribute('data-node-id')!));
    onFound(found);
    return () => onFound(null);
  }, [data, onFound]);

  return (
    <div className="cmp-scroll" ref={scroller} tabIndex={0} role="region" aria-label="Composed PDF pages (scrolls together with the other side)">
      <div ref={root} className="cmp-pages">
        {pages.map((html, i) => <PageHost key={i} css={data.snapshot.css} html={html} scale={scale} extra={extra} index={i + 1} total={pages.length} />)}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ web page and email (a real document in a frame) */

/**
 * The composed document is shown in a frame that allows no scripts, so the studio can read its structure to outline
 * parts and to scroll to them. The frame is as tall as the document, inside a pane that scrolls.
 */
export function HtmlPane({ html, title, marks, focusId, outlines, register, onFound }: PaneProps & { html: string; title: string; outlines: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const w = useWidth(scroller);
  // The frame runs no scripts (it is only read and outlined), so none are sent to it.
  const doc = useMemo(() => html.replace(/<script\b[\s\S]*?<\/script>/gi, ''), [html]);
  const [height, setHeight] = useState(640);
  const { mark, focus, soft } = useMarkColours(scroller);
  const css = useMemo(() => (outlines ? markCss(marks, focusId, mark, focus, soft) : ''), [outlines, marks, focusId, mark, focus, soft]);

  const apply = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc?.head) return;
    let st = doc.getElementById('cmp-marks') as HTMLStyleElement | null;
    if (!st) { st = doc.createElement('style'); st.id = 'cmp-marks'; doc.head.appendChild(st); }
    st.textContent = css;
    if (outlines) { const found = new Set<string>(); doc.querySelectorAll('[data-node-id]').forEach((el) => found.add(el.getAttribute('data-node-id')!)); onFound(found); } else onFound(null);
  }, [css, outlines, onFound]);
  useEffect(apply, [apply]);

  const measure = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc?.documentElement) return;
    setHeight(Math.max(240, Math.ceil(doc.documentElement.scrollHeight)));
  }, []);
  // A new width can reflow the page: let it shrink back before measuring again.
  useEffect(() => { setHeight(240); const t = window.requestAnimationFrame(() => window.requestAnimationFrame(measure)); return () => window.cancelAnimationFrame(t); }, [w, doc, measure]);

  useEffect(() => {
    register({
      scroller: scroller.current!,
      scrollToNode: (id) => {
        const doc = frame.current?.contentDocument;
        if (!outlines || !doc || !SAFE_ID.test(id)) return false;
        const el = doc.querySelector(`[data-node-id="${id}"]`);
        if (!el) return false;
        const fr = frame.current!.getBoundingClientRect(), sc = scroller.current!.getBoundingClientRect();
        scroller.current!.scrollTop += fr.top - sc.top + el.getBoundingClientRect().top - 48;
        return true;
      },
    });
    return () => register(null);
  }, [register, outlines]);
  useEffect(() => () => onFound(null), [onFound]);

  return (
    <div className="cmp-scroll" ref={scroller} tabIndex={0} role="region" aria-label={`${title} (scrolls together with the other side)`}>
      <iframe ref={frame} title={title} sandbox="allow-same-origin" srcDoc={doc} className="cmp-frame" style={{ height }} onLoad={() => { apply(); measure(); }} />
    </div>
  );
}

/* ------------------------------------------------------------ text message */

export function WordMarked({ pieces, kind }: { pieces: Array<{ text: string; changed: boolean }>; kind: 'before' | 'after' }) {
  return <>{pieces.map((p, i) => (p.changed ? (kind === 'before' ? <del key={i} className="cmp-del">{p.text}</del> : <ins key={i} className="cmp-ins">{p.text}</ins>) : <span key={i}>{p.text}</span>))}</>;
}

export function SmsPane({ text, other, kind, detail }: { text: string; other: string; kind: 'before' | 'after'; detail: string }) {
  const d = useMemo(() => wordDiff(kind === 'before' ? text : other, kind === 'before' ? other : text), [text, other, kind]);
  const pieces = kind === 'before' ? d.before : d.after;
  return (
    <div className="cmp-scroll cmp-sms-wrap" tabIndex={0} role="region" aria-label="Text message">
      <p className="cmp-sms" data-testid={`cmp-sms-${kind}`}>{text ? <WordMarked pieces={pieces} kind={kind} /> : <span className="muted">No text message</span>}</p>
      <p className="muted cmp-sms-detail">{detail}</p>
    </div>
  );
}
