import type { JourneyEvent, Overrides, Scalar, SyntheticRecord } from './types';

export function deepClone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/** Nonmutating deep patch: objects merge recursively, arrays and scalars replace (oracle semantics). */
export function deepPatch<T extends Record<string, any>>(value: T, patch: Overrides | undefined): T {
  const out: any = deepClone(value);
  const apply = (target: any, p: any) => {
    for (const [k, v] of Object.entries(p ?? {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) apply(target[k], v);
      else target[k] = deepClone(v);
    }
  };
  apply(out, patch);
  return out;
}

/** Path lookup with `.count` collection semantics. Returns null when the path is absent. */
export function getPath(ctx: unknown, path: string): any {
  const parts = path.split('.');
  if (parts[parts.length - 1] === 'count') {
    const container = getPath(ctx, parts.slice(0, -1).join('.'));
    if (Array.isArray(container)) return container.length;
    if (container && typeof container === 'object') return Object.keys(container).length;
    // fall through: a literal field named count
  }
  let v: any = ctx;
  for (const p of parts) {
    if (v === null || typeof v !== 'object' || !(p in v)) return null;
    v = v[p];
  }
  return v === undefined ? null : v;
}

export function setPath(obj: any, path: string, value: Scalar): void {
  const parts = path.split('.');
  let t = obj;
  for (const p of parts.slice(0, -1)) {
    if (t[p] === null || typeof t[p] !== 'object') t[p] = {};
    t = t[p];
  }
  t[parts[parts.length - 1]] = value;
}

/** Versioned pure-function registry of derived fields. Never uses an LLM; integer cents only. */
export const DERIVED_FIELDS_VERSION = 'derived-v1';

export interface EvalContext {
  [key: string]: any;
  documentType: string;
  recordId: string;
  claim?: Record<string, any>;
}

export function buildContext(record: SyntheticRecord, claimIndex = 0): EvalContext {
  const ctx: any = deepClone(record);
  if (record.documentType === 'eob') {
    const claims = record.claims ?? [];
    ctx.claim = claimIndex < claims.length ? deepClone(claims[claimIndex]) : {};
  }
  if (ctx.card) {
    const tx: any[] = Array.isArray(ctx.card.transactions) ? ctx.card.transactions : [];
    ctx.card.availableCreditCents = Number.isInteger(ctx.card.creditLimitCents) && Number.isInteger(ctx.card.newBalanceCents) ? Math.max(0, ctx.card.creditLimitCents - ctx.card.newBalanceCents) : null;
    ctx.card.transactionsTotalCents = tx.reduce((s, t) => s + (Number.isInteger(t.amountCents) ? t.amountCents : 0), 0);
  }
  return ctx;
}

export interface JourneyStep {
  event: JourneyEvent;
  index: number;
  applied: boolean;
  skippedReason?: string;
  changes: Array<{ path: string; before: Scalar; after: Scalar }>;
}

/**
 * Applies journey events 0..cursor (inclusive) to a record deterministically, returning a new record.
 * `claim.*` effect paths address the active claim in the `claims` array.
 */
export function applyJourney(record: SyntheticRecord, events: JourneyEvent[], cursor: number | null, claimIndex = 0): { record: SyntheticRecord; steps: JourneyStep[] } {
  const rec: any = deepClone(record);
  const steps: JourneyStep[] = [];
  if (cursor === null || cursor < 0) return { record: rec, steps };
  const resolvePath = (path: string) => (path.startsWith('claim.') ? `claims.${claimIndex}.${path.slice(6)}` : path);
  const read = (path: string) => {
    const parts = resolvePath(path).split('.');
    let v: any = rec;
    for (const p of parts) { if (v == null) return null; v = Array.isArray(v) ? v[Number(p)] : v[p]; }
    return v ?? null;
  };
  const write = (path: string, value: Scalar) => {
    const parts = resolvePath(path).split('.');
    let t: any = rec;
    for (const p of parts.slice(0, -1)) { t = Array.isArray(t) ? t[Number(p)] : (t[p] ??= {}); if (t == null) return; }
    t[parts[parts.length - 1]] = value;
  };
  for (let i = 0; i <= Math.min(cursor, events.length - 1); i++) {
    const event = events[i];
    const failed = (event.preconditions ?? []).find((pc) => !compare(read(pc.path), pc.op, pc.value));
    if (failed) {
      steps.push({ event, index: i, applied: false, skippedReason: `Precondition ${failed.path} ${failed.op} ${JSON.stringify(failed.value)} not met (was ${JSON.stringify(read(failed.path))}).`, changes: [] });
      continue;
    }
    const changes = event.effects.map((eff) => {
      const before = read(eff.path);
      write(eff.path, eff.value);
      return { path: eff.path, before, after: eff.value };
    });
    steps.push({ event, index: i, applied: true, changes });
  }
  return { record: rec, steps };
}

export function compare(field: any, op: string, value: any): boolean {
  switch (op) {
    case 'eq': return field !== null && field === value;
    case 'ne': return field !== null && field !== value;
    case 'gt': return field !== null && field > value;
    case 'gte': return field !== null && field >= value;
    case 'lt': return field !== null && field < value;
    case 'lte': return field !== null && field <= value;
    default: return false;
  }
}
