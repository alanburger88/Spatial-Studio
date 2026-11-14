import type { RichBlock, RichDoc, RichInline, RichMark } from './types';

/**
 * Minimal safe markup → restricted rich-text JSON.
 *  - `# ` / `## ` heading, `- ` bullet, blank line = paragraph break
 *  - `**bold**`, `*italic*`, `[label](https://…)`, `{{path}}` tokens
 * Raw HTML is never interpreted: angle brackets stay literal text.
 */
export function richFromMarkup(markup: string): RichDoc {
  const lines = markup.split(/\r?\n/);
  const content: RichBlock[] = [];
  let list: RichBlock | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { list = null; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { list = null; content.push({ type: 'heading', attrs: { level: Math.min(3, h[1].length + 1) }, content: inlineFromMarkup(h[2]) }); continue; }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!list) { list = { type: 'bulletList', content: [] }; content.push(list); }
      list.content!.push({ type: 'listItem', content: [{ type: 'paragraph', content: inlineFromMarkup(li[1]) }] });
      continue;
    }
    list = null;
    content.push({ type: 'paragraph', content: inlineFromMarkup(line) });
  }
  return { type: 'doc', content };
}

export function inlineFromMarkup(text: string): RichInline[] {
  const out: RichInline[] = [];
  const re = /(\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\})|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (t: string, marks?: RichMark[]) => { if (t) out.push(marks ? { type: 'text', text: t, marks } : { type: 'text', text: t }); };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    if (m[1]) out.push({ type: 'token', attrs: { path: m[2] } });
    else if (m[3]) {
      // bold may itself contain tokens
      for (const inner of inlineFromMarkup(m[4])) {
        if (inner.type === 'text') out.push({ ...inner, marks: [...(inner.marks ?? []), { type: 'bold' }] });
        else out.push({ ...inner, marks: [{ type: 'bold' }] });
      }
    } else if (m[5]) push(m[6], [{ type: 'italic' }]);
    else if (m[7]) push(m[8], [{ type: 'link', attrs: { href: m[9] } }]);
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  return out;
}

export function tokensIn(doc: RichDoc | undefined): string[] {
  const found: string[] = [];
  const walk = (n: RichBlock | RichInline) => {
    if (n.type === 'token' && (n as RichInline).attrs?.path) found.push((n as RichInline).attrs!.path!);
    const c = (n as RichBlock).content;
    if (Array.isArray(c)) c.forEach(walk);
  };
  doc?.content.forEach(walk);
  return found;
}

export function tokensInText(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}/g)].map((m) => m[1]);
}

/** Plain text approximation with tokens shown as {{path}} — used for search and domain checks. */
export function richToPlain(doc: RichDoc | undefined): string {
  if (!doc) return '';
  const parts: string[] = [];
  const walk = (n: RichBlock | RichInline) => {
    if (n.type === 'text') parts.push((n as RichInline).text ?? '');
    else if (n.type === 'token') parts.push(`{{${(n as RichInline).attrs?.path}}}`);
    else if (n.type === 'hardBreak') parts.push('\n');
    const c = (n as RichBlock).content;
    if (Array.isArray(c)) { c.forEach(walk); if (n.type === 'paragraph' || n.type === 'heading') parts.push('\n'); }
  };
  doc.content.forEach(walk);
  return parts.join('').trim();
}

const ALLOWED_BLOCKS = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem']);
const ALLOWED_INLINE = new Set(['text', 'token', 'hardBreak']);
const ALLOWED_MARKS = new Set(['bold', 'italic', 'link']);

export function isSafeUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/[\w\-./?%&=#]*)?$/i.test(url) && !/[<>"'`\s]/.test(url);
}

/** Validates and strips anything outside the restricted schema. Returns sanitized doc + problems. */
export function sanitizeRichDoc(input: unknown): { doc: RichDoc; problems: string[] } {
  const problems: string[] = [];
  const cleanInline = (n: any): RichInline | null => {
    if (!n || typeof n !== 'object' || !ALLOWED_INLINE.has(n.type)) { problems.push(`Removed unsupported inline ${n?.type}`); return null; }
    if (n.type === 'token') {
      const path = String(n.attrs?.path ?? '');
      if (!/^[a-zA-Z0-9_.]+$/.test(path.replace(/\[\]/g, ''))) { problems.push(`Removed malformed token`); return null; }
      // A data value may be bold or italic like the words around it (`**{{custom.amount}}**`); links stay on text only.
      const tokenMarks = (Array.isArray(n.marks) ? n.marks : []).filter((m: any) => m?.type === 'bold' || m?.type === 'italic').map((m: any) => ({ type: m.type as 'bold' | 'italic' }));
      return tokenMarks.length ? { type: 'token', attrs: { path }, marks: tokenMarks } : { type: 'token', attrs: { path } };
    }
    if (n.type === 'hardBreak') return { type: 'hardBreak' };
    const marks: RichMark[] = [];
    for (const m of n.marks ?? []) {
      if (!ALLOWED_MARKS.has(m?.type)) { problems.push(`Removed mark ${m?.type}`); continue; }
      if (m.type === 'link') {
        if (!isSafeUrl(m.attrs?.href)) { problems.push(`Removed unsafe link ${String(m.attrs?.href).slice(0, 40)}`); continue; }
        marks.push({ type: 'link', attrs: { href: m.attrs.href } });
      } else marks.push({ type: m.type });
    }
    const text = String(n.text ?? '');
    return marks.length ? { type: 'text', text, marks } : { type: 'text', text };
  };
  const cleanBlock = (n: any): RichBlock | null => {
    if (!n || typeof n !== 'object' || !ALLOWED_BLOCKS.has(n.type)) { problems.push(`Removed unsupported block ${n?.type}`); return null; }
    const content: Array<RichBlock | RichInline> = [];
    for (const c of n.content ?? []) {
      const isInline = ALLOWED_INLINE.has(c?.type);
      const cleaned = isInline ? cleanInline(c) : cleanBlock(c);
      if (cleaned) content.push(cleaned);
    }
    const out: RichBlock = { type: n.type, content };
    if (n.type === 'heading') out.attrs = { level: Math.max(2, Math.min(4, Number(n.attrs?.level) || 2)) };
    return out;
  };
  const doc: RichDoc = { type: 'doc', content: [] };
  if (!input || typeof input !== 'object' || (input as any).type !== 'doc') { problems.push('Not a rich-text document'); return { doc, problems }; }
  for (const b of (input as any).content ?? []) { const c = cleanBlock(b); if (c) doc.content.push(c); }
  return { doc, problems };
}
