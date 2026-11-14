import { create } from 'zustand';
import { projectContentDigest, type Project, type SyntheticRecord } from '@iss/model';
import type { Finding } from '@iss/resolver';
import { api, type PdfAccessibilityDto } from '../../api/client';

/**
 * The "full check": what only composed pages can tell (page layout, PDF/web differences, PDF accessibility), run for every customer by the
 * same validation the Validate & Compare screen runs for one. It is slow, so the result is kept (per project, for this
 * browser session) with the time it was made and the model it was made for, and the Blockers screen always says so.
 * Nothing here is model state.
 */

export interface FullCheckResult {
  status: 'idle' | 'running' | 'done' | 'cancelled';
  /** When the last finished check ended, and the model it checked (digest of its content). */
  ranAtMs: number | null;
  digest: string | null;
  modelVersion: number | null;
  /** Customers asked, finished and that could not be checked. */
  total: number;
  done: number;
  failed: number;
  elapsedMs: number | null;
  /** Blocking findings of the last finished check, one per customer they were found for. */
  findings: Array<{ finding: Finding; recordId: string }>;
  error: string | null;
  /**
   * The PDF accessibility part (the studio's own checks on each customer's PDF): how many PDFs were checked, how many
   * failed a check and which checks failed how often. Null before a full check that included it has finished.
   */
  pdf: PdfFullCheck | null;
}

export interface PdfFullCheck {
  /** Customers whose PDF was checked. */
  checked: number;
  /** Customers whose PDF failed at least one check. */
  failed: number;
  /** Customers whose PDF had a check that could not be done (and none failed). */
  notChecked: number;
  /** Failed checks by their name, with the number of customers. */
  failedChecks: Record<string, number>;
  /** Whether the document required an accessible PDF when the check ran (failures are then blockers). */
  required: boolean;
}

const EMPTY: FullCheckResult = { status: 'idle', ranAtMs: null, digest: null, modelVersion: null, total: 0, done: 0, failed: 0, elapsedMs: null, findings: [], error: null, pdf: null };
/** The server composes pages one customer at a time per request; a few in flight keep it busy without flooding it. */
const CONCURRENCY = 4;
/**
 * Page layout, PDF/web differences, and the PDF accessibility checks (only the PDF part of the accessibility suite:
 * the web page's checks are never blockers). PDF accessibility failures are blockers only when the document requires
 * an accessible PDF; otherwise they are warnings and only counted in `pdf`.
 */
const SUITES = ['pagination', 'parity', 'accessibility'];

interface Store {
  byProject: Record<string, FullCheckResult>;
  run(project: Project, records: SyntheticRecord[]): Promise<void>;
  cancel(projectId: string): void;
}

const tokens = new Map<string, { n: number; cancelled: boolean }>();
const SOURCES: Finding['source'][] = ['resolver', 'domain', 'binding', 'composer', 'parity', 'accessibility', 'rules-static', 'translation'];
const SUITE_SOURCE: Record<string, Finding['source']> = { rules: 'resolver', bindings: 'binding', pagination: 'composer', parity: 'parity', accessibility: 'accessibility' };

/** The resolver's Finding shape for an issue the validation API returned. */
function toFinding(i: Record<string, any>): Finding {
  const f: Finding = { code: i.code, severity: i.severity, message: i.message, source: SOURCES.includes(i.source) ? i.source : SUITE_SOURCE[i.suite] ?? 'composer' };
  if (i.nodeId) f.nodeId = i.nodeId;
  if (i.locale) f.locale = i.locale;
  if (i.ruleIds?.length) f.ruleIds = i.ruleIds;
  if (i.ruleId) f.ruleId = i.ruleId;
  if (i.suggestion) f.suggestion = i.suggestion;
  if (i.page !== undefined) f.page = i.page;
  if (i.details) f.details = i.details;
  return f;
}

export const useFullCheck = create<Store>((set, get) => ({
  byProject: {},
  async run(project, records) {
    const pid = project.projectId;
    tokens.get(pid) && (tokens.get(pid)!.cancelled = true);
    const token = { n: (tokens.get(pid)?.n ?? 0) + 1, cancelled: false };
    tokens.set(pid, token);
    const customers = records.filter((r) => r.documentType === project.documentType);
    const prev = get().byProject[pid] ?? EMPTY;
    const put = (patch: Partial<FullCheckResult>) => set((s) => ({ byProject: { ...s.byProject, [pid]: { ...(s.byProject[pid] ?? prev), ...patch } } }));
    put({ status: 'running', total: customers.length, done: 0, failed: 0, error: null });
    const t0 = performance.now();
    const found: Array<{ finding: Finding; recordId: string }> = [];
    const pdf: PdfFullCheck = { checked: 0, failed: 0, notChecked: 0, failedChecks: {}, required: !!project.accessiblePdfRequired };
    let done = 0, failed = 0, next = 0;
    let firstError: string | null = null;
    const worker = async () => {
      while (!token.cancelled && next < customers.length) {
        const r = customers[next++];
        try {
          const out = await api.validateChecks({ projectId: pid, recordId: r.recordId, overrides: {}, journeyCursor: null, project, suites: SUITES, accessibilityScope: 'pdf' });
          if (token.cancelled) return;
          for (const i of (out.issues ?? []) as Array<Record<string, any>>) if (i.severity === 'blocking') found.push({ finding: toFinding(i), recordId: r.recordId });
          const pa = out.pdfAccessibility as PdfAccessibilityDto | null | undefined;
          if (pa) {
            pdf.checked++;
            const bad = pa.studio.checks.filter((c) => c.status === 'failed');
            if (bad.length) pdf.failed++;
            else if (pa.studio.summary.notChecked) pdf.notChecked++;
            for (const c of bad) pdf.failedChecks[c.label] = (pdf.failedChecks[c.label] ?? 0) + 1;
          }
        } catch (e) {
          failed++;
          firstError ??= e instanceof Error ? e.message : String(e);
        }
        done++;
        if (!token.cancelled) put({ done, failed });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, customers.length) }, worker));
    if (token.cancelled) { put({ status: prev.ranAtMs ? 'done' : 'idle', total: prev.total, done: prev.done, failed: prev.failed }); return; }
    const allFailed = customers.length > 0 && failed === customers.length;
    if (allFailed) { put({ status: prev.ranAtMs ? 'done' : 'idle', error: `The full check could not run: ${firstError ?? 'the server did not answer'}` }); return; }
    put({ status: 'done', ranAtMs: Date.now(), digest: projectContentDigest(project), modelVersion: project.modelVersion, total: customers.length, done, failed, elapsedMs: Math.round(performance.now() - t0), findings: found, pdf: pdf.checked ? pdf : null, error: failed ? `${failed} of ${customers.length} customers could not be checked (${firstError}).` : null });
  },
  cancel(projectId) {
    const t = tokens.get(projectId);
    if (t) t.cancelled = true;
  },
}));

export const fullCheckOf = (s: Store, projectId: string): FullCheckResult => s.byProject[projectId] ?? EMPTY;

/** Time of day for "from the full check at 10:42". */
export const clockTime = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
