import type { Permission, Persona, Project, ProjectDiff, Role, SyntheticRecord, WorkflowAction, WorkflowState } from '@iss/model';
import type { TestResult } from '@iss/scenarios';

/** Typed client for the local Spatial Studio API (/api/v1, proxied by Vite). */

export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string, public body?: any) { super(message); }
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    // Only declare a JSON body when one is sent: Fastify rejects an empty body with Content-Type: application/json (e.g. DELETE).
    res = await fetch(path, { ...init, headers: { ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) } });
  } catch (e) {
    throw new ApiFailure(0, 'NETWORK', 'The Spatial Studio API is not reachable. Start it with `pnpm dev`.');
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  // An expired/missing session (AUTH=on): let the store re-check who is signed in (it shows the login page).
  if (res.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('iss:unauthenticated'));
  if (!res.ok) throw new ApiFailure(res.status, body?.error?.code ?? 'HTTP_' + res.status, body?.error?.message ?? res.statusText, body);
  return body as T;
}

export interface ProjectSummary {
  projectId: string; title: string; documentType: 'credit-statement' | 'eob'; modelVersion: number; schemaVersion: string;
  issuer: Project['issuer']; contentDigest: string; modified: boolean; updatedAt: string; nodeCount: number; ruleCount: number;
  /** Approved seeded sample (restorable, not deletable) vs a user copy. */
  sample: boolean; derivedFrom: { projectId: string; modelVersion: number } | null; fromTemplate: { templateId: string; version: number; title: string } | null; importedFrom: { title: string; modelVersion: number } | null;
}

export interface TemplateVersionDto { version: number; savedAt: string; savedBy: { id: string; name: string } | null; note: string; from: { projectId: string; title: string; modelVersion: number }; counts: { components: number; rules: number; messages: number; languages: number; tests: number } }
/** `source: 'saved'` templates were published from a document; they have numbered, frozen versions (newest first). */
export interface TemplateInfoDto { id: string; title: string; documentType: 'credit-statement' | 'eob'; description: string; source?: 'builtin' | 'saved'; version?: number; versions?: TemplateVersionDto[]; retired?: boolean }
export interface ProjectImportReport { from: { projectId: string; title: string; modelVersion: number }; counts: TemplateVersionDto['counts']; warnings: string[]; notImported: string[] }

export interface ImportResult {
  documentType: 'credit-statement' | 'eob'; dryRun: boolean; total: number;
  imported: Array<{ recordId: string; sourceId: string | null; name: string }>;
  rejected: Array<{ row: number; sourceId: string | null; errors: string[] }>;
}

export interface ScenarioRequest {
  projectId: string;
  recordId: string;
  overrides?: Record<string, unknown>;
  journeyCursor?: number | null;
  outputContext?: { profileId?: 'paged-pdf' | 'paged-afp-sim' | 'html-responsive' };
  /** Current (possibly unsaved) model — the server validates it and records an immutable run. */
  project?: Project;
  allowDraft?: boolean;
  /** Previews only (with allowDraft): also show unapproved translation drafts; the result is watermarked. */
  includeDrafts?: boolean;
}

/** Common part of every model-backed assistant reply. */
export interface AssistReply { mode: 'ai' | 'unavailable'; providerStatus: string; message: string }

export interface ChannelParity { parity: { ok: boolean; checks: Array<{ id: string; label: string; status: 'match' | 'mismatch' | 'not-applicable'; blocking: boolean; expected?: unknown; email?: unknown; sms?: unknown; note?: string }> } }

export interface BinaryResult {
  blob: Blob;
  url: string;
  filename: string;
  runId: string;
  artifactId: string;
  pageCount?: number;
  pdfPageCount?: number;
  contentDigest: string;
  sha256: string;
  draft: boolean;
}

async function binary(path: string, body: ScenarioRequest): Promise<BinaryResult> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new ApiFailure(res.status, b?.error?.code ?? 'HTTP_' + res.status, b?.error?.message ?? res.statusText, b);
  }
  const blob = await res.blob();
  const disp = res.headers.get('Content-Disposition') ?? '';
  return {
    blob, url: URL.createObjectURL(blob), filename: /filename="([^"]+)"/.exec(disp)?.[1] ?? 'output',
    runId: res.headers.get('X-Run-Id') ?? '', artifactId: res.headers.get('X-Artifact-Id') ?? '',
    pageCount: res.headers.get('X-Page-Count') ? Number(res.headers.get('X-Page-Count')) : undefined,
    pdfPageCount: res.headers.get('X-Pdf-Page-Count') ? Number(res.headers.get('X-Pdf-Page-Count')) : undefined,
    contentDigest: res.headers.get('X-Content-Digest') ?? '', sha256: res.headers.get('X-Sha256') ?? '', draft: res.headers.get('X-Draft') === '1',
  };
}

export interface ComposedPages {
  runId: string; recordId: string; modelVersion: number; contentDigest: string; engine: string; pageCount: number; pdfPageCount: number | null; durationMs: number;
  pages: Array<{ index: number; nodeIds: string[]; fixedNodeIds: string[]; tables: Record<string, { rows: number; firstRowId: string | null; lastRowId: string | null; continued: boolean; headerRepeated: boolean }>; flowTopPt: number; flowBottomPt: number; usedPt: number }>;
  diagnostics: Array<{ code: string; severity: string; nodeId?: string; page?: number; message: string; rowsPlaced?: number; rowsClipped?: number }>;
  snapshot: { css: string; pages: string[] };
  extracted: any;
  findings: any[];
  transactionCount: number | null;
}

export type BatchStatus = 'running' | 'done' | 'failed' | 'cancelled';
export interface BatchItemDto {
  recordId: string; name: string; status: 'pending' | 'ok' | 'draft' | 'blocked' | 'failed';
  pages: number | null; pdfBytes: number | null; htmlBytes: number | null; ms: number | null;
  blocking: string[]; warnings: number; selectedVariants: Record<string, string | null>; error?: string; runId?: string;
}
export interface BatchDto {
  batchId: string; projectId: string; projectTitle: string; modelVersion: number; outputs: Array<'pdf' | 'html'>; includeBlocked: boolean;
  status: BatchStatus; total: number; done: number; items: BatchItemDto[];
  startedAt: string; finishedAt: string | null; durationMs: number | null; zipBytes: number | null; zipSha256: string | null; error?: string;
}
export interface AssetDto { assetId: string; name: string; mime: string; size: number; sha256: string; width: number | null; height: number | null; createdAt: string }


/* ----------------------------------------------------------- collaboration (versions, review, comments, audit, users) */

export interface SessionUser { id: string; name: string; email: string | null; role: Role; local?: boolean; disabled?: boolean; createdAt?: string; updatedAt?: string }
export interface SessionInfo { authEnabled: boolean; user: SessionUser | null; permissions: Permission[]; roles?: Role[]; expiresAt: string | null }
export interface WorkflowStep { action: string; from: WorkflowState; to: WorkflowState; user: string | null; at: string }
export interface VersionDto { modelVersion: number; contentDigest: string; savedAt: string; savedBy: string | null; label: string | null; bytes: number; current: boolean; workflow: WorkflowStep[] }
export interface VersionMeta { modelVersion: number; contentDigest: string; savedAt: string; savedBy: string | null; label: string | null; title: string }
export interface BlockingGroup { code: string; severity: string; nodeId: string | null; locale: string | null; message: string; source: string; recordIds: string[] }
export interface Readiness { ready: boolean; modelVersion: number; recordsChecked: number; blocking: BlockingGroup[]; tests: TestResult[]; testsRun: number; testsFailed: number }
export interface WorkflowEventDto { id: number; action: string; from: WorkflowState; to: WorkflowState; comment: string | null; user: string | null; userId: string | null; at: string; modelVersion: number }
export interface WorkflowDto {
  projectId: string; modelVersion: number; state: WorkflowState; label: string; stateVersion: number | null; updatedAt: string | null; updatedBy: string | null;
  actions: Array<{ action: WorkflowAction; label: string; to: WorkflowState; available: boolean; allowed: boolean; reason: string | null }>;
  history: WorkflowEventDto[]; readiness: Readiness | null;
}
export interface CommentDto { id: string; projectId: string; nodeId: string; parentId: string | null; body: string; author: string; authorName: string; createdAt: string; resolvedAt: string | null; resolvedBy: string | null; modelVersion: number; mine: boolean }
export interface AuditEventDto { id: number; at: string; user: string | null; userName: string | null; action: string; projectId: string | null; modelVersion: number | null; detail: Record<string, any> }
export interface AuditQuery { projectId?: string; user?: string; action?: string; since?: string; before?: number; limit?: number }

const qs = (q: Record<string, unknown>) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v)); const s = u.toString(); return s ? `?${s}` : ''; };

export const api = {
  health: () => json<{ status: string; ai: { mode: 'external' | 'offline'; label: string; model?: string } }>('/api/v1/health'),
  projects: () => json<{ projects: ProjectSummary[] }>('/api/v1/projects'),
  project: (id: string) => json<{ project: Project }>(`/api/v1/projects/${id}`),
  saveProject: (project: Project, ifMatch: number) => json<{ project: Project; saved: boolean; contentDigest: string }>(`/api/v1/projects/${project.projectId}`, { method: 'PUT', body: JSON.stringify({ project }), headers: { 'If-Match': `"${ifMatch}"` } }),
  resetProject: (id: string) => json<{ project: Project; reset: boolean; seedDigest: string }>(`/api/v1/projects/${id}/reset`, { method: 'POST', body: JSON.stringify({ confirm: true }) }),
  duplicateProject: (id: string, title: string) => json<{ project: Project }>(`/api/v1/projects/${id}/duplicate`, { method: 'POST', body: JSON.stringify({ title }) }),
  renameProject: (id: string, title: string) => json<{ project: Project }>(`/api/v1/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  /** Built-in starters, then saved templates. `canSave` = this user may save a document as a template (approvers and admins). */
  templates: (includeRetired = false) => json<{ templates: TemplateInfoDto[]; canSave: boolean }>(`/api/v1/templates${includeRetired ? '?includeRetired=true' : ''}`),
  /** Saves the document's LAST SAVED version as a template. With `templateId` it adds the next version to that saved template. Errors: 403, 409 TEMPLATE_NAME_TAKEN, 400 DOCUMENT_TYPE_MISMATCH. */
  saveTemplate: (body: { projectId: string; title?: string; description?: string; note?: string; templateId?: string }) => json<{ template: TemplateInfoDto; version: number; created: boolean }>('/api/v1/templates', { method: 'POST', body: JSON.stringify(body) }),
  setTemplateRetired: (templateId: string, retired: boolean) => json<{ template: TemplateInfoDto }>(`/api/v1/templates/${templateId}`, { method: 'PATCH', body: JSON.stringify({ retired }) }),
  /** Checks a studio project file and (unless `dryRun`) stores it as a NEW draft document. A 422 failure is an `ApiFailure` whose `body.error.problems` is `[{ code, message }]`. */
  importProject: (file: unknown, opts: { title?: string; dryRun?: boolean } = {}) => json<{ project?: Project; dryRun?: boolean; wouldCreate?: { projectId: string; title: string }; report: ProjectImportReport }>('/api/v1/projects/import', { method: 'POST', body: JSON.stringify({ file, ...opts }) }),
  templateProject: (templateId: string, documentType?: string, version?: number) => json<{ template: TemplateInfoDto; project: Project; version?: number }>(`/api/v1/templates/${templateId}/project?${new URLSearchParams({ ...(documentType ? { documentType } : {}), ...(version ? { version: String(version) } : {}) })}`),
  createProject: (body: { templateId: string; title: string; documentType?: string; templateVersion?: number }) => json<{ project: Project; createdFrom: string; templateVersion: number | null }>('/api/v1/projects', { method: 'POST', body: JSON.stringify(body) }),
  deleteProject: (id: string) => json<{ deleted: boolean }>(`/api/v1/projects/${id}`, { method: 'DELETE' }),
  importRecords: (body: { documentType: string; format: 'json' | 'csv'; data: string; dryRun?: boolean; projectId?: string }) => json<ImportResult>('/api/v1/records/import', { method: 'POST', body: JSON.stringify(body) }),
  clearImportedRecords: (documentType?: string) => json<{ removed: number }>(`/api/v1/records/imported${documentType ? `?documentType=${documentType}` : ''}`, { method: 'DELETE' }),
  /** Tell the activity log that a person applied an assistant proposal (label and counts only). Never blocks the UI. */
  assistApplied: (body: { projectId: string; feature: string; label: string; source: 'builtin' | 'ai'; changes?: number; modelVersion?: number }) => json<{ recorded: boolean }>('/api/v1/assist/applied', { method: 'POST', body: JSON.stringify(body) }).catch(() => ({ recorded: false })),
  /* Model-backed assistant suggestions. Each answers `mode: 'ai'` with suggestions or `mode: 'unavailable'` with an explanation (no AI key, or nothing usable). Nothing is saved. */
  assistRewrite: (id: string, body: { text: string; style: 'shorter' | 'plainer' | 'warmer' | 'formal' | 'one-sms'; kind: 'message' | 'label' | 'email' | 'sms'; locale?: string; project?: Project }) => json<AssistReply & { options: Array<{ text: string; tokenCheck: { ok: boolean; missing: string[]; extra: string[] } }> }>(`/api/v1/projects/${id}/assist/rewrite`, { method: 'POST', body: JSON.stringify(body) }),
  assistNewVersion: (id: string, body: { nodeId: string; brief: string; project?: Project }) => json<AssistReply & { title?: string; text?: string }>(`/api/v1/projects/${id}/assist/new-version`, { method: 'POST', body: JSON.stringify(body) }),
  assistSubjectLines: (id: string, body: { current: string; brief?: string; project?: Project }) => json<AssistReply & { options: Array<{ text: string }> }>(`/api/v1/projects/${id}/assist/subject-lines`, { method: 'POST', body: JSON.stringify(body) }),
  assistTranslationMeaning: (id: string, body: { locale: string; ids?: string[]; project?: Project }) => json<AssistReply & { flags: Array<{ textId: string; message: string }>; checked: number }>(`/api/v1/projects/${id}/assist/translation-meaning`, { method: 'POST', body: JSON.stringify(body) }),
  /** "Describe the rule": a draft rule from a sentence. Plain sentences work without a model (`mode: 'builtin'`). Nothing is saved. */
  assistRuleDraft: (id: string, body: { sentence: string; project?: Project }) => json<{ mode: 'builtin' | 'ai'; providerStatus: string; message: string; draft: import('@iss/scenarios').RuleDraft }>(`/api/v1/projects/${id}/assist/rule-draft`, { method: 'POST', body: JSON.stringify(body) }),
  assistImageDescription: (id: string, body: { nodeId: string; project?: Project }) => json<AssistReply & { text?: string }>(`/api/v1/projects/${id}/assist/image-description`, { method: 'POST', body: JSON.stringify(body) }),
  /** First-pass translation drafts: AI when a key is configured, bundled sample drafts for the sample projects otherwise. Nothing is saved or approved. */
  translate: (id: string, body: { locale: string; ids?: string[]; project?: Project; forceOffline?: boolean }) => json<{ mode: 'ai' | 'sample' | 'unavailable'; locale: string; providerStatus: string; drafts: Array<{ id: string; text: string; tokenCheck: { ok: boolean; missing: string[]; extra: string[] } }>; skipped: Array<{ id: string; reason: string }>; message: string }>(`/api/v1/projects/${id}/translate`, { method: 'POST', body: JSON.stringify(body) }),
  translationsCsvUrl: (id: string, locale: string) => `/api/v1/projects/${id}/translations.csv?locale=${encodeURIComponent(locale)}`,
  importTranslations: (id: string, body: { locale: string; csv: string; project?: Project }) => json<{ locale: string; drafts: Array<{ partId: string; text: string }>; errors: Array<{ row: number; partId: string; code: string; message: string }>; skipped: number; rows: number }>(`/api/v1/projects/${id}/translations/import`, { method: 'POST', body: JSON.stringify(body) }),
  schemas: (id: string) => json<{ fields: any[]; dimensions: any[]; edgeCasePresets: Array<{ id: string; label: string; description: string }> }>(`/api/v1/projects/${id}/schemas`),
  /** Customers for one kind of document. With a project id, also that project's own customers (generated test customers have `generated.label`). */
  records: (documentType: string, projectId?: string) => json<{ records: SyntheticRecord[]; seed: string }>(`/api/v1/records?documentType=${documentType}&full=1${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`),
  personas: () => json<{ personas: Persona[] }>('/api/v1/personas'),
  resolve: (req: ScenarioRequest) => json<any>('/api/v1/resolve', { method: 'POST', body: JSON.stringify(req) }),
  composePdf: (req: ScenarioRequest) => binary('/api/v1/compose/pdf', req),
  composeHtml: (req: ScenarioRequest) => binary('/api/v1/compose/html', req),
  composeEmail: (req: ScenarioRequest) => json<ChannelParity & { runId: string; recordId: string; locale: string; subject: string; preheader: string; html: string; text: string; warnings: string[]; artifactId: string; sha256: string; filename: string }>('/api/v1/compose/email', { method: 'POST', body: JSON.stringify(req) }),
  composeSms: (req: ScenarioRequest) => json<ChannelParity & { runId: string; recordId: string; locale: string; text: string; encoding: 'GSM-7' | 'UCS-2'; length: number; segments: number; perSegment: number; nonGsm: Array<{ char: string; index: number; codePoint: string }>; warnings: string[] }>('/api/v1/compose/sms', { method: 'POST', body: JSON.stringify(req) }),
  composePages: (req: ScenarioRequest & { verifyPdf?: boolean }) => json<ComposedPages>('/api/v1/compose/pages', { method: 'POST', body: JSON.stringify(req) }),
  afpSim: (req: ScenarioRequest) => json<any>('/api/v1/compose/afp-sim', { method: 'POST', body: JSON.stringify(req) }),
  parity: (req: ScenarioRequest) => json<any>('/api/v1/parity', { method: 'POST', body: JSON.stringify(req) }),
  validate: (req: ScenarioRequest & { suites?: string[] }) => json<any>('/api/v1/validate', { method: 'POST', body: JSON.stringify(req) }),
  replayJourney: (req: { projectId: string; recordId: string; overrides?: Record<string, unknown>; project?: Project; journeyCursor?: number | null }) => json<any>('/api/v1/journeys/replay', { method: 'POST', body: JSON.stringify(req) }),
  snapshots: (projectId: string, recordId?: string) => json<{ snapshots: any[] }>(`/api/v1/snapshots?projectId=${projectId}${recordId ? `&recordId=${recordId}` : ''}`),
  resetSnapshots: (projectId: string) => json<{ cleared: boolean }>('/api/v1/snapshots/reset', { method: 'POST', body: JSON.stringify({ projectId, confirm: true }) }),
  generateEdgeCase: (recordId: string, preset: string, seed?: string) => json<{ overrides: Record<string, unknown>; description: string; scenarioHash: string; seed: string; presetId: string }>('/api/v1/scenarios/generate', { method: 'POST', body: JSON.stringify({ recordId, preset, seed }) }),
  artifacts: (q: { runId?: string; projectId?: string }) => json<{ artifacts: any[] }>(`/api/v1/artifacts?${new URLSearchParams(q as any)}`),
  artifactUrl: (id: string, inline = false) => `/api/v1/artifacts/${id}${inline ? '?inline=1' : ''}`,
  assistantStatus: () => json<{ mode: 'external' | 'offline'; label: string; model?: string }>('/api/v1/assistant/status'),
  assistantMessage: (body: { message: string; context: any; project?: Project; forceOffline?: boolean }) => json<any>('/api/v1/assistant/message', { method: 'POST', body: JSON.stringify(body) }),
  decideProposal: (id: string, approved: boolean, modelVersion: number) => json<any>(`/api/v1/assistant/proposals/${id}/decision`, { method: 'POST', body: JSON.stringify({ approved, modelVersion }) }),
  startBatch: (body: { projectId: string; project?: Project; recordIds?: string[]; outputs: Array<'pdf' | 'html'>; includeBlocked?: boolean }) => json<{ batch: BatchDto }>('/api/v1/batches', { method: 'POST', body: JSON.stringify(body) }),
  batch: (id: string) => json<{ batch: BatchDto }>(`/api/v1/batches/${id}`),
  cancelBatch: (id: string) => json<{ batch: BatchDto }>(`/api/v1/batches/${id}/cancel`, { method: 'POST', body: '{}' }),
  batches: () => json<{ batches: Array<Omit<BatchDto, 'items'>> }>('/api/v1/batches'),
  batchZipUrl: (id: string) => `/api/v1/batches/${id}/zip`,
  assets: () => json<{ assets: AssetDto[]; maxBytes: number; types: string[] }>('/api/v1/assets'),
  uploadAsset: (name: string, dataUri: string) => json<{ asset: AssetDto; dataUri: string }>('/api/v1/assets', { method: 'POST', body: JSON.stringify({ name, dataUri }) }),
  asset: (id: string) => json<{ asset: AssetDto; dataUri: string }>(`/api/v1/assets/${id}`),
  assetRawUrl: (id: string) => `/api/v1/assets/${id}/raw`,
  deleteAsset: (id: string) => json<{ deleted: boolean; note?: string }>(`/api/v1/assets/${id}`, { method: 'DELETE', body: '{}' }),
  // Collaboration: session, version history, review workflow, comments, audit, users.
  session: () => json<SessionInfo>('/api/v1/session'),
  login: (email: string, password: string) => json<SessionInfo>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => json<{ signedOut: boolean }>('/api/v1/auth/logout', { method: 'POST', body: '{}' }),
  versions: (id: string) => json<{ projectId: string; currentVersion: number; versions: VersionDto[] }>(`/api/v1/projects/${id}/versions`),
  version: (id: string, v: number) => json<{ modelVersion: number; contentDigest: string; savedAt: string; savedBy: string | null; label: string | null; project: Project }>(`/api/v1/projects/${id}/versions/${v}`),
  versionDiff: (id: string, a: number, b: number) => json<{ from: VersionMeta; to: VersionMeta; diff: ProjectDiff }>(`/api/v1/projects/${id}/versions/${a}/diff/${b}`),
  restoreVersion: (id: string, v: number, ifMatch: number) => json<{ project: Project; restored: boolean; restoredVersion: number; workflow: { state: WorkflowState } }>(`/api/v1/projects/${id}/versions/${v}/restore`, { method: 'POST', body: JSON.stringify({ confirm: true }), headers: { 'If-Match': `"${ifMatch}"` } }),
  workflow: (id: string, checks = true) => json<WorkflowDto>(`/api/v1/projects/${id}/workflow${checks ? '' : '?checks=0'}`),
  workflowAction: (id: string, action: WorkflowAction, comment?: string) => json<WorkflowDto>(`/api/v1/projects/${id}/workflow`, { method: 'POST', body: JSON.stringify({ action, ...(comment ? { comment } : {}) }) }),
  comments: (id: string, q: { nodeId?: string; status?: 'open' | 'resolved' | 'all' } = {}) => json<{ comments: CommentDto[]; counts: { open: number; resolved: number } }>(`/api/v1/projects/${id}/comments${qs(q)}`),
  addComment: (id: string, body: { nodeId?: string; parentId?: string; body: string }) => json<{ comment: CommentDto }>(`/api/v1/projects/${id}/comments`, { method: 'POST', body: JSON.stringify(body) }),
  resolveComment: (id: string, commentId: string, resolved: boolean) => json<{ comment: CommentDto }>(`/api/v1/projects/${id}/comments/${commentId}/resolve`, { method: 'POST', body: JSON.stringify({ resolved }) }),
  deleteComment: (id: string, commentId: string) => json<{ deleted: boolean; removed: number }>(`/api/v1/projects/${id}/comments/${commentId}`, { method: 'DELETE' }),
  audit: (q: AuditQuery = {}) => json<{ events: AuditEventDto[]; nextBefore: number | null; actors: Array<{ id: string; name: string; count: number }>; authEnabled: boolean }>(`/api/v1/audit${qs(q as Record<string, unknown>)}`),
  users: () => json<{ users: SessionUser[]; roles: Role[]; authEnabled: boolean }>('/api/v1/users'),
  createUser: (body: { email: string; name: string; role: Role; password: string }) => json<{ user: SessionUser }>('/api/v1/users', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (userId: string, patch: { name?: string; role?: Role; disabled?: boolean; password?: string }) => json<{ user: SessionUser }>(`/api/v1/users/${userId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
};
