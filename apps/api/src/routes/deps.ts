import type { Project, SyntheticRecord } from '@iss/model';
import type { Resolution } from '@iss/resolver';
import type { Composer } from '../composer';
import type { Store } from '../db';
import type { ApiError } from '../app';

/** Shared helpers handed to feature route modules so they never re-implement validation or persistence. */
export interface RouteDeps {
  store: Store;
  composer: Composer;
  ApiError: typeof ApiError;
  projectOr404(id: string): Project;
  recordOr404(id: string): SyntheticRecord;
  /** Seeded fixtures plus locally imported records. */
  allRecords(): SyntheticRecord[];
  /** Validates a client-supplied (possibly unsaved) project against the canonical shape and every rule. */
  checkDraftProject(p: unknown, projectId: string): Project;
  /** Resolves a ResolveBody-shaped request (projectId, recordId, overrides?, journeyCursor?, project?, outputContext?) and records an immutable run. */
  runFor(body: unknown): { res: Resolution; project: Project; request: any };
}
