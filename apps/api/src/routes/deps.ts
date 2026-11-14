import type { Project, SyntheticRecord } from '@iss/model';
import type { Resolution } from '@iss/resolver';
import type { Composer } from '../composer';
import type { Store } from '../db';
import type { ApiError } from '../app';
import type { ReleasePackages } from '../releases';

/** Shared helpers handed to feature route modules so they never re-implement validation or persistence. */
export interface RouteDeps {
  store: Store;
  composer: Composer;
  ApiError: typeof ApiError;
  projectOr404(id: string): Project;
  recordOr404(id: string): SyntheticRecord;
  /** Seeded fixtures plus locally imported records; with a project id, also the records that belong to that project alone. */
  allRecords(projectId?: string): SyntheticRecord[];
  /** Validates a client-supplied (possibly unsaved) project against the canonical shape and every rule. */
  checkDraftProject(p: unknown, projectId: string): Project;
  /** Resolves a ResolveBody-shaped request (projectId, recordId, overrides?, journeyCursor?, project?, outputContext?) and records an immutable run. */
  runFor(body: unknown): { res: Resolution; project: Project; request: any };
  /** The model call behind the assistant's writing features; tests replace it. */
  assistModel?: import('../assistAi').AssistModel;
  /** Builds, keeps and serves release packages (one instance per app). */
  releasePackages: ReleasePackages;
  /** The AI translation call; tests replace it. */
  translator?: import('../translate').Translator;
}
