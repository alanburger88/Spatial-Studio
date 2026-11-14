import type { LibraryContent, LibraryItemInfo, LibraryKind, LibraryUsage, LibraryVersionInfo, SetupSpec, DocumentType, HandoverEntry, HandoverKind, Permission, Persona, Project, ProjectDiff, ReleaseEvent, ReleaseInfo, ReleasePackageStatus, ReleaseStage, Role, RuntimePackageStatus, SyntheticRecord, WorkflowAction, WorkflowState } from '@iss/model';
import type { DuplicateKind, DuplicateScan, FileSample, NotBroughtItem, RowMatch, SampleAlignment, SetupOutline, TestResult, VersionComparison } from '@iss/scenarios';

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
  projectId: string; title: string; documentType: DocumentType; modelVersion: number; schemaVersion: string;
  issuer: Project['issuer']; contentDigest: string; modified: boolean; updatedAt: string; nodeCount: number; ruleCount: number;
  /** Approved seeded sample (restorable, not deletable) vs a user copy. */
  sample: boolean; derivedFrom: { projectId: string; modelVersion: number } | null; fromTemplate: { templateId: string; version: number; title: string } | null; importedFrom: { title: string; modelVersion: number } | null;
}

export interface TemplateVersionDto { version: number; savedAt: string; savedBy: { id: string; name: string } | null; note: string; from: { projectId: string; title: string; modelVersion: number }; counts: { components: number; rules: number; messages: number; languages: number; tests: number } }
/** `source: 'saved'` templates were published from a document; they have numbered, frozen versions (newest first). */
export interface TemplateInfoDto { id: string; title: string; documentType: DocumentType; description: string; source?: 'builtin' | 'saved'; version?: number; versions?: TemplateVersionDto[]; retired?: boolean }
/** One thing the generated customers should exercise. `recordId` is the generated customer that does (null = nothing reaches it; `reason` says why). */
export interface TestDataTargetDto { id: string; kind: 'rule' | 'variant' | 'section-shown' | 'section-hidden' | 'language' | 'edge' | 'empty'; targetId: string; title: string; customer: number | null; recordId: string | null; reason?: string; observed?: string }
export interface TestDataResult {
  summary: { outcomes: { total: number; reached: number }; edges: { total: number; reached: number }; unreachable: number; capped: boolean } | null;
  targets: TestDataTargetDto[];
  customers: Array<{ recordId: string | null; name: string; label: string; locale: string; targets: number; /** The document's date this customer reaches its outcomes on (documents whose date is given for each run). */ issueDate?: string }>;
}
/** One value that does not fit the data fields. `path` is the field it is about (for example `card.dueDate` or `card.transactions[2].amountCents`), when known. */
export interface RecordProblem { path: string | null; message: string }
/** What the document does for a customer as issued. */
export interface RecordOutcome { messages: Array<{ nodeId: string; node: string; variantId: string | null; variant: string | null }>; blocking: Array<{ code: string; message: string }> }
/** What removing a project's generated or supplied customers answers. A `custom` project also says how many customers it has left, and which one was created to keep it previewable. */
export interface RemovalResult { removed: number; remaining?: number; kept?: { recordId: string; name: string; label: string } | null; note?: string }
export interface ProjectImportReport { from: { projectId: string; title: string; modelVersion: number }; counts: TemplateVersionDto['counts']; warnings: string[]; notImported: string[] }

export interface ImportResult {
  documentType: DocumentType; dryRun: boolean; total: number;
  /** Set when the rows are (or would be) stored as the project's own customers. */
  projectId?: string; scope?: 'project';
  imported: Array<{ recordId: string; sourceId: string | null; name: string }>;
  rejected: Array<{ row: number; sourceId: string | null; errors: string[] }>;
}

/** Sample data a person supplied for a new document: the text of a CSV or JSON file. */
export interface SetupSampleData { format: 'csv' | 'json'; data: string }
/** What the supplied rows would become as the new document's own customers. `rejected` lists the first rejected rows with why. */
export interface SetupSuppliedSummary { total: number; accepted: number; rejectedCount: number; rejected: Array<{ row: number; reasons: string[] }>; matching: RowMatch[]; notes: string[] }
export interface SetupPreview { customer: { name: string; origin: 'supplied' | 'generated' }; messages: Array<{ section: string; version: string | null }>; blocking: Array<{ code: string; message: string }> }
/** A proposed document setup. Nothing is stored until it is approved with `createSetup`. */
export interface SetupProposal {
  mode: 'proposal'; source: 'ai' | 'builtin'; providerStatus: string; message: string;
  wouldCreate: { projectId: string; title: string };
  spec: SetupSpec; project: Project; notes: string[]; outline: SetupOutline;
  customers: { generated: { count: number }; supplied: SetupSuppliedSummary | null };
  preview: SetupPreview;
}
/** `unavailable` is a normal answer (for example a description with no AI key): nothing was drafted. */
export type SetupDraftResult = SetupProposal | { mode: 'unavailable'; providerStatus: string; message: string; notes: string[] };
export interface SetupDraftBody { description?: string; sampleData?: SetupSampleData; title?: string; issuerName?: string; accent?: string; spec?: SetupSpec; source?: 'ai' | 'builtin' }
export interface SetupCreateBody { spec: SetupSpec; title: string; issuerName?: string; accent?: string; customers: 'generate' | 'supplied' | 'both'; sampleData?: SetupSampleData; source: 'ai' | 'builtin'; /** Set up from an existing PDF or Word file ("Rebuild from a file"). */ origin?: 'file' }
/** Rebuild from a file: one to three files as base64, never their names. */
export interface RebuildFile { data: string }
export interface RebuildReading { samples: FileSample[]; alignment: SampleAlignment | null; outline: { placeholders: string; asIs: string }; ai: { live: boolean; providerStatus: string } }
export interface RebuildProposeBody { files: RebuildFile[]; useAi: boolean; placeholders?: boolean; confirmNoCustomerData?: boolean; outline?: string; unmarked?: string[]; title?: string; issuerName?: string }
/** A checked setup proposed from the files (shown through the ordinary setup review), or a plain state: no AI key, or a model answer that failed the checks. */
export type RebuildProposal =
  | { mode: 'proposal'; source: 'ai' | 'builtin'; providerStatus: string; message: string; spec: SetupSpec; notes: string[]; report: NotBroughtItem[] }
  | { mode: 'unavailable'; reason: 'no-key' | 'failed'; providerStatus: string; message: string; notes: string[] };
export interface SetupCreated { project: Project; source: 'ai' | 'builtin'; notes: string[]; customers: { total: number; generated: number; supplied: SetupSuppliedSummary | null; startingCustomerOnly: boolean }; preview: SetupPreview }

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
  /** "As issued on": the document's date for this preview or run (documents that use dates; an ISO day). Part of the run ID. */
  issueDate?: string;
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
  /** "As issued on" for the whole batch, when one was given. */
  issueDate?: string;
}
export interface AssetDto { assetId: string; name: string; mime: string; size: number; sha256: string; width: number | null; height: number | null; createdAt: string }


/* ----------------------------------------------------------- collaboration (versions, review, comments, audit, users) */

export interface SessionUser { id: string; name: string; email: string | null; role: Role; local?: boolean; disabled?: boolean; createdAt?: string; updatedAt?: string }
export interface SessionInfo { authEnabled: boolean; user: SessionUser | null; permissions: Permission[]; roles?: Role[]; expiresAt: string | null }
export interface WorkflowStep { action: string; from: WorkflowState; to: WorkflowState; user: string | null; at: string }
export interface VersionDto { modelVersion: number; contentDigest: string; savedAt: string; savedBy: string | null; label: string | null; bytes: number; current: boolean; workflow: WorkflowStep[] }
export interface VersionMeta { modelVersion: number; contentDigest: string; savedAt: string; savedBy: string | null; label: string | null; title: string }
export interface BlockingGroup { code: string; severity: string; nodeId: string | null; locale: string | null; message: string; source: string; recordIds: string[]; /** Wording rules: which rule and text (`check`), for the link to Blockers. */ details?: Record<string, unknown> }
/** A customer-data blocker an approver set aside for one customer (docs/api/KNOWN_DATA_PROBLEMS.md). */
export interface KnownDataProblemDto {
  id: string; blockerId: string; recordId: string; reason: string; markedBy: { id: string | null; name: string } | null; markedAt: string;
  blocker: { title: string; kind: string; fields: string[] }; customer: { name: string; origin: 'sample' | 'generated' | 'supplied' | 'imported' };
}
/** `note` says, in plain words, when entries lapsed (the problem no longer stops that customer) and were removed by this request. */
export interface KnownDataAnswer { lapsed: Array<{ id: string; blockerId: string; recordId: string }>; note: string | null }
export interface Readiness { ready: boolean; modelVersion: number; recordsChecked: number; blocking: BlockingGroup[]; tests: TestResult[]; testsRun: number; testsFailed: number; knownDataProblems?: KnownDataProblemDto[]; knownDataNote?: string | null }
export interface WorkflowEventDto { id: number; action: string; from: WorkflowState; to: WorkflowState; comment: string | null; user: string | null; userId: string | null; at: string; modelVersion: number }
export interface WorkflowDto {
  projectId: string; modelVersion: number; state: WorkflowState; label: string; stateVersion: number | null; updatedAt: string | null; updatedBy: string | null;
  actions: Array<{ action: WorkflowAction; label: string; to: WorkflowState; available: boolean; allowed: boolean; reason: string | null }>;
  history: WorkflowEventDto[]; readiness: Readiness | null;
}
export interface CommentDto { id: string; projectId: string; nodeId: string; parentId: string | null; body: string; author: string; authorName: string; createdAt: string; resolvedAt: string | null; resolvedBy: string | null; modelVersion: number; mine: boolean }
export interface AuditEventDto { id: number; at: string; user: string | null; userName: string | null; action: string; projectId: string | null; modelVersion: number | null; detail: Record<string, any> }
export interface AuditQuery { projectId?: string; user?: string; action?: string; since?: string; before?: number; limit?: number }


/* ----------------------------------------------------------- releases (docs/api/RELEASES.md) */

/** One document's releases, newest first. `create` says whether the caller may make a release from the approved version now, and if not why. */
export interface ProjectReleasesDto { documentId: string; documentExists: boolean; title: string; releases: ReleaseInfo[]; production: string | null; test: string | null; create: { allowed: boolean; reason: string | null } }
export interface ReleaseActionDto { action: 'promote' | 'withdraw' | 'handover'; stage?: ReleaseStage; kind?: HandoverKind; label: string; allowed: boolean; reason: string | null }
export interface ReleaseDetailDto { release: ReleaseInfo; history: ReleaseEvent[]; handover: HandoverEntry[]; actions: ReleaseActionDto[]; document: { id: string; exists: boolean; title: string | null; modelVersion: number | null; workflowState: WorkflowState | null };
  /** Mappings to production systems (wave 3): the ones the release carries (complete when it was made) and the ones it left out. Absent from older servers. */
  mappings?: Array<{ id: string; name: string; system: string; complete: boolean; file: string | null; csv: string | null; counts: { required: number; mapped: number; notNeeded: number; unmapped: number; clashes: number; mappedTwice: number } }> }
export interface ReleaseCreateResult { created: boolean; reason: string | null; message: string; release: ReleaseInfo }
export interface ReleasePackageFileDto { path: string; sha256: string; bytes: number; role: string; contentType: string }
/** The parts of a package manifest the studio reads (`manifest.json`; format in docs/design/RELEASE_PACKAGE.md). */
export interface ReleaseManifestDto {
  formatVersion: number;
  languages: { source: string; targets: Array<{ locale: string; name: string; texts: number; approved: number; missing: string[] }> };
  tests: { scenarios: number; pinnedTestsExcluded?: Array<{ test: string; reason: string }> };
  reference: { scenarios: string[]; files: string[] };
}
export interface ReleaseScenarioDto { id: string; name: string; customerName?: string }

const qs = (q: Record<string, unknown>) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v)); const s = u.toString(); return s ? `?${s}` : ''; };

export const api = {
  health: () => json<{ status: string; ai: { mode: 'external' | 'offline'; label: string; model?: string } }>('/api/v1/health'),
  projects: () => json<{ projects: ProjectSummary[] }>('/api/v1/projects'),
  project: (id: string) => json<{ project: Project }>(`/api/v1/projects/${id}`),
  saveProject: (project: Project, ifMatch: number) => json<{ project: Project; saved: boolean; contentDigest: string }>(`/api/v1/projects/${project.projectId}`, { method: 'PUT', body: JSON.stringify({ project }), headers: { 'If-Match': `"${ifMatch}"` } }),
  resetProject: (id: string) => json<{ project: Project; reset: boolean; seedDigest: string }>(`/api/v1/projects/${id}/reset`, { method: 'POST', body: JSON.stringify({ confirm: true }) }),
  duplicateProject: (id: string, title: string) => json<{ project: Project }>(`/api/v1/projects/${id}/duplicate`, { method: 'POST', body: JSON.stringify({ title }) }),
  renameProject: (id: string, title: string) => json<{ project: Project }>(`/api/v1/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  /** Data Explorer. Checks a customer against the document's data fields and says what the document would do for them; stores nothing. */
  checkRecord: (projectId: string, record: unknown, issueDate?: string | null) => json<{ problems: RecordProblem[]; outcome: RecordOutcome | null }>(`/api/v1/projects/${projectId}/records/check`, { method: 'POST', body: JSON.stringify({ record, ...(issueDate ? { issueDate } : {}) }) }),
  /** Adds a customer that belongs to this document: from data, or as an editable copy of any customer the document can see (`copyOf`). A 422 carries `body.error.problems`. */
  addRecord: (projectId: string, body: { record?: unknown; copyOf?: string; issueDate?: string }) => json<{ record: SyntheticRecord; origin: 'supplied'; copiedFrom: string | null; outcome: RecordOutcome }>(`/api/v1/projects/${projectId}/records`, { method: 'POST', body: JSON.stringify(body) }),
  /** Known data problems in force for the saved document (lapsed ones are removed by the server, and `note` says so). */
  knownDataProblems: (projectId: string, issueDate?: string | null) => json<KnownDataAnswer & { projectId: string; modelVersion: number; knownDataProblems: KnownDataProblemDto[] }>(`/api/v1/projects/${projectId}/known-data-problems${qs({ issueDate })}`),
  /** Sets one customer-data blocker aside for one customer (approvers only). */
  addKnownDataProblem: (projectId: string, body: { blockerId: string; recordId: string; reason: string; issueDate?: string }) => json<KnownDataAnswer & { knownDataProblem: KnownDataProblemDto }>(`/api/v1/projects/${projectId}/known-data-problems`, { method: 'POST', body: JSON.stringify(body) }),
  removeKnownDataProblem: (projectId: string, id: string, issueDate?: string | null) => json<KnownDataAnswer & { removed: string }>(`/api/v1/projects/${projectId}/known-data-problems/${encodeURIComponent(id)}${qs({ issueDate })}`, { method: 'DELETE' }),
  /** Saves one of the document's own customers. 409 RECORD_SHARED for sample and imported customers (copy them first). An edited generated customer becomes the document's own. */
  saveRecord: (projectId: string, recordId: string, record: unknown, issueDate?: string | null) => json<{ record: SyntheticRecord; origin: 'supplied'; wasGenerated: boolean; outcome: RecordOutcome }>(`/api/v1/projects/${projectId}/records/${recordId}`, { method: 'PUT', body: JSON.stringify({ record, ...(issueDate ? { issueDate } : {}) }) }),
  deleteRecord: (projectId: string, recordId: string) => json<{ removed: string }>(`/api/v1/projects/${projectId}/records/${recordId}`, { method: 'DELETE' }),
  /** What generating test customers would create for this project (stores nothing). Pass the unsaved model to plan for what is on screen. */
  planTestData: (projectId: string, body: { project?: Project; outcomes: boolean; edges: boolean; issueDate?: string }) => json<TestDataResult & { existing: number }>(`/api/v1/projects/${projectId}/test-data/plan`, { method: 'POST', body: JSON.stringify(body) }),
  /** Generates and stores test customers for this project only, replacing its previous generated set. */
  generateTestData: (projectId: string, body: { project?: Project; outcomes: boolean; edges: boolean; issueDate?: string }) => json<TestDataResult & { generated: number; replaced: number }>(`/api/v1/projects/${projectId}/test-data`, { method: 'POST', body: JSON.stringify(body) }),
  /** The project's current generated customers and what the last generation covered. `stale` = the saved document changed since. */
  testData: (projectId: string) => json<TestDataResult & { count: number; generatedAt: string | null; options: { outcomes: boolean; edges: boolean } | null; forModelVersion: number | null; stale: boolean }>(`/api/v1/projects/${projectId}/test-data`),
  clearTestData: (projectId: string) => json<RemovalResult>(`/api/v1/projects/${projectId}/test-data`, { method: 'DELETE' }),
  /** Built-in starters, then saved templates. `canSave` = this user may save a document as a template (approvers and admins). */
  templates: (includeRetired = false) => json<{ templates: TemplateInfoDto[]; canSave: boolean }>(`/api/v1/templates${includeRetired ? '?includeRetired=true' : ''}`),
  /** Saves the document's LAST SAVED version as a template. With `templateId` it adds the next version to that saved template. Errors: 403, 409 TEMPLATE_NAME_TAKEN, 400 DOCUMENT_TYPE_MISMATCH. */
  saveTemplate: (body: { projectId: string; title?: string; description?: string; note?: string; templateId?: string }) => json<{ template: TemplateInfoDto; version: number; created: boolean }>('/api/v1/templates', { method: 'POST', body: JSON.stringify(body) }),
  setTemplateRetired: (templateId: string, retired: boolean) => json<{ template: TemplateInfoDto }>(`/api/v1/templates/${templateId}`, { method: 'PATCH', body: JSON.stringify({ retired }) }),
  /** Checks a studio project file and (unless `dryRun`) stores it as a NEW draft document. A 422 failure is an `ApiFailure` whose `body.error.problems` is `[{ code, message }]`. */
  importProject: (file: unknown, opts: { title?: string; dryRun?: boolean } = {}) => json<{ project?: Project; dryRun?: boolean; wouldCreate?: { projectId: string; title: string }; report: ProjectImportReport }>('/api/v1/projects/import', { method: 'POST', body: JSON.stringify({ file, ...opts }) }),
  /** `previewRecord` comes with a document that has its own data (there is no stored customer to draw it with). */
  templateProject: (templateId: string, documentType?: string, version?: number) => json<{ template: TemplateInfoDto; project: Project; version?: number; previewRecord?: SyntheticRecord }>(`/api/v1/templates/${templateId}/project?${new URLSearchParams({ ...(documentType ? { documentType } : {}), ...(version ? { version: String(version) } : {}) })}`),
  /** `issuerName` (2-60 characters) and `accent` (#rrggbb) apply to the Blank project only. A document with its own data answers `customers`: how many it was given. */
  createProject: (body: { templateId: string; title: string; documentType?: string; templateVersion?: number; issuerName?: string; accent?: string }) => json<{ project: Project; createdFrom: string; templateVersion: number | null; customers?: number }>('/api/v1/projects', { method: 'POST', body: JSON.stringify(body) }),
  /** Drafts a setup for a new document from a description and/or sample data and stores nothing. With `spec` (and `source`) an edited setup is re-checked as it stands and no model is called. */
  draftSetup: (body: SetupDraftBody, signal?: AbortSignal) => json<SetupDraftResult>('/api/v1/projects/setup/draft', { method: 'POST', body: JSON.stringify(body), signal }),
  /** Creates the document from the setup a person approved. Needs the right to edit. A 422 (EMPTY_SETUP, INVALID_SETUP) is an `ApiFailure` with a plain message. */
  createSetup: (body: SetupCreateBody) => json<SetupCreated>('/api/v1/projects/setup', { method: 'POST', body: JSON.stringify(body) }),
  /** Rebuild from a file: reads the files on the server (nothing stored, nothing sent to a model). Refusals are `ApiFailure`s with `body.error.sample`. */
  readRebuildFiles: (files: RebuildFile[], signal?: AbortSignal) => json<RebuildReading>('/api/v1/projects/rebuild/read', { method: 'POST', body: JSON.stringify({ files }), signal }),
  /** Rebuild from a file: proposes a setup. With `useAi` the server needs `confirmNoCustomerData` and the exact `outline` shown. */
  proposeRebuild: (body: RebuildProposeBody, signal?: AbortSignal) => json<RebuildProposal>('/api/v1/projects/rebuild/propose', { method: 'POST', body: JSON.stringify(body), signal }),
  deleteProject: (id: string) => json<{ deleted: boolean }>(`/api/v1/projects/${id}`, { method: 'DELETE' }),
  /** `documentType` may be left out when `projectId` is sent. For a `custom` project `projectId` is required and the rows become that project's own customers; for the built-in kinds `scope: 'project'` does the same. */
  importRecords: (body: { documentType?: string; format: 'json' | 'csv'; data: string; dryRun?: boolean; projectId?: string; scope?: 'project' | 'shared' }) => json<ImportResult>('/api/v1/records/import', { method: 'POST', body: JSON.stringify(body) }),
  /** Removes the customers that were supplied (imported) for this project. Generated customers stay. A `custom` project keeps one customer at least. */
  deleteSuppliedRecords: (projectId: string) => json<RemovalResult>(`/api/v1/projects/${projectId}/records/supplied`, { method: 'DELETE' }),
  clearImportedRecords: (documentType?: string) => json<{ removed: number }>(`/api/v1/records/imported${documentType ? `?documentType=${documentType}` : ''}`, { method: 'DELETE' }),
  /** Tell the activity log that a person applied an assistant proposal (label and counts only). Never blocks the UI. */
  assistApplied: (body: { projectId: string; feature: string; label: string; source: 'builtin' | 'ai'; changes?: number; modelVersion?: number }) => json<{ recorded: boolean }>('/api/v1/assist/applied', { method: 'POST', body: JSON.stringify(body) }).catch(() => ({ recorded: false })),
  /* Model-backed assistant suggestions. Each answers `mode: 'ai'` with suggestions or `mode: 'unavailable'` with an explanation (no AI key, or nothing usable). Nothing is saved. */
  /** "Suggest compliant wording" (wording rules): the server checks the answer with the same checker and returns only options that break no "must" rule. */
  assistCompliant: (id: string, body: { text: string; scope: 'messages' | 'disclosures' | 'labels' | 'email' | 'sms'; locale?: string; project?: Project; /** Blockers phase 5: also meet the built-in "reads as a demand for money" check. */ tone?: boolean }) => json<AssistReply & { options: Array<{ text: string; tokenCheck: { ok: boolean; missing: string[]; extra: string[] }; warnings: string[] }>; refused?: string[] }>(`/api/v1/projects/${id}/assist/rewrite`, { method: 'POST', body: JSON.stringify({ ...body, style: 'compliant' }) }),
  assistRewrite: (id: string, body: { text: string; style: 'shorter' | 'plainer' | 'warmer' | 'formal' | 'one-sms'; kind: 'message' | 'label' | 'email' | 'sms'; locale?: string; project?: Project }) => json<AssistReply & { options: Array<{ text: string; tokenCheck: { ok: boolean; missing: string[]; extra: string[] } }> }>(`/api/v1/projects/${id}/assist/rewrite`, { method: 'POST', body: JSON.stringify(body) }),
  assistNewVersion: (id: string, body: { nodeId: string; brief: string; project?: Project }) => json<AssistReply & { title?: string; text?: string }>(`/api/v1/projects/${id}/assist/new-version`, { method: 'POST', body: JSON.stringify(body) }),
  assistSubjectLines: (id: string, body: { current: string; brief?: string; project?: Project }) => json<AssistReply & { options: Array<{ text: string }> }>(`/api/v1/projects/${id}/assist/subject-lines`, { method: 'POST', body: JSON.stringify(body) }),
  assistTranslationMeaning: (id: string, body: { locale: string; ids?: string[]; project?: Project }) => json<AssistReply & { flags: Array<{ textId: string; message: string }>; checked: number }>(`/api/v1/projects/${id}/assist/translation-meaning`, { method: 'POST', body: JSON.stringify(body) }),
  /** "Describe the rule": a draft rule from a sentence. Plain sentences work without a model (`mode: 'builtin'`). Nothing is saved. */
  assistRuleDraft: (id: string, body: { sentence: string; project?: Project }) => json<{ mode: 'builtin' | 'ai'; providerStatus: string; message: string; draft: import('@iss/scenarios').RuleDraft }>(`/api/v1/projects/${id}/assist/rule-draft`, { method: 'POST', body: JSON.stringify(body) }),
  assistImageDescription: (id: string, body: { nodeId: string; project?: Project }) => json<AssistReply & { text?: string }>(`/api/v1/projects/${id}/assist/image-description`, { method: 'POST', body: JSON.stringify(body) }),
  /* ---- ask about all customers (wave 4, item 7; docs/api/ASK_ALL_CUSTOMERS.md) ---- */
  /** A model reads a free sentence into the structured question (customer names are taken out first, here and on the server). The answer is worked out in the browser. */
  assistBaseQuestion: (id: string, body: { sentence: string; project?: Project }) => json<AssistReply & { question?: import('@iss/scenarios').BaseQuestion; problems?: string[] }>(`/api/v1/projects/${id}/assist/base-question`, { method: 'POST', body: JSON.stringify(body) }),
  /* ---- end ask about all customers ---- */
  /** First-pass translation drafts: AI when a key is configured, bundled sample drafts for the sample projects otherwise. Nothing is saved or approved. */
  translate: (id: string, body: { locale: string; ids?: string[]; project?: Project; forceOffline?: boolean }) => json<{ mode: 'ai' | 'sample' | 'unavailable'; locale: string; providerStatus: string; drafts: Array<{ id: string; text: string; tokenCheck: { ok: boolean; missing: string[]; extra: string[] } }>; skipped: Array<{ id: string; reason: string }>; message: string }>(`/api/v1/projects/${id}/translate`, { method: 'POST', body: JSON.stringify(body) }),
  translationsCsvUrl: (id: string, locale: string, issueDate?: string | null) => `/api/v1/projects/${id}/translations.csv?locale=${encodeURIComponent(locale)}${issueDate ? `&issueDate=${issueDate}` : ''}`,
  importTranslations: (id: string, body: { locale: string; csv: string; project?: Project }) => json<{ locale: string; drafts: Array<{ partId: string; text: string }>; errors: Array<{ row: number; partId: string; code: string; message: string }>; skipped: number; rows: number }>(`/api/v1/projects/${id}/translations/import`, { method: 'POST', body: JSON.stringify(body) }),
  schemas: (id: string) => json<{ fields: any[]; dimensions: any[]; edgeCasePresets: Array<{ id: string; label: string; description: string }> }>(`/api/v1/projects/${id}/schemas`),
  /** Customers for one kind of document. With a project id, also that project's own customers (generated test customers have `generated.label`). */
  records: (documentType: DocumentType | string, projectId?: string) => json<{ records: SyntheticRecord[]; seed: string }>(`/api/v1/records?documentType=${documentType}&full=1${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`),
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
  /** Validation with the PDF accessibility options: `verapdf` asks for a veraPDF run when it is installed; `accessibilityScope: 'pdf'` runs only the PDF part of the accessibility suite. */
  validateChecks: (req: ScenarioRequest & { suites?: string[]; verapdf?: boolean; accessibilityScope?: 'pdf' }) => json<any>('/api/v1/validate', { method: 'POST', body: JSON.stringify(req) }),
  /** Whether veraPDF is installed on the studio's machine (the studio never installs it). */
  verapdfStatus: () => json<{ installed: boolean; version?: string | null; message?: string }>('/api/v1/pdf-accessibility/verapdf'),
  /** The latest PDF accessibility record of a release (made on demand), or null. */
  releasePdfAccessibility: (releaseId: string) => json<{ record: ReleasePdfRecordDto | null; verapdf: { installed: boolean; version?: string | null; message?: string } }>(`/api/v1/releases/${releaseId}/pdf-accessibility`),
  /** Composes the release's PDF for a sample customer, checks it and records the level of proof reached. */
  checkReleasePdfAccessibility: (releaseId: string) => json<{ record: ReleasePdfRecordDto }>(`/api/v1/releases/${releaseId}/pdf-accessibility`, { method: 'POST', body: '{}' }),
  replayJourney: (req: { projectId: string; recordId: string; overrides?: Record<string, unknown>; project?: Project; journeyCursor?: number | null; issueDate?: string }) => json<any>('/api/v1/journeys/replay', { method: 'POST', body: JSON.stringify(req) }),
  snapshots: (projectId: string, recordId?: string) => json<{ snapshots: any[] }>(`/api/v1/snapshots?projectId=${projectId}${recordId ? `&recordId=${recordId}` : ''}`),
  resetSnapshots: (projectId: string) => json<{ cleared: boolean }>('/api/v1/snapshots/reset', { method: 'POST', body: JSON.stringify({ projectId, confirm: true }) }),
  generateEdgeCase: (recordId: string, preset: string, seed?: string) => json<{ overrides: Record<string, unknown>; description: string; scenarioHash: string; seed: string; presetId: string }>('/api/v1/scenarios/generate', { method: 'POST', body: JSON.stringify({ recordId, preset, seed }) }),
  artifacts: (q: { runId?: string; projectId?: string }) => json<{ artifacts: any[] }>(`/api/v1/artifacts?${new URLSearchParams(q as any)}`),
  artifactUrl: (id: string, inline = false) => `/api/v1/artifacts/${id}${inline ? '?inline=1' : ''}`,
  assistantStatus: () => json<{ mode: 'external' | 'offline'; label: string; model?: string }>('/api/v1/assistant/status'),
  assistantMessage: (body: { message: string; context: any; project?: Project; forceOffline?: boolean }) => json<any>('/api/v1/assistant/message', { method: 'POST', body: JSON.stringify(body) }),
  decideProposal: (id: string, approved: boolean, modelVersion: number) => json<any>(`/api/v1/assistant/proposals/${id}/decision`, { method: 'POST', body: JSON.stringify({ approved, modelVersion }) }),
  startBatch: (body: { projectId: string; project?: Project; recordIds?: string[]; outputs: Array<'pdf' | 'html'>; includeBlocked?: boolean; issueDate?: string }) => json<{ batch: BatchDto }>('/api/v1/batches', { method: 'POST', body: JSON.stringify(body) }),
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
  // Releases: frozen, numbered copies of an approved document, their stages, the package and the handover log.
  projectReleases: (projectId: string) => json<ProjectReleasesDto>(`/api/v1/projects/${projectId}/releases`),
  createRelease: (projectId: string) => json<ReleaseCreateResult>(`/api/v1/projects/${projectId}/releases`, { method: 'POST', body: '{}' }),
  release: (releaseId: string) => json<ReleaseDetailDto>(`/api/v1/releases/${releaseId}`),
  promoteRelease: (releaseId: string, note?: string) => json<{ release: ReleaseInfo; superseded: ReleaseInfo[] }>(`/api/v1/releases/${releaseId}/promote`, { method: 'POST', body: JSON.stringify(note ? { note } : {}) }),
  withdrawRelease: (releaseId: string, stage: ReleaseStage, reason: string) => json<{ release: ReleaseInfo }>(`/api/v1/releases/${releaseId}/withdraw`, { method: 'POST', body: JSON.stringify({ stage, reason }) }),
  addHandover: (releaseId: string, body: { kind: HandoverKind; note?: string; stage?: ReleaseStage }) => json<{ entry: HandoverEntry; handover: HandoverEntry[]; release: ReleaseInfo }>(`/api/v1/releases/${releaseId}/handover`, { method: 'POST', body: JSON.stringify(body) }),
  packageStatus: (releaseId: string) => json<{ package: ReleasePackageStatus }>(`/api/v1/releases/${releaseId}/package/status`),
  /** Starts building the package in the background (a ready package is only checked, never replaced). Answers at once unless `wait`. */
  preparePackage: (releaseId: string, body: { wait?: boolean; verify?: boolean } = {}) => json<{ package: ReleasePackageStatus; started: boolean }>(`/api/v1/releases/${releaseId}/package`, { method: 'POST', body: JSON.stringify(body) }),
  packageFiles: (releaseId: string) => json<{ package: ReleasePackageStatus; files: ReleasePackageFileDto[] }>(`/api/v1/releases/${releaseId}/package/files`),
  /** One file of a ready package, for a preview (no ZIP download). */
  packageFileUrl: (releaseId: string, path: string, download = false) => `/api/v1/releases/${releaseId}/package/files/${path.split('/').map(encodeURIComponent).join('/')}${download ? '?download=1' : ''}`,
  packageFileText: async (releaseId: string, path: string): Promise<string> => {
    const res = await fetch(`/api/v1/releases/${releaseId}/package/files/${path.split('/').map(encodeURIComponent).join('/')}`);
    if (!res.ok) { const b = await res.json().catch(() => ({})); throw new ApiFailure(res.status, b?.error?.code ?? 'HTTP_' + res.status, b?.error?.message ?? res.statusText, b); }
    return res.text();
  },
  packageDownloadUrl: (releaseId: string) => `/api/v1/releases/${releaseId}/package`,
  releaseTemplateUrl: (releaseId: string) => `/api/v1/releases/${releaseId}/template`,
  /** The frozen project of a release (approved wording only, the same content as `template.json` in its package). It keeps the document's id, so it can be sent as `project` to the compose routes. */
  releaseProject: (releaseId: string) => json<Project>(`/api/v1/releases/${releaseId}/template`),
  // The runnable package of a release (phase 7): the release plus the pinned engine, a data contract and a proof pack.
  runtimeStatus: (releaseId: string) => json<{ runtime: RuntimePackageStatus }>(`/api/v1/releases/${releaseId}/runtime/status`),
  /** Starts building it in the background (a ready one is only checked, never replaced). Answers at once unless `wait`. */
  prepareRuntime: (releaseId: string, body: { wait?: boolean; verify?: boolean } = {}) => json<{ runtime: RuntimePackageStatus; started: boolean }>(`/api/v1/releases/${releaseId}/runtime`, { method: 'POST', body: JSON.stringify(body) }),
  runtimeDownloadUrl: (releaseId: string) => `/api/v1/releases/${releaseId}/runtime`,
  // Shared library (wave 2, phase 4): items and their versions live on the server; documents link to approved versions.
  libraryItems: (q: { kind?: LibraryKind; q?: string; state?: 'approved' | 'draft' } = {}) => json<{ items: LibraryItemDto[]; can: LibraryCan }>(`/api/v1/library?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as Array<[string, string]>)}`),
  libraryItem: (itemId: string) => json<{ item: LibraryItemDto; usage: LibraryUsage[]; can: LibraryCan }>(`/api/v1/library/${encodeURIComponent(itemId)}`),
  /** One version's content; `latest` = the latest approved one. */
  libraryVersion: (itemId: string, version: number | 'latest') => json<{ item: { id: string; kind: LibraryKind; title: string }; version: LibraryVersionInfo; content: LibraryContent }>(`/api/v1/library/${encodeURIComponent(itemId)}/versions/${version}`),
  /** A new item with its first version as a draft (authors and admins). `source` names the document and thing it was taken from. */
  createLibraryItem: (body: { kind: LibraryKind; title: string; description?: string; note?: string; content?: unknown; source?: { projectId: string; ref?: string }; projectId?: string; ref?: string }) => json<{ item: LibraryItemDto }>('/api/v1/library', { method: 'POST', body: JSON.stringify(body) }),
  saveLibraryDraft: (itemId: string, body: { content?: unknown; projectId?: string; ref?: string; note?: string; title?: string; description?: string }) => json<{ item: LibraryItemDto; version: number; created: boolean }>(`/api/v1/library/${encodeURIComponent(itemId)}/draft`, { method: 'PUT', body: JSON.stringify(body) }),
  approveLibraryDraft: (itemId: string, note?: string) => json<{ item: LibraryItemDto; version: number; usage: LibraryUsage[] }>(`/api/v1/library/${encodeURIComponent(itemId)}/approve`, { method: 'POST', body: JSON.stringify(note ? { note } : {}) }),
  discardLibraryDraft: (itemId: string) => json<{ item: LibraryItemDto | null; discarded: number }>(`/api/v1/library/${encodeURIComponent(itemId)}/draft`, { method: 'DELETE' }),
  /** Dry run: what updating this document's link to `version` changes, and for which synthetic customers. Send `project` for the working copy. */
  libraryImpact: (itemId: string, body: { projectId: string; version?: number; linkId?: string; project?: Project }) => json<LibraryImpactDto>(`/api/v1/library/${encodeURIComponent(itemId)}/impact`, { method: 'POST', body: JSON.stringify(body) }),
  // Duplicate wording (wave 3): the scan reads only; keeping a wording makes a library draft; the link preview is a dry run.
  libraryDuplicates: (q: { threshold?: number; kinds?: DuplicateKind[]; language?: string } = {}) => json<LibraryDuplicatesDto>(`/api/v1/library/duplicates?${new URLSearchParams([
    ...(q.threshold !== undefined ? [['threshold', String(q.threshold)]] : []), ...(q.kinds?.length ? [['kinds', q.kinds.join(',')]] : []), ...(q.language ? [['language', q.language]] : []),
  ] as Array<[string, string]>)}`),
  keepDuplicateWording: (body: { title: string; text: string; heading?: string; type: 'text' | 'disclosure'; description?: string; note?: string; members: Array<{ projectId: string; textId: string } | { itemId: string }>; source?: { projectId: string; ref: string } }) =>
    json<{ item: LibraryItemDto; translations: string[]; notCarried: string[]; edited: boolean }>('/api/v1/library/duplicates/keep', { method: 'POST', body: JSON.stringify(body) }),
  libraryLinkPreview: (itemId: string, body: { projectId: string; partId: string; project?: Project }) => json<LibraryLinkPreviewDto>(`/api/v1/library/${encodeURIComponent(itemId)}/link-preview`, { method: 'POST', body: JSON.stringify(body) }),
  linkLibraryDrafts: (itemId: string, targets: Array<{ projectId: string; partId: string; modelVersion?: number }>) => json<LibraryLinkDraftsDto>(`/api/v1/library/${encodeURIComponent(itemId)}/link-drafts`, { method: 'POST', body: JSON.stringify({ targets }) }),
  releaseLibrary: (releaseId: string) => json<{ library: Array<{ itemId: string; title: string; kind: LibraryKind; version: number; inLibrary: boolean }> }>(`/api/v1/releases/${releaseId}/library`),
};

/* ------------------------------------------------------------------ accessible PDF (wave 2) */

export type PdfCheckStatus = 'passed' | 'failed' | 'not-checked';
export interface PdfCheckDto { id: string; label: string; status: PdfCheckStatus; detail: string; failures: number }
/** veraPDF's part: its verdict and failed rules, or why it did not run. */
export type VeraPdfDto =
  | { status: 'not-installed' | 'not-run'; message: string }
  | { status: 'ran'; version: string | null; profile: string; compliant: boolean; failedRules: Array<{ id: string; description: string; count: number; knownLimit?: string }>; passedRules: number | null; failedChecks: number | null; ranAt: string; durationMs: number }
  | { status: 'error' | 'timeout'; version: string | null; message: string; ranAt: string; durationMs: number };
/** The PDF accessibility result of one validation (apps/api/src/pdfAccessibility.ts). */
export interface PdfAccessibilityDto {
  checkedAt: string;
  recordId: string;
  studio: {
    level: 'studio'; checker: string; reader: string; pageCount: number; title: string | null; language: string | null; required: boolean;
    checks: PdfCheckDto[];
    findings: Array<{ code: string; severity: string; message: string; nodeId?: string; page?: number; suggestion?: string; details: { check: string; title: string; fix: string } & Record<string, unknown> }>;
    summary: { ran: number; passed: number; failed: number; notChecked: number };
    knownLimits: Array<{ id: string; text: string }>;
  };
  verapdf: VeraPdfDto;
}
/** What a release records about its PDF (on demand). */
export interface ReleasePdfRecordDto {
  id: number; releaseId: string; at: string; by: string | null; recordId: string;
  level: 'studio' | 'verapdf'; levelLabel: string;
  studio: { checker: string; pageCount: number; summary: { ran: number; passed: number; failed: number; notChecked: number }; checks: Array<{ id: string; label: string; status: PdfCheckStatus }>; findings: number };
  verapdf: { status: string; version?: string | null; compliant?: boolean; failedRules?: Array<{ id: string; description: string; count: number; knownLimit?: string }>; message?: string };
}

/* ------------------------------------------------------------------ shared library */

export interface LibraryCan { create: boolean; approve: boolean; /** Only an admin sets whether a house wording rule is a “must” or a “should”. */ setSeverity?: boolean }
export type LibraryItemDto = LibraryItemInfo & { usage: { documents: number; links: number; behind: number } };
export type LibraryDuplicatesDto = DuplicateScan & {
  documents: Array<{ projectId: string; title: string; documentType: DocumentType; modelVersion: number; workflowState: WorkflowState }>;
  /** How long the scan took (when `cached`, the scan that is being served again). */
  tookMs: number; cached: boolean; servedInMs: number;
  can: LibraryCan & { link: boolean };
};
export interface LibraryLinkPreviewDto {
  itemId: string; title: string; partId: string; identical: boolean; difference: string | null;
  before: { title: string; type: 'text' | 'disclosure'; approvedLocales: Record<string, string> };
  after: { title: string; type: 'text' | 'disclosure'; approvedLocales: Record<string, string> };
  comparison: VersionComparison;
  changes: Array<{ title: string; items: string[] }>;
  content: LibraryContent;
  version: LibraryVersionInfo;
}
export interface LibraryLinkDraftsDto {
  item: { id: string; title: string; version: number };
  linked: Array<{ projectId: string; title: string; partId: string; linkId: string; fromVersion: number; toVersion: number }>;
  refused: Array<{ projectId: string; title: string | null; partId: string; code: string; reason: string; state?: WorkflowState }>;
}
export interface LibraryImpactDto {
  linkId: string; title: string; kind: LibraryKind; from: number; to: number;
  comparison: VersionComparison;
  changes: Array<{ title: string; items: string[] }>;
  content: LibraryContent;
  version: LibraryVersionInfo;
}

/* ------------------------------------------------------------------ review links (wave 4, docs/api/REVIEW_LINKS.md) */

export type ReviewOutputId = 'pdf' | 'html' | 'email' | 'sms';
export interface ReviewLinkDto {
  id: string; label: string;
  target: { kind: 'release' | 'version'; releaseId: string | null; releaseNumber: number | null; version: number };
  customers: string[]; languages: string[]; outputs: ReviewOutputId[];
  createdBy: { id: string | null; name: string } | null; createdAt: string; expiresAt: string;
  status: 'active' | 'expired' | 'revoked'; revokedAt: string | null; revokedBy: string | null;
  opens: number; firstOpenedAt: string | null; lastOpenedAt: string | null; comments: number; mayRevoke: boolean;
}
export interface ReviewLinkLimitsDto { customersMin: number; customersMax: number; expiryDefaultDays: number; expiryMinDays: number; expiryMaxDays: number; activePerDocument: number; commentsPerHour: number; commentsTotal: number; outputsPerMinute: number; nameMax: number; commentMax: number; labelMax: number }
export interface ReviewLinkOptionsDto {
  target: { kind: 'release' | 'version'; releaseId: string | null; releaseNumber: number | null; version: number; title: string };
  customers: Array<{ recordId: string; name: string; kind: 'sample' | 'generated' | 'imported' | 'supplied' | 'missing'; allowed: boolean; reason: string | null }>;
  languages: Array<{ code: string; name: string }>;
  outputs: Array<{ id: ReviewOutputId; label: string }>;
  limits: ReviewLinkLimitsDto; active: number;
}
export interface ReviewLinkCreateBody { releaseId?: string; version?: number; label?: string; customers: string[]; languages?: string[]; outputs?: ReviewOutputId[]; expiresInDays?: number }
/** A comment that came through a review link, as the studio's comment list marks it. */
export interface ReviewLinkCommentMark { linkId: string; label: string; status: 'active' | 'expired' | 'revoked'; recordId: string; output: ReviewOutputId; outputLabel: string; locale: string }
export type CommentWithLinkDto = CommentDto & { reviewLink?: ReviewLinkCommentMark };

/** Review links for signed-in users. The public review page has its own small client (apps/web/src/review). */
export const reviewLinksApi = {
  list: (projectId: string) => json<{ links: ReviewLinkDto[]; active: number; limits: ReviewLinkLimitsDto }>(`/api/v1/projects/${projectId}/review-links`),
  options: (projectId: string, target: { releaseId?: string; version?: number }) => json<ReviewLinkOptionsDto>(`/api/v1/projects/${projectId}/review-links/options${target.releaseId ? `?releaseId=${encodeURIComponent(target.releaseId)}` : `?version=${target.version}`}`),
  /** The answer holds the token, once: it is not stored and cannot be shown again. */
  create: (projectId: string, body: ReviewLinkCreateBody) => json<{ link: ReviewLinkDto; token: string; path: string }>(`/api/v1/projects/${projectId}/review-links`, { method: 'POST', body: JSON.stringify(body) }),
  revoke: (projectId: string, linkId: string) => json<{ link: ReviewLinkDto; alreadyRevoked: boolean }>(`/api/v1/projects/${projectId}/review-links/${linkId}/revoke`, { method: 'POST', body: '{}' }),
};
/* ------------------------------------------------------------------ end review links */
/* Wave 4 (blocker owners, status and notes; notifications and My work): the shared request helper, for api/work.ts. */
export { json as requestJson };
