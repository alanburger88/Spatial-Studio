import type { ContentPart, Locale, Project } from './types';
import { parseCsv } from './importRecords';

/** Translation workflow helpers (C1). Pure: derive everything from the project (and, optionally, resolver-derived usage). */

export type TranslationState = 'approved' | 'draft' | 'missing';

/**
 * What the resolver saw for each synthetic record. The model package cannot import the resolver, so callers pass this in:
 * `partIds` = every content part visible to that record, `requiredPartIds` = the parts the resolver demands a translation for
 * (selected variants plus mandatory nodes) and `requiresLocale` = the locale forced by a matched setApprovedLocale rule.
 */
export interface TranslationUsageEntry { recordId: string; locale: string; partIds: string[]; requiredPartIds: string[]; requiresLocale: string | null }

export interface TokenCheck { ok: boolean; missing: string[]; extra: string[] }

export interface LocaleStatus {
  locale: Locale;
  status: TranslationState;
  approvedText?: string;
  draftText?: string;
  /** A draft exists that differs from the approved text. */
  pendingDraft: boolean;
  mandatory: boolean;
  mandatoryReasons: string[];
  /** Token check of the draft (when present) else of the approved text. */
  tokenCheck: TokenCheck;
  /** Synthetic records of this locale that need this text but cannot get an approved one. */
  affectedRecordIds: string[];
}

export interface TranslationRow {
  partId: string;
  title: string;
  type: ContentPart['type'];
  version: number;
  /** Why the part counts as used by the document. */
  usedAs: Array<'variant' | 'disclosure' | 'section' | 'node' | 'required'>;
  nodeIds: string[];
  sourceText: string;
  sourceTokens: string[];
  /** Number of synthetic records that currently see the part (null when no usage was supplied). */
  seenByRecords: number | null;
  status: LocaleStatus;
}

export interface TranslationSummary { locale: Locale; total: number; approved: number; drafts: number; missing: number; mandatoryMissing: number; affectedRecords: number; usageKnown: boolean }

export interface TranslationStatus { locale: Locale; rows: TranslationRow[]; summary: TranslationSummary }

export const TRANSLATION_MAX_CHARS = 4000;
export const SOURCE_LOCALE: Locale = 'en-US';
export const TARGET_LOCALES: Locale[] = ['es-US'];

const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
export const tokensOfText = (t: string): string[] => [...(t ?? '').matchAll(TOKEN_RE)].map((m) => m[1]).sort();

export function checkTokens(source: string, target: string): TokenCheck {
  const s = tokensOfText(source), t = tokensOfText(target);
  const rest = [...t];
  const missing: string[] = [];
  for (const x of s) { const i = rest.indexOf(x); if (i >= 0) rest.splice(i, 1); else missing.push(x); }
  return { ok: missing.length === 0 && rest.length === 0, missing, extra: rest };
}

/** Parts the document actually uses (same notion of "referenced" as the binding analysis, plus disclosure nodes). */
function usedParts(project: Project): Map<string, { usedAs: Set<TranslationRow['usedAs'][number]>; nodeIds: Set<string> }> {
  const out = new Map<string, { usedAs: Set<TranslationRow['usedAs'][number]>; nodeIds: Set<string> }>();
  const add = (id: string | undefined, as: TranslationRow['usedAs'][number], nodeId?: string) => {
    if (!id) return;
    const e = out.get(id) ?? { usedAs: new Set(), nodeIds: new Set() };
    e.usedAs.add(as); if (nodeId) e.nodeIds.add(nodeId);
    out.set(id, e);
  };
  for (const n of project.nodes) {
    for (const v of n.variantIds ?? []) add(v, 'variant', n.id);
    if (n.contentPartId) add(n.contentPartId, n.type === 'disclosure' ? 'disclosure' : 'node', n.id);
  }
  for (const r of project.rules) if (r.then.op === 'showSection') {
    const tid = r.then.targetNodeId;
    const target = project.nodes.find((n) => n.id === tid);
    add(tid, 'section', tid);
    if (target?.contentPartId) add(target.contentPartId, 'section', target.id);
  }
  // The resolver demands a translation for every mandatory node id that is also a content part (whether or not a node renders it).
  for (const r of project.rules) if (r.mode === 'obligation' && r.then.op === 'requireNodes') for (const id of r.then.nodeIds) add(id, 'required', id);
  return new Map([...out].filter(([id]) => project.contentParts.some((c) => c.id === id)));
}

/** Parts that are always required regardless of record: nodes required by obligation rules, `required` nodes, and disclosures. */
function staticMandatory(project: Project): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (id: string, why: string) => { const a = out.get(id) ?? []; if (!a.includes(why)) a.push(why); out.set(id, a); };
  const byNode = new Map(project.nodes.map((n) => [n.id, n]));
  const addNode = (nodeId: string, why: string) => { const n = byNode.get(nodeId); add(n?.contentPartId ?? nodeId, why); if (n?.contentPartId && n.contentPartId !== nodeId) add(nodeId, why); };
  for (const r of project.rules) if (r.mode === 'obligation' && r.then.op === 'requireNodes') for (const id of r.then.nodeIds) addNode(id, `Required by rule ${r.id}`);
  for (const n of project.nodes) if (n.required && n.contentPartId) add(n.contentPartId, 'Required component');
  for (const c of project.contentParts) if (c.type === 'disclosure') add(c.id, 'Disclosure');
  return out;
}

export function translationStatus(project: Project, locale: Locale = 'es-US', usage?: TranslationUsageEntry[]): TranslationStatus {
  const used = usedParts(project);
  const stat = staticMandatory(project);
  const localeRule = project.rules.some((r) => r.then.op === 'setApprovedLocale' && r.then.locale === locale && r.then.errorIfMissingMandatoryTranslation);
  const rows: TranslationRow[] = [];
  for (const part of project.contentParts) {
    const u = used.get(part.id);
    if (!u) continue;
    const source = part.approvedLocales[SOURCE_LOCALE] ?? '';
    const approvedText = part.approvedLocales[locale];
    const draftText = part.draftLocales?.[locale];
    const status: TranslationState = approvedText?.trim() ? 'approved' : draftText?.trim() ? 'draft' : 'missing';
    const reasons = [...(stat.get(part.id) ?? [])];
    const seen = usage?.filter((e) => e.partIds.includes(part.id));
    const needing = usage?.filter((e) => e.requiresLocale === locale && e.requiredPartIds.includes(part.id)) ?? [];
    if (localeRule && needing.length) reasons.push(`Shown to ${locale} customers (translation rule errors when missing)`);
    const mandatory = reasons.length > 0;
    const textToCheck = draftText?.trim() ? draftText : approvedText ?? '';
    rows.push({
      partId: part.id, title: part.title, type: part.type, version: part.version,
      usedAs: [...u.usedAs], nodeIds: [...u.nodeIds], sourceText: source, sourceTokens: tokensOfText(source),
      seenByRecords: seen ? seen.length : null,
      status: {
        locale, status, approvedText, draftText,
        pendingDraft: !!draftText?.trim() && draftText !== approvedText,
        mandatory, mandatoryReasons: reasons,
        tokenCheck: textToCheck ? checkTokens(source, textToCheck) : { ok: true, missing: [], extra: [] },
        affectedRecordIds: status === 'approved' ? [] : needing.map((e) => e.recordId),
      },
    });
  }
  const missing = rows.filter((r) => r.status.status === 'missing');
  const mandatoryMissing = rows.filter((r) => r.status.mandatory && r.status.status !== 'approved');
  const affected = new Set(rows.flatMap((r) => r.status.affectedRecordIds));
  return {
    locale, rows,
    summary: {
      locale, total: rows.length,
      approved: rows.filter((r) => r.status.status === 'approved').length,
      drafts: rows.filter((r) => r.status.status === 'draft').length,
      missing: missing.length,
      mandatoryMissing: mandatoryMissing.length,
      affectedRecords: affected.size,
      usageKnown: !!usage,
    },
  };
}

/* ----------------------------------------------------------------------- CSV */

const esc = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toTranslationCsv(project: Project, locale: Locale = 'es-US', usage?: TranslationUsageEntry[]): string {
  const st = translationStatus(project, locale, usage);
  const head = ['partId', 'title', 'mandatory', 'status', SOURCE_LOCALE, locale];
  const lines = st.rows.map((r) => [r.partId, r.title, r.status.mandatory ? 'yes' : 'no', r.status.status, r.sourceText, r.status.draftText ?? r.status.approvedText ?? ''].map(esc).join(','));
  return [head.map(esc).join(','), ...lines].join('\r\n') + '\r\n';
}

export interface TranslationImportError { row: number; partId: string; code: 'UNKNOWN_ID' | 'TOKEN_MISMATCH' | 'TOO_LONG' | 'BAD_HEADER' | 'DUPLICATE'; message: string }
export interface TranslationImportResult { drafts: Array<{ partId: string; text: string }>; errors: TranslationImportError[]; skipped: number; rows: number }

/** CSV -> drafts. Rows with an empty translation or identical to the approved text are skipped; nothing is ever approved here. */
export function fromTranslationCsv(project: Project, csv: string, locale: Locale = 'es-US'): TranslationImportResult {
  const rows = parseCsv(csv.replace(/^﻿/, ''));
  const res: TranslationImportResult = { drafts: [], errors: [], skipped: 0, rows: Math.max(0, rows.length - 1) };
  if (!rows.length) { res.errors.push({ row: 1, partId: '', code: 'BAD_HEADER', message: 'The file is empty.' }); return res; }
  const head = rows[0].map((h) => h.trim());
  const idCol = head.findIndex((h) => /^(partid|part id|id)$/i.test(h));
  const locCol = head.findIndex((h) => h.toLowerCase() === locale.toLowerCase());
  if (idCol < 0 || locCol < 0) { res.errors.push({ row: 1, partId: '', code: 'BAD_HEADER', message: `Expected columns “partId” and “${locale}”.` }); return res; }
  const seen = new Set<string>();
  rows.slice(1).forEach((r, i) => {
    const row = i + 2, partId = (r[idCol] ?? '').trim(), text = r[locCol] ?? '';
    const part = project.contentParts.find((c) => c.id === partId);
    if (!part) { res.errors.push({ row, partId, code: 'UNKNOWN_ID', message: `Unknown content part “${partId}”.` }); return; }
    if (!text.trim()) { res.skipped++; return; }
    if (seen.has(partId)) { res.errors.push({ row, partId, code: 'DUPLICATE', message: `“${partId}” appears more than once; only the first row is used.` }); return; }
    seen.add(partId);
    if (text.length > TRANSLATION_MAX_CHARS) { res.errors.push({ row, partId, code: 'TOO_LONG', message: `Translation is ${text.length} characters; the limit is ${TRANSLATION_MAX_CHARS}.` }); return; }
    const tc = checkTokens(part.approvedLocales[SOURCE_LOCALE] ?? '', text);
    if (!tc.ok) { res.errors.push({ row, partId, code: 'TOKEN_MISMATCH', message: `Data tokens differ from English${tc.missing.length ? `; missing ${tc.missing.map((t) => `{{${t}}}`).join(', ')}` : ''}${tc.extra.length ? `; unexpected ${tc.extra.map((t) => `{{${t}}}`).join(', ')}` : ''}.` }); return; }
    if (text === part.approvedLocales[locale] && !part.draftLocales?.[locale]) { res.skipped++; return; }
    res.drafts.push({ partId, text });
  });
  return res;
}

/** Structural subset of the resolver's Resolution, so the model package needs no resolver import. */
export interface ResolutionLike {
  result: { selectedVariants: Record<string, string | null>; requiredNodes: string[] };
  trace: Array<{ matched: boolean; action?: { op: string; locale?: string } }>;
  root: { id: string; visible: boolean; disclosure?: { contentPartId: string }; variants?: { selected: string[] }; children: any[] };
}

/** Derives one usage entry from a real resolution (what the resolver would demand and show for this record). */
export function usageEntryFromResolution(project: Project, record: { recordId: string; customer?: { locale?: string } }, res: ResolutionLike): TranslationUsageEntry {
  const isPart = (id: string | null | undefined): id is string => !!id && project.contentParts.some((c) => c.id === id);
  const required = new Set<string>(), seen = new Set<string>();
  const req = (id: string | null | undefined) => { if (isPart(id)) { required.add(id); seen.add(id); } };
  Object.values(res.result.selectedVariants).forEach(req);
  res.result.requiredNodes.forEach(req);
  const walk = (n: ResolutionLike['root']) => {
    if (!n.visible) return;
    if (isPart(n.disclosure?.contentPartId)) seen.add(n.disclosure!.contentPartId);
    const pn = project.nodes.find((x) => x.id === n.id);
    if (isPart(pn?.contentPartId)) seen.add(pn!.contentPartId!);
    (n.variants?.selected ?? []).forEach((v) => { if (isPart(v)) seen.add(v); });
    n.children.forEach(walk);
  };
  walk(res.root);
  const lr = res.trace.find((t) => t.matched && t.action?.op === 'setApprovedLocale');
  return { recordId: record.recordId, locale: String(record.customer?.locale ?? 'en-US'), partIds: [...seen], requiredPartIds: [...required], requiresLocale: lr?.action?.locale ?? null };
}
