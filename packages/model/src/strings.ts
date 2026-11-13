import type { ChannelConfig, ContentPart, DocNode, Project, RichBlock, RichDoc, RichInline } from './types';
import { richFromMarkup } from './rich';
import { channelConfig, channelStrings, setChannelString } from './channels';
import { SOURCE_LANGUAGE } from './languages';

/**
 * Translatable strings: every customer-visible text that is NOT a content part — figure labels, headings and other
 * rich text, table titles and column headings, link and chart text, header/footer text, and the email and SMS wording.
 * English is always the live model text; translations live in `project.strings` keyed by the ids produced here.
 *
 * Ids start with "@" so they can never collide with a content-part id: `@<nodeId>/<field>`, `@email/<field>`, `@sms/text`.
 */
export interface StringItem {
  id: string;
  kind: 'label' | 'text' | 'channel';
  /** Human title for lists: "New balance · label". */
  title: string;
  source: string;
  nodeId?: string;
}

export const isStringId = (id: string): boolean => id.startsWith('@');

/** Restricted rich text → the safe markup `richFromMarkup` reads (`# heading`, `- bullet`, `**bold**`, `*italic*`, `[label](url)`, `{{path}}`). */
export function richToMarkup(doc: RichDoc | undefined): string {
  if (!doc) return '';
  const inline = (xs: Array<RichBlock | RichInline> | undefined): string => (xs ?? []).map((x) => {
    const n = x as RichInline;
    if (n.type === 'hardBreak') return ' ';
    const marks = n.marks ?? [];
    let t = n.type === 'token' ? `{{${n.attrs?.path ?? ''}}}` : (n.text ?? '');
    if (!t) return '';
    const link = marks.find((m) => m.type === 'link');
    if (marks.some((m) => m.type === 'italic')) t = `*${t}*`;
    if (marks.some((m) => m.type === 'bold')) t = `**${t}**`;
    if (link?.attrs?.href) t = `[${t}](${link.attrs.href})`;
    return t;
  }).join('');
  const lines: string[] = [];
  for (const b of doc.content ?? []) {
    if (b.type === 'heading') lines.push(`${'#'.repeat(Math.max(1, Math.min(3, (b.attrs?.level ?? 2) - 1)))} ${inline(b.content)}`);
    else if (b.type === 'bulletList' || b.type === 'orderedList') {
      for (const li of b.content ?? []) lines.push(`- ${inline(((li as RichBlock).content ?? []).flatMap((p) => (p as RichBlock).content ?? []))}`);
      lines.push('');
    } else lines.push(inline(b.content), '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const TOKEN_RE = /\{\{\s*[\w.]+\s*\}\}/g;
/** Worth translating: has at least one letter outside data tokens and link targets. */
const hasWords = (s: string | undefined): s is string => !!s && /\p{L}/u.test(s.replace(TOKEN_RE, '').replace(/\]\([^)]*\)/g, ']'));

interface Slot { id: string; kind: StringItem['kind']; what: string; get(n: DocNode): string | undefined; set(n: DocNode, v: string): void }

/** Every translatable text slot a node type can carry. `set` works on a node copy and copies the nested object it changes. */
function slotsOf(n: DocNode): Slot[] {
  const s: Slot[] = [];
  const add = (field: string, kind: Slot['kind'], what: string, get: Slot['get'], set: Slot['set']) => s.push({ id: `@${n.id}/${field}`, kind, what, get, set });
  add('label', 'label', 'label', (x) => x.label, (x, v) => { x.label = v; });
  add('fallbackText', 'label', 'text when empty', (x) => x.fallbackText, (x, v) => { x.fallbackText = v; });
  add('caption', 'label', 'title', (x) => x.caption, (x, v) => { x.caption = v; });
  (n.columns ?? []).forEach((c, i) => add(`col.${c.key}`, 'label', `column “${c.label}”`, (x) => x.columns?.[i]?.label, (x, v) => { x.columns = (x.columns ?? []).map((cc, j) => (j === i ? { ...cc, label: v } : cc)); }));
  add('chart.title', 'label', 'chart title', (x) => x.chart?.title, (x, v) => { if (x.chart) x.chart = { ...x.chart, title: v }; });
  (n.chart?.series ?? []).forEach((se, i) => add(`chart.series.${i}`, 'label', `chart series “${se.label}”`, (x) => x.chart?.series?.[i]?.label, (x, v) => { if (x.chart?.series) x.chart = { ...x.chart, series: x.chart.series.map((ss, j) => (j === i ? { ...ss, label: v } : ss)) }; }));
  add('image.alt', 'label', 'image description', (x) => x.image?.alt, (x, v) => { if (x.image) x.image = { ...x.image, alt: v }; });
  add('headerFooter', 'text', 'text', (x) => x.headerFooter?.text, (x, v) => { if (x.headerFooter) x.headerFooter = { ...x.headerFooter, text: v }; });
  add('action.label', 'label', 'button label', (x) => x.action?.label, (x, v) => { if (x.action) x.action = { ...x.action, label: v }; });
  add('action.fallback', 'text', 'printed alternative', (x) => x.action?.fallbackText, (x, v) => { if (x.action) x.action = { ...x.action, fallbackText: v }; });
  add('qr.caption', 'label', 'QR caption', (x) => x.qr?.caption, (x, v) => { if (x.qr) x.qr = { ...x.qr, caption: v }; });
  add('explanation.title', 'label', 'explanation title', (x) => x.explanation?.title, (x, v) => { if (x.explanation) x.explanation = { ...x.explanation, title: v }; });
  add('explanation.summary', 'text', 'explanation summary', (x) => x.explanation?.summary, (x, v) => { if (x.explanation) x.explanation = { ...x.explanation, summary: v }; });
  add('explanation.details', 'text', 'explanation details', (x) => x.explanation?.details, (x, v) => { if (x.explanation) x.explanation = { ...x.explanation, details: v }; });
  add('content', 'text', 'text', (x) => (x.content ? richToMarkup(x.content) : undefined), (x, v) => { x.content = richFromMarkup(v); });
  return s;
}

/** All translatable strings of the project, in document order, followed by the email and SMS wording. */
export function translatableStrings(project: Project): StringItem[] {
  const out: StringItem[] = [];
  for (const n of project.nodes) {
    for (const slot of slotsOf(n)) {
      const source = slot.get(n);
      if (hasWords(source)) out.push({ id: slot.id, kind: slot.kind, title: `${n.name ?? n.id} · ${slot.what}`, source, nodeId: n.id });
    }
  }
  for (const c of channelStrings(project)) if (hasWords(c.source)) out.push({ id: c.id, kind: 'channel', title: c.title, source: c.source });
  return out;
}

export interface LocalizedProject {
  /** The project with every available translation written into the node fields, channel wording and content parts. */
  project: Project;
  channels: ChannelConfig;
  /** Ids (content parts and strings) whose shown text is an unapproved draft. Only ever non-empty when `includeDrafts` is set. */
  draftsShown: string[];
  /** String ids (not content parts) that have no usable translation: the English text is shown. */
  missing: string[];
}

/**
 * The project as a customer of `locale` reads it. Pure. For the source language nothing changes.
 * `includeDrafts` (previews only) also uses unapproved drafts where no approved text exists and reports them in `draftsShown`.
 */
export function localizeProject(project: Project, locale: string | null | undefined, opts: { includeDrafts?: boolean } = {}): LocalizedProject {
  const channels = channelConfig(project);
  if (!locale || locale === SOURCE_LANGUAGE) return { project, channels, draftsShown: [], missing: [] };
  const draftsShown: string[] = [];
  const missing: string[] = [];
  const pick = (id: string): string | undefined => {
    const t = project.strings?.[id];
    const approved = t?.approved?.[locale];
    if (approved?.trim()) return approved;
    const draft = opts.includeDrafts ? t?.draft?.[locale] : undefined;
    if (draft?.trim()) { draftsShown.push(id); return draft; }
    missing.push(id);
    return undefined;
  };
  const nodes = project.nodes.map((n) => {
    let copy: DocNode | null = null;
    for (const slot of slotsOf(n)) {
      if (!hasWords(slot.get(n))) continue;
      const text = pick(slot.id);
      if (text === undefined) continue;
      copy ??= { ...n };
      slot.set(copy, text);
    }
    return copy ?? n;
  });
  const ch: ChannelConfig = { email: { ...channels.email }, sms: { ...channels.sms } };
  for (const c of channelStrings(project)) {
    if (!hasWords(c.source)) continue;
    const text = pick(c.id);
    if (text !== undefined) setChannelString(ch, c.id, text);
  }
  let contentParts: ContentPart[] = project.contentParts;
  if (opts.includeDrafts) {
    contentParts = project.contentParts.map((p) => {
      const draft = p.draftLocales?.[locale];
      if (p.approvedLocales[locale]?.trim() || !draft?.trim()) return p;
      draftsShown.push(p.id);
      return { ...p, approvedLocales: { ...p.approvedLocales, [locale]: draft } };
    });
  }
  return { project: { ...project, nodes, contentParts }, channels: ch, draftsShown, missing };
}
