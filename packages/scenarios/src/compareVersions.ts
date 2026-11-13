import { digestOf, type ProfileId, type Project, type SyntheticRecord } from '@iss/model';
import { resolve, type RBlock, type RInline, type RNode, type Resolution } from '@iss/resolver';

/**
 * Before & after: what each customer would SEE differently if one version of a document replaced another.
 * Works every customer out under both versions and reports the visible differences part by part, in a form a
 * screen can show in words and outline on the page. Pure and deterministic; the same in the browser and on the server.
 *
 * It compares what the engine decides and writes. It does not compare pixels: a change that only restyles or moves
 * content is reported as `layout` (per part) or `styleChanged` (whole document), with nothing claimed beyond that.
 */

export type VisibleChangeKind =
  | 'message'      // a different alternative is shown
  | 'wording'      // the same part, different words
  | 'appears'      // a part is shown that was not
  | 'disappears'   // a part is no longer shown
  | 'layout'       // the same content, placed or sized differently
  | 'email-sms'    // email or text-message wording
  | 'language'     // the document's language
  | 'stopped'      // a blocking issue now stops the document
  | 'unstopped';   // a blocking issue no longer stops it

export interface VisibleChange {
  kind: VisibleChangeKind;
  /** The part of the document (component id). `@email.subject`, `@sms`, … for email and SMS wording; '' for the language. */
  nodeId: string;
  /** The part's name, for showing to a person. */
  name: string;
  /** What was shown before / is shown after, as plain text ('' when nothing). */
  before: string;
  after: string;
}

/** The most significant kind of difference for one customer, in this order of importance. */
export type ComparisonOutcome = 'stopped' | 'unstopped' | 'message' | 'structure' | 'wording' | 'layout' | 'same';
export const COMPARISON_OUTCOMES: readonly ComparisonOutcome[] = ['stopped', 'unstopped', 'message', 'structure', 'wording', 'layout', 'same'];
export const COMPARISON_OUTCOME_LABEL: Record<ComparisonOutcome, string> = {
  stopped: 'Now stopped by a blocker',
  unstopped: 'No longer stopped',
  message: 'A different message is shown',
  structure: 'Something appears or disappears',
  wording: 'Wording changes',
  layout: 'Layout changes only',
  same: 'No visible change',
};

export interface CustomerComparison {
  recordId: string;
  name: string;
  outcome: ComparisonOutcome;
  changes: VisibleChange[];
  /** Whether a blocking issue stops the document under each version. */
  stoppedBefore: boolean;
  stoppedAfter: boolean;
}

export interface VersionComparison {
  /** Customers worked out (those of the document's kind). */
  evaluated: number;
  customers: CustomerComparison[];
  /** Customer ids per outcome, in the order of `COMPARISON_OUTCOMES`. */
  groups: Record<ComparisonOutcome, string[]>;
  /** The brand, text styles or page settings differ, which can change how every page looks without changing any words. */
  styleChanged: boolean;
  /** The two versions are identical. */
  identical: boolean;
}

const inlineText = (inlines: RInline[] | undefined): string => (inlines ?? []).map((i) => (i.kind === 'break' ? '\n' : i.text)).join('');
const blocksText = (blocks: RBlock[] | undefined): string =>
  (blocks ?? []).map((b) => (b.items ? b.items.map((it) => `• ${inlineText(it)}`).join('\n') : inlineText(b.inlines))).join('\n').trim();

/** Everything a part says to the customer, as plain text. Children are compared separately. */
export function visibleTextOf(n: RNode): string {
  const parts: string[] = [];
  if (n.text) parts.push(blocksText(n.text));
  if (n.field) parts.push(`${n.field.label}: ${n.field.display}`);
  if (n.table) parts.push([n.table.caption, n.table.columns.map((c) => c.label).join(' | '), ...n.table.rows.map((r) => n.table!.columns.map((c) => r.cells[c.key]?.display ?? '').join(' | '))].filter(Boolean).join('\n'));
  if (n.chart) parts.push(`${n.chart.title}: ${n.chart.data.map((d) => `${d.label} ${d.display}`).join(', ')}`);
  // A part with alternatives usually carries the chosen wording in `text` already; fall back to the alternatives when it does not.
  if (n.variants && !n.text?.length) parts.push(n.variants.items.filter((v) => v.selected).map((v) => blocksText(v.text)).join('\n'));
  if (n.disclosure) parts.push(`${n.disclosure.title} (version ${n.disclosure.version})`);
  if (n.action) parts.push(`${n.action.label} → ${n.action.url}`);
  if (n.qr) parts.push(`${n.qr.caption} → ${n.qr.url}`);
  if (n.explanation) parts.push(`${n.explanation.title}: ${n.explanation.summary} ${n.explanation.details}`.trim());
  if (n.image) parts.push(`[image: ${n.image.alt || 'no description'}] ${n.image.src.startsWith('data:') ? digestOf(n.image.src).slice(0, 12) : n.image.src}`);
  if (n.shape) parts.push(`[${n.shape.kind}]`);
  if (n.headerFooter) parts.push(inlineText(n.headerFooter.inlines));
  return parts.filter(Boolean).join('\n').trim();
}

interface Part { id: string; name: string; shown: boolean; text: string; selected: string | null; selectedTitles: string; layout: string }

function partsOf(res: Resolution): Map<string, Part> {
  const out = new Map<string, Part>();
  const walk = (n: RNode, ancestorsShown: boolean) => {
    const shown = ancestorsShown && n.visible;
    const sel = n.variants ? [...n.variants.selected].sort() : null;
    out.set(n.id, {
      id: n.id, name: n.name, shown, text: shown ? visibleTextOf(n) : '',
      selected: sel ? sel.join(', ') : null,
      selectedTitles: sel ? sel.map((id) => n.variants!.items.find((v) => v.id === id)?.title ?? id).join(', ') : '',
      layout: n.layout ? digestOf(n.layout) : '',
    });
    for (const c of n.children) walk(c, shown);
  };
  walk(res.root, true);
  return out;
}

const CHANNEL_PARTS: Array<{ id: string; name: string; get: (r: Resolution) => string }> = [
  { id: '@email.subject', name: 'Email subject', get: (r) => r.channelTexts.subject },
  { id: '@email.preheader', name: 'Email preview line', get: (r) => r.channelTexts.preheader },
  { id: '@email.title', name: 'Email heading', get: (r) => r.channelTexts.title },
  { id: '@email.intro', name: 'Email opening', get: (r) => blocksText(r.channelTexts.intro) },
  { id: '@email.closing', name: 'Email closing', get: (r) => blocksText(r.channelTexts.closing) },
  { id: '@email.sections', name: 'What the email shows', get: (r) => r.channelTexts.sections.filter((s) => s.show).map((s) => s.id).join(', ') },
  { id: '@sms', name: 'Text message', get: (r) => r.channelTexts.sms },
];

const isStopped = (r: Resolution) => r.findings.some((f) => f.severity === 'blocking');
const blockingText = (r: Resolution) => [...new Set(r.findings.filter((f) => f.severity === 'blocking').map((f) => f.message))].join(' · ');

/** The visible differences for one customer, given both resolutions. */
export function visibleChanges(before: Resolution, after: Resolution): VisibleChange[] {
  const changes: VisibleChange[] = [];
  const b = partsOf(before), a = partsOf(after);
  const sb = isStopped(before), sa = isStopped(after);
  if (!sb && sa) changes.push({ kind: 'stopped', nodeId: '', name: 'The document', before: '', after: blockingText(after) });
  if (sb && !sa) changes.push({ kind: 'unstopped', nodeId: '', name: 'The document', before: blockingText(before), after: '' });
  if (before.locale !== after.locale) changes.push({ kind: 'language', nodeId: '', name: 'Language', before: before.locale, after: after.locale });
  // Document order of the AFTER version first, then parts that only the BEFORE version has.
  for (const id of [...a.keys(), ...[...b.keys()].filter((k) => !a.has(k))]) {
    const x = b.get(id), y = a.get(id);
    const name = (y ?? x)!.name;
    const xs = !!x?.shown, ys = !!y?.shown;
    if (!xs && !ys) continue;
    if (!xs && ys) { if (y!.text) changes.push({ kind: 'appears', nodeId: id, name, before: '', after: y!.text }); continue; }
    if (xs && !ys) { if (x!.text) changes.push({ kind: 'disappears', nodeId: id, name, before: x!.text, after: '' }); continue; }
    if (x!.selected !== null && y!.selected !== null && x!.selected !== y!.selected) { changes.push({ kind: 'message', nodeId: id, name, before: x!.selectedTitles, after: y!.selectedTitles }); continue; }
    if (x!.text !== y!.text) { changes.push({ kind: 'wording', nodeId: id, name, before: x!.text, after: y!.text }); continue; }
    if (x!.layout !== y!.layout) changes.push({ kind: 'layout', nodeId: id, name, before: '', after: '' });
  }
  for (const c of CHANNEL_PARTS) {
    const x = c.get(before), y = c.get(after);
    if (x !== y) changes.push({ kind: 'email-sms', nodeId: c.id, name: c.name, before: x, after: y });
  }
  return changes;
}

export function outcomeOf(changes: VisibleChange[]): ComparisonOutcome {
  const has = (...k: VisibleChangeKind[]) => changes.some((c) => k.includes(c.kind));
  if (has('stopped')) return 'stopped';
  if (has('unstopped')) return 'unstopped';
  if (has('message')) return 'message';
  if (has('appears', 'disappears')) return 'structure';
  if (has('wording', 'email-sms', 'language')) return 'wording';
  if (has('layout')) return 'layout';
  return 'same';
}

const styleDigest = (p: Project) => digestOf({ brand: p.brand ?? null, styles: p.styles ?? [], profiles: p.presentationProfiles, issuer: p.issuer });

export interface CompareOptions {
  profileId?: ProfileId;
  /** Previews only: show unapproved translation drafts on a side that is a working version. Never set for a release. */
  includeDraftsBefore?: boolean;
  includeDraftsAfter?: boolean;
  /** "As issued on": both versions are resolved with this document's date (documents that use dates). */
  issueDate?: string | null;
}

export function compareVersions(before: Project, after: Project, allRecords: SyntheticRecord[], opts: CompareOptions = {}): VersionComparison {
  const records = allRecords.filter((r) => r.documentType === after.documentType);
  const groups = Object.fromEntries(COMPARISON_OUTCOMES.map((o) => [o, [] as string[]])) as Record<ComparisonOutcome, string[]>;
  const identical = digestOf(before) === digestOf(after) && !!opts.includeDraftsBefore === !!opts.includeDraftsAfter;
  const customers: CustomerComparison[] = records.map((record) => {
    const name = `${record.customer.givenName} ${record.customer.familyName}`.trim();
    const dated = opts.issueDate ? { issueDate: opts.issueDate } : {};
    const rb = resolve({ project: before, record, overrides: {}, journeyCursor: null, profileId: opts.profileId, includeDrafts: opts.includeDraftsBefore, ...dated });
    if (identical) { const stopped = isStopped(rb); groups.same.push(record.recordId); return { recordId: record.recordId, name, outcome: 'same' as const, changes: [], stoppedBefore: stopped, stoppedAfter: stopped }; }
    const ra = resolve({ project: after, record, overrides: {}, journeyCursor: null, profileId: opts.profileId, includeDrafts: opts.includeDraftsAfter, ...dated });
    const changes = visibleChanges(rb, ra);
    const outcome = outcomeOf(changes);
    groups[outcome].push(record.recordId);
    return { recordId: record.recordId, name, outcome, changes, stoppedBefore: isStopped(rb), stoppedAfter: isStopped(ra) };
  });
  return { evaluated: records.length, customers, groups, styleChanged: styleDigest(before) !== styleDigest(after), identical };
}
