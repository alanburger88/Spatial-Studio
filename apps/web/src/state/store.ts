import { create } from 'zustand';
import { useMemo } from 'react';
import { applyCommand, projectContentDigest, roleCan, ROLE_LABEL, type Command, type Permission, type Persona, type Project, type ProfileId, type SyntheticRecord } from '@iss/model';
import { resolve, type Resolution } from '@iss/resolver';
import { ScenarioEngine, type DimensionId } from '@iss/scenarios';
import { staticRuleAnalysis, bindingAnalysis } from '@iss/validation';
import { api, ApiFailure, type ProjectSummary, type SessionInfo } from '../api/client';

/**
 * Central studio store: one canonical project model, one typed command bus, shared view context.
 * Every view (2D, spatial, outputs, journey, assistant) reads the same project + context and derives
 * its projection from the same pure resolver. Screens never hold their own copies of rules/content.
 */

export interface HistoryEntry { project: Project; label: string }
export interface Toast { id: number; kind: 'info' | 'error' | 'warning' | 'success'; title: string; message?: string }

export interface StudioContext {
  recordId: string;
  overrides: Record<string, unknown>;
  journeyCursor: number | null;
  profileId: ProfileId;
  selectedNodeId: string | null;
  selectedVariantId: string | null;
  activeValidationIssue: string | null;
  cubeAxes: [DimensionId, DimensionId, DimensionId];
  spatialFilters: Partial<Record<DimensionId, string>>;
  activeScenarioId: string | null;
}

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface StudioState {
  projects: ProjectSummary[];
  projectsStatus: LoadStatus;
  projectsError: string | null;
  project: Project | null;
  projectStatus: LoadStatus;
  projectError: string | null;
  serverVersion: number;
  savedDigest: string;
  saving: boolean;
  past: HistoryEntry[];
  future: HistoryEntry[];
  records: SyntheticRecord[];
  recordsStatus: LoadStatus;
  personas: Persona[];
  ctx: StudioContext;
  toasts: Toast[];
  lastRejection: { code: string; message: string; nodeId?: string; at: number } | null;
  reducedMotion: boolean;
  /** Presentation density: business hides engine internals (hashes, IDs, raw expressions) behind "Proof" disclosures. */
  viewMode: ViewMode;
  theme: Theme;
  /** Last full server validation report, keyed by the run it validated (shared with the status dock). */
  lastValidation: { runId: string; counts: Record<string, number> } | null;

  loadProjects(): Promise<void>;
  openProject(projectId: string): Promise<void>;
  dispatch(cmd: Command): { ok: true; label: string } | { ok: false; code: string; message: string; nodeId?: string };
  undo(): void;
  redo(): void;
  save(): Promise<boolean>;
  resetProject(): Promise<void>;
  /** Re-fetch records for the open project (after an import or removal). */
  refreshRecords(): Promise<void>;
  setRecord(recordId: string): void;
  setOverrides(overrides: Record<string, unknown>): void;
  patchOverrides(patch: Record<string, unknown>): void;
  clearOverrides(): void;
  setJourneyCursor(cursor: number | null): void;
  setProfile(profileId: ProfileId): void;
  select(nodeId: string | null, variantId?: string | null): void;
  setCtx(patch: Partial<StudioContext>): void;
  toast(t: Omit<Toast, 'id'>): void;
  dismissToast(id: number): void;
  setReducedMotion(v: boolean): void;
  setViewMode(v: ViewMode): void;
  setTheme(v: Theme): void;
  setLastValidation(v: { runId: string; counts: Record<string, number> } | null): void;

  /* Collaboration (additive): who is signed in (auth is off by default → built-in local admin). */
  session: SessionInfo | null;
  sessionStatus: LoadStatus;
  loadSession(): Promise<SessionInfo | null>;
  signOut(): Promise<void>;
  /** Adopt a project version the server just stored (e.g. after restoring an older version). Clears undo history. */
  replaceProject(project: Project): void;
  /** Throw away unsaved edits by reloading the saved model from the server. */
  discardChanges(): Promise<void>;
}

/** Why the signed-in user may not change the model (null when they may). Auth off → never blocked. */
export function editBlockedReason(session: SessionInfo | null): string | null {
  if (!session?.authEnabled || !session.user) return null;
  if (roleCan(session.user.role, 'edit')) return null;
  return session.user.role === 'reviewer' ? 'Reviewers can comment but not edit' : `${ROLE_LABEL[session.user.role]}s can review but not edit`;
}

export type ViewMode = 'business' | 'technical';
export type Theme = 'light' | 'dark';
function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const v = localStorage.getItem(key) as T | null; return v && allowed.includes(v) ? v : fallback; } catch { return fallback; }
}
function writePref(key: string, v: string) { try { localStorage.setItem(key, v); } catch { /* storage unavailable */ } }
function applyDocAttrs(viewMode: ViewMode, theme: Theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.view = viewMode;
  document.documentElement.dataset.theme = theme;
}
const initialViewMode = typeof window === 'undefined' ? 'business' : readPref<ViewMode>('iss.viewMode', ['business', 'technical'], 'business');
const initialTheme = typeof window === 'undefined' ? 'light' : readPref<Theme>('iss.theme', ['light', 'dark'], 'light');
applyDocAttrs(initialViewMode, initialTheme);

const HISTORY_LIMIT = 50;
let toastSeq = 0;

function defaultCtx(project: Project): StudioContext {
  return {
    recordId: project.documentType === 'eob' ? 'EOB-0001' : 'CARD-0001',
    overrides: {},
    journeyCursor: null,
    profileId: 'paged-pdf',
    selectedNodeId: project.nodes.find((n) => n.type === 'variant-set')?.id ?? null,
    selectedVariantId: null,
    activeValidationIssue: null,
    cubeAxes: project.documentType === 'eob' ? ['claimStatus', 'output', 'journey'] : ['persona', 'output', 'journey'],
    spatialFilters: {},
    activeScenarioId: null,
  };
}

const ctxKey = (projectId: string) => `iss.ctx.${projectId}`;
function loadCtx(project: Project): StudioContext {
  const base = defaultCtx(project);
  try {
    const raw = localStorage.getItem(ctxKey(project.projectId));
    if (!raw) return base;
    const saved = JSON.parse(raw);
    const merged = { ...base, ...saved } as StudioContext;
    if (merged.selectedNodeId && !project.nodes.some((n) => n.id === merged.selectedNodeId)) merged.selectedNodeId = base.selectedNodeId;
    return merged;
  } catch { return base; }
}
function persistCtx(projectId: string, ctx: StudioContext) {
  try { localStorage.setItem(ctxKey(projectId), JSON.stringify(ctx)); } catch { /* storage unavailable */ }
}

export const useStudio = create<StudioState>((set, get) => ({
  projects: [], projectsStatus: 'idle', projectsError: null,
  project: null, projectStatus: 'idle', projectError: null,
  serverVersion: 0, savedDigest: '', saving: false,
  past: [], future: [],
  records: [], recordsStatus: 'idle', personas: [],
  ctx: { recordId: 'CARD-0001', overrides: {}, journeyCursor: null, profileId: 'paged-pdf', selectedNodeId: null, selectedVariantId: null, activeValidationIssue: null, cubeAxes: ['persona', 'output', 'journey'], spatialFilters: {}, activeScenarioId: null },
  toasts: [], lastRejection: null,
  reducedMotion: typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  viewMode: initialViewMode,
  theme: initialTheme,
  lastValidation: null,
  session: null,
  sessionStatus: 'idle',

  async loadSession() {
    if (get().sessionStatus === 'idle') set({ sessionStatus: 'loading' });
    try {
      const session = await api.session();
      set({ session, sessionStatus: 'ready' });
      return session;
    } catch {
      // API unreachable: screens show their own errors; behave as local mode.
      set({ sessionStatus: 'error' });
      return null;
    }
  },

  async signOut() {
    try { await api.logout(); } catch { /* already signed out */ }
    set({ session: get().session ? { ...get().session!, user: null, permissions: [] } : null, project: null, projectStatus: 'idle', projects: [], projectsStatus: 'idle', past: [], future: [] });
  },

  replaceProject(project) {
    const ctx = get().ctx;
    const selectedNodeId = ctx.selectedNodeId && project.nodes.some((n) => n.id === ctx.selectedNodeId) ? ctx.selectedNodeId : defaultCtx(project).selectedNodeId;
    set({ project, serverVersion: project.modelVersion, savedDigest: projectContentDigest(project), past: [], future: [], ctx: { ...ctx, selectedNodeId } });
    get().loadProjects();
  },

  async discardChanges() {
    const p = get().project;
    if (!p) return;
    const { project } = await api.project(p.projectId);
    get().replaceProject(project);
    get().toast({ kind: 'info', title: 'Unsaved changes discarded', message: `${project.title} · v${project.modelVersion}` });
  },

  async loadProjects() {
    set({ projectsStatus: 'loading', projectsError: null });
    try {
      const { projects } = await api.projects();
      set({ projects, projectsStatus: 'ready' });
    } catch (e: any) {
      set({ projectsStatus: 'error', projectsError: e.message });
    }
  },

  async openProject(projectId) {
    const cur = get().project;
    if (cur?.projectId === projectId && get().projectStatus === 'ready') return;
    set({ projectStatus: 'loading', projectError: null });
    try {
      const { project } = await api.project(projectId);
      const sameDocType = get().records[0]?.documentType === project.documentType;
      const [recs, personas] = await Promise.all([
        sameDocType ? Promise.resolve({ records: get().records }) : api.records(project.documentType),
        get().personas.length ? Promise.resolve({ personas: get().personas }) : api.personas(),
      ]);
      const ctx = loadCtx(project);
      if (!recs.records.some((r) => r.recordId === ctx.recordId)) ctx.recordId = defaultCtx(project).recordId;
      set({ project, projectStatus: 'ready', serverVersion: project.modelVersion, savedDigest: projectContentDigest(project), past: [], future: [], records: recs.records, recordsStatus: 'ready', personas: personas.personas, ctx });
    } catch (e: any) {
      set({ projectStatus: 'error', projectError: e instanceof ApiFailure ? `${e.code}: ${e.message}` : String(e.message ?? e) });
    }
  },

  dispatch(cmd) {
    const project = get().project;
    if (!project) return { ok: false, code: 'NO_PROJECT', message: 'No project is open.' };
    const blocked = editBlockedReason(get().session);
    if (blocked) {
      get().toast({ kind: 'warning', title: 'Read-only', message: `${blocked}.` });
      return { ok: false, code: 'FORBIDDEN', message: `${blocked}.` };
    }
    const res = applyCommand(project, cmd);
    if (!res.ok) {
      set({ lastRejection: { code: res.code, message: res.message, nodeId: res.nodeId, at: Date.now() } });
      get().toast({ kind: 'error', title: 'Change not applied', message: res.message });
      return res;
    }
    set((s) => ({ project: res.project, past: [...s.past, { project, label: res.label }].slice(-HISTORY_LIMIT), future: [] }));
    return { ok: true, label: res.label };
  },

  undo() {
    const { past, project } = get();
    if (!past.length || !project) return;
    if (editBlockedReason(get().session)) return;
    const prev = past[past.length - 1];
    const restored = { ...prev.project, modelVersion: project.modelVersion + 1 };
    set({ project: restored, past: past.slice(0, -1), future: [{ project, label: prev.label }, ...get().future].slice(0, HISTORY_LIMIT) });
    get().toast({ kind: 'info', title: 'Undone', message: prev.label });
  },

  redo() {
    const { future, project } = get();
    if (!future.length || !project) return;
    if (editBlockedReason(get().session)) return;
    const next = future[0];
    const restored = { ...next.project, modelVersion: project.modelVersion + 1 };
    set({ project: restored, future: future.slice(1), past: [...get().past, { project, label: next.label }].slice(-HISTORY_LIMIT) });
    get().toast({ kind: 'info', title: 'Redone', message: next.label });
  },

  async save() {
    const { project, serverVersion } = get();
    if (!project) return false;
    const blocked = editBlockedReason(get().session);
    if (blocked) { get().toast({ kind: 'warning', title: 'Read-only', message: `${blocked}.` }); return false; }
    set({ saving: true });
    try {
      const { project: saved } = await api.saveProject(project, serverVersion);
      set({ project: saved, serverVersion: saved.modelVersion, savedDigest: projectContentDigest(saved), saving: false });
      get().toast({ kind: 'success', title: 'Saved', message: `${saved.title} · model v${saved.modelVersion}` });
      get().loadProjects();
      return true;
    } catch (e: any) {
      set({ saving: false });
      get().toast({ kind: 'error', title: e.code === 'VERSION_CONFLICT' ? 'Save conflict' : 'Save failed', message: e.message });
      return false;
    }
  },

  async resetProject() {
    const { project } = get();
    if (!project) return;
    const blocked = editBlockedReason(get().session);
    if (blocked) { get().toast({ kind: 'warning', title: 'Read-only', message: `${blocked}.` }); return; }
    const { project: fresh } = await api.resetProject(project.projectId);
    try { localStorage.removeItem(ctxKey(project.projectId)); } catch { /* ignore */ }
    set({ project: fresh, serverVersion: fresh.modelVersion, savedDigest: projectContentDigest(fresh), past: [], future: [], ctx: defaultCtx(fresh) });
    get().toast({ kind: 'success', title: 'Approved sample restored', message: `${fresh.title} reset to the seeded fixture (v${fresh.modelVersion}).` });
    get().loadProjects();
  },

  async refreshRecords() {
    const project = get().project;
    if (!project) { set({ records: [] }); return; }
    const { records } = await api.records(project.documentType);
    const ctx = get().ctx;
    set({ records });
    if (!records.some((r) => r.recordId === ctx.recordId)) get().setCtx({ recordId: defaultCtx(project).recordId, overrides: {}, journeyCursor: null });
  },

  setRecord(recordId) { get().setCtx({ recordId, overrides: {}, journeyCursor: null }); },
  setOverrides(overrides) { get().setCtx({ overrides }); },
  patchOverrides(patch) {
    const merge = (a: any, b: any): any => { const o = { ...(a ?? {}) }; for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(o[k], v) : v; return o; };
    get().setCtx({ overrides: merge(get().ctx.overrides, patch) });
  },
  clearOverrides() { get().setCtx({ overrides: {} }); },
  setJourneyCursor(journeyCursor) { get().setCtx({ journeyCursor }); },
  setProfile(profileId) { get().setCtx({ profileId }); },
  select(nodeId, variantId = null) { get().setCtx({ selectedNodeId: nodeId, selectedVariantId: variantId }); },
  setCtx(patch) {
    const ctx = { ...get().ctx, ...patch };
    set({ ctx });
    const p = get().project;
    if (p) persistCtx(p.projectId, ctx);
  },
  toast(t) {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), t.kind === 'error' ? 6500 : 3500);
  },
  dismissToast(id) { set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })); },
  setReducedMotion(v) {
    document.documentElement.dataset.reducedMotion = String(v);
    set({ reducedMotion: v });
  },
  setViewMode(viewMode) { writePref('iss.viewMode', viewMode); applyDocAttrs(viewMode, get().theme); set({ viewMode }); },
  setTheme(theme) { writePref('iss.theme', theme); applyDocAttrs(get().viewMode, theme); set({ theme }); },
  setLastValidation(lastValidation) { set({ lastValidation }); },
}));

/* ----------------------------------------------------------- derived hooks */

/** Role-aware UI: may the signed-in user do this? Always true when auth is off (local admin). */
export function useCan(p: Permission): boolean {
  const session = useStudio((s) => s.session);
  if (!session?.authEnabled) return true;
  return roleCan(session.user?.role, p);
}

export function useIsDirty(): boolean {
  const project = useStudio((s) => s.project);
  const saved = useStudio((s) => s.savedDigest);
  return useMemo(() => (project ? projectContentDigest(project) !== saved : false), [project, saved]);
}

export function useRecord(recordId?: string): SyntheticRecord | undefined {
  const records = useStudio((s) => s.records);
  const id = useStudio((s) => recordId ?? s.ctx.recordId);
  return useMemo(() => records.find((r) => r.recordId === id), [records, id]);
}

/** The active resolved run for the shared context — the same pure resolver used by the API. */
export function useResolution(): Resolution | null {
  const project = useStudio((s) => s.project);
  const record = useRecord();
  const overrides = useStudio((s) => s.ctx.overrides);
  const journeyCursor = useStudio((s) => s.ctx.journeyCursor);
  const profileId = useStudio((s) => s.ctx.profileId);
  return useMemo(() => {
    if (!project || !record || record.documentType !== project.documentType) return null;
    return resolve({ project, record, overrides, journeyCursor, profileId });
  }, [project, record, overrides, journeyCursor, profileId]);
}

/**
 * Rule & binding checks for the open model, computed in the browser with the same functions the server's
 * "rules" and "bindings" validation suites use, so the status dock and Validate & Compare always agree.
 */
export function useModelChecks(): { blocking: number; errors: number; warnings: number } {
  const project = useStudio((s) => s.project);
  const records = useStudio((s) => s.records);
  const res = useResolution();
  const staticRules = useMemo(() => (project && records.length ? staticRuleAnalysis(project, records) : []), [project, records]);
  const staticBindings = useMemo(() => (project ? bindingAnalysis(project) : []), [project]);
  return useMemo(() => {
    // Mirrors the server's "rules" suite (resolver + domain + static) and de-duplicated "bindings" suite exactly.
    const rules = [...(res?.findings.filter((f) => f.source === 'resolver' || f.source === 'domain') ?? []), ...staticRules];
    const seen = new Set<string>();
    const bindings = [...(res?.findings.filter((f) => f.source === 'binding') ?? []), ...staticBindings].filter((f) => { const k = `${f.code}|${f.nodeId}|${f.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const all = [...rules, ...bindings];
    return { blocking: all.filter((f) => f.severity === 'blocking').length, errors: all.filter((f) => f.severity === 'error').length, warnings: all.filter((f) => f.severity === 'warning').length };
  }, [res, staticRules, staticBindings]);
}

/** Scenario engine over all seeded records of the project's document type (memoised per model). */
export function useScenarioEngine(): ScenarioEngine | null {
  const project = useStudio((s) => s.project);
  const records = useStudio((s) => s.records);
  return useMemo(() => (project && records.length ? new ScenarioEngine(project, records) : null), [project, records]);
}

/** Request body for API calls that must reflect the current (possibly unsaved) model. */
export function useScenarioRequest() {
  const project = useStudio((s) => s.project);
  const ctx = useStudio((s) => s.ctx);
  return useMemo(() => (project ? { projectId: project.projectId, recordId: ctx.recordId, overrides: ctx.overrides, journeyCursor: ctx.journeyCursor, project } : null), [project, ctx.recordId, ctx.overrides, ctx.journeyCursor]);
}

export function personaLabel(personas: Persona[], id?: string | null): string {
  const p = personas.find((x) => x.id === id);
  return p ? `${p.id} · ${p.name}` : id ?? '—';
}

// Re-check the session when any API call reports 401 (expired session with AUTH=on). Debounced.
if (typeof window !== 'undefined') {
  let pending = false;
  window.addEventListener('iss:unauthenticated', () => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; void useStudio.getState().loadSession(); }, 300);
  });
}
