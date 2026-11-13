import type { ProofChannel, ProofDifferenceKind, ProofOutput, ProofRecord } from '@iss/resolver';
import { ApiFailure } from '../../api/client';

/**
 * Calls for the Proof screen (docs/api/PROOFS.md). Kept beside the screen so the shared client stays untouched;
 * errors are the same `ApiFailure` the rest of the studio uses.
 */

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiFailure(0, 'NETWORK', 'The Spatial Studio API is not reachable. Start it with `pnpm dev`.');
  }
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (res.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('iss:unauthenticated'));
  if (!res.ok) throw new ApiFailure(res.status, body?.error?.code ?? 'HTTP_' + res.status, body?.error?.message ?? res.statusText, body);
  return body as T;
}

export type ReleaseStatus = 'known' | 'unknown' | 'different';
export interface ProofReleaseDto { status: ReleaseStatus; message: string | null; info: { id: string; number: number; title: string; documentId: string; standing: 'production' | 'test' | 'superseded' | 'withdrawn'; documentRemoved: boolean } | null }
export interface ProofMetaDto { source: 'studio' | 'file'; addedAt: string; addedBy: { id: string; name: string } | null }
export interface ProofItemDto { proof: ProofRecord; meta: ProofMetaDto; release: ProofReleaseDto }
export interface ProofLimitsDto { customers: number; customersWithPdf: number; fileBytes: number; fileLines: number; lineBytes: number; suppliedBytes: number; pageMax: number }
export interface ProofListDto { records: ProofItemDto[]; total: number; limit: number; offset: number; limits: ProofLimitsDto }
export interface NamedDecisionDto { nodeId: string; part: string; variantId: string | null; message: string | null; rules: Array<{ id: string; title: string }>; known: boolean }
export interface ProofDetailDto extends ProofItemDto {
  explanation: { namedFrom: 'release' | 'ids'; decisions: NamedDecisionDto[]; blocked: Array<{ code: string; words: string }>; valuesHeld: false };
  outputs: Array<ProofOutput & { label: string }>;
}
export interface ProofQuery { documentId?: string; releaseId?: string; customerRef?: string; from?: string; to?: string; q?: string; limit?: number; offset?: number }

export interface VerifyDifferenceDto { kind: ProofDifferenceKind; message: string; plain: string; nodeId?: string; channel?: ProofChannel }
export interface VerifyResultDto {
  proofId: string; same: boolean; verdict: string;
  differences: VerifyDifferenceDto[];
  checked: { release: ProofReleaseDto['info']; dataFrom: 'test-customer' | 'supplied'; outputs: ProofChannel[]; stored: false };
  explanation?: Array<{ nodeId: string; part: string; headline: string; steps: string[] }>;
  recreated?: { html?: string; email?: { subject: string; preheader: string; html: string; text: string }; sms?: string; pdf?: { pages: number | null; note: string } };
}
export type VerifyBody = { recordId: string; releaseId?: string } | { record: unknown; releaseId?: string };

export interface ImportLineDto { line: number; proofId: string | null; outcome: 'new' | 'known' | 'conflict' | 'refused'; problems: string[]; releaseKnown?: boolean }
export interface ImportResultDto {
  dryRun: boolean; lines: number; new: number; known: number; conflict: number; refused: number; unknownRelease: number; added: number;
  producers: { studio: number; runtime: number };
  details: ImportLineDto[]; detailsCut: boolean;
}

export interface ProduceResultDto {
  release: ProofReleaseDto['info']; producedAt: string; outputs: ProofChannel[];
  counts: { customers: number; produced: number; stopped: number; added: number };
  results: Array<{ proofId: string; customerRef: string; produced: boolean; blockedBy: string[]; blockedWords: string[]; outputs: ProofOutput[] }>;
  filesKept: false; message: string;
}

const qs = (q: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const proofApi = {
  list: (q: ProofQuery) => call<ProofListDto>(`/api/v1/proofs${qs(q as Record<string, unknown>)}`),
  get: (proofId: string) => call<ProofDetailDto>(`/api/v1/proofs/${encodeURIComponent(proofId)}`),
  verify: (proofId: string, body: VerifyBody) => call<VerifyResultDto>(`/api/v1/proofs/${encodeURIComponent(proofId)}/verify`, { method: 'POST', body: JSON.stringify(body) }),
  importFile: (text: string, dryRun: boolean) => call<ImportResultDto>('/api/v1/proofs/import', { method: 'POST', body: JSON.stringify({ text, dryRun }) }),
  produce: (releaseId: string, body: { recordId?: string; all?: true; outputs: ProofChannel[] }) => call<ProduceResultDto>(`/api/v1/releases/${encodeURIComponent(releaseId)}/produce`, { method: 'POST', body: JSON.stringify(body) }),
};
