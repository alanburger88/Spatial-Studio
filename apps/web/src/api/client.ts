import type { Persona, Project, SyntheticRecord } from '@iss/model';

/** Typed client for the local Spatial Studio API (/api/v1, proxied by Vite). */

export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string, public body?: any) { super(message); }
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  } catch (e) {
    throw new ApiFailure(0, 'NETWORK', 'The Spatial Studio API is not reachable. Start it with `pnpm dev`.');
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiFailure(res.status, body?.error?.code ?? 'HTTP_' + res.status, body?.error?.message ?? res.statusText, body);
  return body as T;
}

export interface ProjectSummary {
  projectId: string; title: string; documentType: 'credit-statement' | 'eob'; modelVersion: number; schemaVersion: string;
  issuer: Project['issuer']; contentDigest: string; modified: boolean; updatedAt: string; nodeCount: number; ruleCount: number;
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
}

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

export const api = {
  health: () => json<{ status: string; ai: { mode: 'external' | 'offline'; label: string; model?: string } }>('/api/v1/health'),
  projects: () => json<{ projects: ProjectSummary[] }>('/api/v1/projects'),
  project: (id: string) => json<{ project: Project }>(`/api/v1/projects/${id}`),
  saveProject: (project: Project, ifMatch: number) => json<{ project: Project; saved: boolean; contentDigest: string }>(`/api/v1/projects/${project.projectId}`, { method: 'PUT', body: JSON.stringify({ project }), headers: { 'If-Match': `"${ifMatch}"` } }),
  resetProject: (id: string) => json<{ project: Project; reset: boolean; seedDigest: string }>(`/api/v1/projects/${id}/reset`, { method: 'POST', body: JSON.stringify({ confirm: true }) }),
  schemas: (id: string) => json<{ fields: any[]; dimensions: any[]; edgeCasePresets: Array<{ id: string; label: string; description: string }> }>(`/api/v1/projects/${id}/schemas`),
  records: (documentType: string) => json<{ records: SyntheticRecord[]; seed: string }>(`/api/v1/records?documentType=${documentType}&full=1`),
  personas: () => json<{ personas: Persona[] }>('/api/v1/personas'),
  resolve: (req: ScenarioRequest) => json<any>('/api/v1/resolve', { method: 'POST', body: JSON.stringify(req) }),
  composePdf: (req: ScenarioRequest) => binary('/api/v1/compose/pdf', req),
  composeHtml: (req: ScenarioRequest) => binary('/api/v1/compose/html', req),
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
};
