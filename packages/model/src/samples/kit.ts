import { applyCommand, type Command } from '../commands';
import { richFromMarkup } from '../rich';
import type { DocNode, NodeLayout, PagedLayout, Predicate, Project, ResponsiveLayout, Rule, SyntheticRecord } from '../types';

/**
 * Small helpers shared by the builders of the example documents. Every change goes through `applyCommand`, so a sample
 * passes exactly the validation a person's edits would; a refusal is a programming error and throws with its reason.
 * Pure: no clock, no randomness, no network.
 */

export class SampleBuilder {
  project: Project;
  constructor(project: Project) { this.project = project; }
  /** Applies one command; throws (with the command and the reason) when the studio refuses it. */
  run(cmd: Command): this {
    const r = applyCommand(this.project, cmd);
    if (!r.ok) throw new Error(`${this.project.projectId}: ${cmd.type}${'nodeId' in cmd ? ` ${String((cmd as { nodeId?: string }).nodeId)}` : ''} refused: ${r.message}`);
    this.project = r.project;
    return this;
  }
  insert(node: DocNode, parentId = this.project.rootNodeId, index?: number): this {
    return this.run({ type: 'INSERT_NODE', node, parentId, ...(index !== undefined ? { index } : {}) });
  }
  rule(rule: Omit<Rule, 'scope' | 'version' | 'enabled'> & { enabled?: boolean }): this {
    return this.run({ type: 'UPSERT_RULE', rule: { scope: 'custom', version: 1, enabled: true, ...rule } as Rule });
  }
  /** A message (variant set) with its versions; the first listed version marked `fallback` is shown when no rule applies. */
  message(node: Omit<DocNode, 'type' | 'variantIds' | 'fallbackVariantId'>, versions: Array<{ id: string; title: string; text: string; fallback?: boolean }>, parentId?: string): this {
    this.insert({ ...node, type: 'variant-set', policy: 'exclusive', variantIds: [] } as DocNode, parentId);
    for (const v of versions) this.run({ type: 'ADD_VARIANT', nodeId: node.id, variantId: v.id, title: v.title, text: v.text });
    const fb = versions.find((v) => v.fallback);
    if (fb) this.run({ type: 'UPDATE_NODE', nodeId: node.id, patch: { fallbackVariantId: fb.id } });
    return this;
  }
  /** A notice (protected disclosure) with its wording. */
  notice(node: Omit<DocNode, 'type' | 'contentPartId'>, title: string, text: string, parentId?: string): this {
    this.run({ type: 'UPSERT_CONTENT_PART', part: { id: node.id, version: 1, title, approvedLocales: { 'en-US': text }, syntheticDemoOnly: true, type: 'disclosure' } });
    return this.insert({ protected: true, jurisdiction: ['US-demo'], ...node, type: 'disclosure', contentPartId: node.id } as DocNode, parentId);
  }
  /** Drafts and approves Spanish (or another language) for many texts at once; `draftOnly` ids stay drafts. */
  translate(locale: string, texts: Record<string, string>, draftOnly: ReadonlySet<string> = new Set()): this {
    const items = Object.entries(texts).map(([id, text]) => ({ id, text }));
    if (!items.length) return this;
    this.run({ type: 'SET_TRANSLATION_DRAFTS', locale, items });
    const approve = items.map((i) => i.id).filter((id) => !draftOnly.has(id));
    if (approve.length) this.run({ type: 'APPROVE_TRANSLATIONS', locale, ids: approve });
    return this;
  }
}

/* ------------------------------------------------------------------ layouts */

type Html = ResponsiveLayout;
export const flow = (paged: Partial<PagedLayout> = {}, html: Html = { area: 'main', span: 12 }): NodeLayout => ({
  paged: { mode: 'flow', widthPct: 100, align: 'left', spaceBeforePt: 10, ...paged },
  html,
});
export const fixed = (xPt: number, yPt: number, wPt: number, hPt: number, pages: PagedLayout['pages'] = 'first', html: Html = { area: 'header', span: 12 }): NodeLayout => ({
  paged: { mode: 'fixed', xPt, yPt, wPt, hPt, pages },
  html,
});

/* ------------------------------------------------------------------ nodes */

export const text = (id: string, name: string, markup: string, layout: NodeLayout = flow(), extra: Partial<DocNode> = {}): DocNode =>
  ({ id, type: 'rich-text', name, content: richFromMarkup(markup), layout, ...extra });
export const container = (id: string, name: string, layout: NodeLayout, extra: Partial<DocNode> = {}): DocNode =>
  ({ id, type: 'container', name, children: [], layout, ...extra });
export const metric = (id: string, label: string, binding: string, formatter: DocNode['formatter'], importance: 'primary' | 'secondary', layout: NodeLayout): DocNode =>
  ({ id, type: 'summary-metric', name: label, label, binding, formatter, importance, nullPolicy: 'fallback', fallbackText: '—', layout });

/* ------------------------------------------------------------------ conditions */

export const eq = (path: string, value: string | number | boolean): Predicate => ({ op: 'eq', path, value });
export const isIn = (path: string, value: Array<string | number>): Predicate => ({ op: 'in', path, value });
export const gt = (path: string, value: number): Predicate => ({ op: 'gt', path, value });
export const gte = (path: string, value: number): Predicate => ({ op: 'gte', path, value });
export const lt = (path: string, value: number): Predicate => ({ op: 'lt', path, value });
export const and = (...args: Predicate[]): Predicate => ({ op: 'and', args });

/* ------------------------------------------------------------------ arithmetic used to make the customers consistent */

/** Half away from zero, as the studio's ROUND does. */
export const roundHalfAwayFromZero = (x: number): number => (x < 0 ? -Math.round(-x - 1e-9 + 1e-9) : Math.round(x + 1e-9));
/** An amount of `quantity` at `rate` ten-thousandths of a dollar, to the cent. */
export const centsAt = (quantity: number, rateTenThousandths: number): number => roundHalfAwayFromZero((quantity * rateTenThousandths) / 100);
export const dollars = (cents: number): string => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;

/** Adds days to an ISO day (UTC, pure). */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
export const daysBetween = (a: string, b: string): number => {
  const n = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86_400_000; };
  return n(b) - n(a);
};

/** One example document as the studio seeds it: the project, its own customers (stable ids) and what is intended about it. */
export interface SampleCustomer extends SyntheticRecord { projectId: string; documentType: 'custom'; custom: Record<string, unknown> }
