import { type Project, type SyntheticRecord, type TestCase } from '@iss/model';
import { indexTree, resolve, type Resolution } from '@iss/resolver';

/**
 * Regression test cases: a pinned scenario (record + overrides + journey cursor) and the outcome it must keep
 * producing. Pure: every result comes from the real resolver.
 */

export type TestExpect = TestCase['expect'];

export interface TestDiff {
  kind: 'variant' | 'visible' | 'hidden' | 'locale' | 'blocking' | 'record';
  nodeId?: string;
  expected: string;
  got: string;
  /** Plain language: "Payment guidance: expected Assistance requested, got Payment support". */
  message: string;
}

export interface TestResult { testId: string; name: string; recordId: string; pass: boolean; diffs: TestDiff[] }

const humanise = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.]/g, ' ').toLowerCase();

function title(project: Project, id: string): string {
  const n = project.nodes.find((x) => x.id === id);
  if (n) return n.name ?? humanise(id);
  const c = project.contentParts.find((x) => x.id === id) as { title?: string; name?: string } | undefined;
  return c?.title ?? c?.name ?? humanise(id);
}

interface Outcome { variants: Record<string, string | null>; visible: Map<string, boolean>; locale: string | null; blocking: Array<{ code: string; nodeId?: string }> }

function outcomeOf(project: Project, res: Resolution): Outcome {
  const tree = indexTree(res.root);
  const visible = new Map<string, boolean>();
  for (const n of project.nodes) if (n.type === 'conditional-region') visible.set(n.id, tree.get(n.id)?.visible ?? false);
  const loc = res.trace.find((t) => t.kind === 'rule' && t.matched && t.action?.op === 'setApprovedLocale');
  return {
    variants: { ...res.result.selectedVariants },
    visible,
    locale: loc && loc.action?.op === 'setApprovedLocale' ? loc.action.locale : null,
    blocking: res.findings.filter((f) => f.severity === 'blocking').map((f) => ({ code: f.code, nodeId: f.nodeId })),
  };
}

/** The outcome of a scenario as an `expect` block (what "Pin as test" stores). */
export function captureExpectation(project: Project, record: SyntheticRecord, overrides: Record<string, unknown> = {}, journeyCursor: number | null = null, issueDate?: string | null): TestExpect {
  const o = outcomeOf(project, resolve({ project, record, overrides, journeyCursor, ...(issueDate ? { issueDate } : {}) }));
  const vis = [...o.visible].filter(([, v]) => v).map(([id]) => id).sort();
  const hid = [...o.visible].filter(([, v]) => !v).map(([id]) => id).sort();
  return {
    selectedVariants: o.variants,
    visibleNodeIds: vis,
    hiddenNodeIds: hid,
    approvedLocale: o.locale,
    ...(o.blocking.length === 0 ? { noBlocking: true } : {}),
  };
}

export function runTestCase(project: Project, records: SyntheticRecord[], tc: TestCase): TestResult {
  const base = { testId: tc.id, name: tc.name, recordId: tc.recordId };
  const rec = records.find((r) => r.recordId === tc.recordId);
  if (!rec || rec.documentType !== project.documentType) {
    const message = `Record ${tc.recordId} ${rec ? 'is a different document type' : 'no longer exists'}.`;
    return { ...base, pass: false, diffs: [{ kind: 'record', expected: tc.recordId, got: rec ? rec.documentType : 'missing', message }] };
  }
  const o = outcomeOf(project, resolve({ project, record: rec, overrides: tc.overrides ?? {}, journeyCursor: tc.journeyCursor ?? null, ...(tc.issueDate ? { issueDate: tc.issueDate } : {}) }));
  const diffs: TestDiff[] = [];
  const e = tc.expect;
  const vt = (id: string | null | undefined) => (id ? title(project, id) : 'nothing chosen');
  for (const [nodeId, want] of Object.entries(e.selectedVariants ?? {})) {
    const known = nodeId in o.variants;
    const got = known ? o.variants[nodeId] : undefined;
    if (known && got === want) continue;
    const g = known ? vt(got) : 'section missing';
    diffs.push({ kind: 'variant', nodeId, expected: vt(want), got: g, message: `${title(project, nodeId)}: expected ${vt(want)}, got ${g}` });
  }
  for (const nodeId of e.visibleNodeIds ?? []) if (o.visible.get(nodeId) !== true) diffs.push({ kind: 'visible', nodeId, expected: 'shown', got: 'hidden', message: `${title(project, nodeId)}: expected shown, got hidden` });
  for (const nodeId of e.hiddenNodeIds ?? []) if (o.visible.get(nodeId) === true) diffs.push({ kind: 'hidden', nodeId, expected: 'hidden', got: 'shown', message: `${title(project, nodeId)}: expected hidden, got shown` });
  if (e.approvedLocale !== undefined && (e.approvedLocale ?? null) !== o.locale) {
    const w = e.approvedLocale ?? 'no approved language', g = o.locale ?? 'no approved language';
    diffs.push({ kind: 'locale', expected: w, got: g, message: `Approved language: expected ${w}, got ${g}` });
  }
  if (e.noBlocking && o.blocking.length) {
    const where = [...new Set(o.blocking.map((b) => (b.nodeId ? title(project, b.nodeId) : '')).filter(Boolean))].join(', ');
    diffs.push({ kind: 'blocking', expected: 'no blocking issues', got: `${o.blocking.length} blocking`, message: `Expected no blocking issues, got ${o.blocking.length}${where ? ` (in ${where})` : ''}` });
  }
  return { ...base, pass: diffs.length === 0, diffs };
}

export function runTestCases(project: Project, records: SyntheticRecord[], testCases: TestCase[] = project.testCases ?? []): TestResult[] {
  return testCases.map((t) => runTestCase(project, records, t));
}

export function summariseTests(results: TestResult[]): { total: number; passed: number; failed: number } {
  const passed = results.filter((r) => r.pass).length;
  return { total: results.length, passed, failed: results.length - passed };
}

/** Next free test id (T01, T02, …). */
export function nextTestId(existing: TestCase[]): string {
  const used = new Set(existing.map((t) => t.id));
  for (let i = 1; ; i++) { const id = `T${String(i).padStart(2, '0')}`; if (!used.has(id)) return id; }
}
