import { useEffect, useMemo, useState } from 'react';
import { compareWithBase, mergeVariantUpdate, type Project, type VariantDifference, type VariantUpdate } from '@iss/model';
import { ApiFailure, api, variantApi } from '../../api/client';
import { useStudio } from '../../state/store';

/**
 * Variants by brand or region (wave 5): where the open variant stands against its base, worked out in the browser from
 * the WORKING version (so unsaved edits show at once). The base's saved versions come from the version history; the
 * comparison and the update are the pure functions in `@iss/model` (`variants.ts`). This module is only imported by
 * screens that load on demand, so the first download does not carry the merge code.
 */

/** A saved version never changes, so what was fetched is kept for the browser session. */
const versions = new Map<string, Promise<Project>>();
export function baseVersion(projectId: string, version: number): Promise<Project> {
  const key = `${projectId}@${version}`;
  let p = versions.get(key);
  if (!p) { p = api.version(projectId, version).then((r) => r.project); versions.set(key, p); p.catch(() => versions.delete(key)); }
  return p;
}

export interface VariantState {
  status: 'none' | 'loading' | 'missing' | 'error' | 'ready';
  message?: string;
  baseId?: string;
  baseTitle?: string;
  /** The base's latest saved version, and the version the working variant follows. */
  latest?: number;
  follows?: number;
  behind?: boolean;
  /** The base at the version followed, and at its latest saved version (only when behind). */
  at?: Project;
  now?: Project;
  customers: Record<string, string>;
  differences: VariantDifference[];
  update: VariantUpdate | null;
  reload(): void;
}

const NONE: Omit<VariantState, 'reload'> = { status: 'none', customers: {}, differences: [], update: null };

export function useVariant(project: Project | null): VariantState {
  const saved = useStudio((s) => s.serverVersion);
  const [rev, setRev] = useState(0);
  const v = project?.variantOf ?? null;
  const [loaded, setLoaded] = useState<{ key: string; state: Omit<VariantState, 'reload' | 'differences' | 'update'> } | null>(null);
  const key = v && project ? `${project.projectId}|${v.projectId}@${v.modelVersion}|${saved}|${rev}` : '';
  useEffect(() => {
    if (!v || !project) return;
    let live = true;
    (async () => {
      const info = await variantApi.info(project.projectId);
      if (!info.variant) return { status: 'none' as const, customers: {} };
      if (!('customers' in info) || !info.base.found) return { status: 'missing' as const, message: 'message' in info.base ? info.base.message : '', customers: {} };
      const latest = info.base.latestVersion;
      const at = await baseVersion(v.projectId, v.modelVersion);
      const behind = latest > v.modelVersion;
      const now = behind ? await baseVersion(v.projectId, latest) : undefined;
      return { status: 'ready' as const, baseId: v.projectId, baseTitle: info.base.title, latest, follows: v.modelVersion, behind, at, now, customers: info.customers };
    })().then(
      (state) => { if (live) setLoaded({ key, state }); },
      (e) => { if (live) setLoaded({ key, state: { status: e instanceof ApiFailure && e.status === 404 ? 'missing' : 'error', message: e instanceof ApiFailure ? e.message : 'The base could not be loaded.', customers: {} } }); },
    );
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = loaded && loaded.key === key ? loaded.state : null;
  const differences = useMemo(() => (state?.status === 'ready' && project && state.at ? compareWithBase(state.at, project, { customers: state.customers }) : []), [state, project]);
  const update = useMemo(() => (state?.status === 'ready' && project?.variantOf && state.at && state.now ? mergeVariantUpdate({ ancestor: state.at, base: state.now, variant: project, customers: state.customers }) : null), [state, project]);
  const reload = () => setRev((r) => r + 1);
  if (!v) return { ...NONE, reload };
  if (!state) return { ...NONE, status: 'loading', reload };
  return { ...state, differences, update, reload } as VariantState;
}

/**
 * The components of the working variant that differ from the base, with what differs (for the marks in Design Studio):
 * its own settings, the translations of its texts, and the messages it shows.
 */
export function differingNodes(project: Project, diffs: VariantDifference[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const add = (id: string | undefined, what: string) => { if (id) m.set(id, [...(m.get(id) ?? []), what]); };
  const shows = (partId: string) => project.nodes.filter((n) => n.contentPartId === partId || (n.variantIds ?? []).includes(partId)).map((n) => n.id);
  for (const d of diffs) {
    if (d.nodeId) { add(d.nodeId, d.label); continue; }
    const [root, item] = d.path;
    if (root === 'strings' && typeof item === 'string') { const mm = /^@([^/]+)\//.exec(item); if (mm && mm[1] !== 'title') add(mm[1], d.label); }
    if (root === 'contentParts' && typeof item === 'object') for (const id of shows(item.id)) add(id, d.label);
  }
  return m;
}

/** The marks for Design Studio: empty for a document that is not a variant. */
export function useVariantMarks(project: Project): Map<string, string[]> {
  const vs = useVariant(project.variantOf ? project : null);
  return useMemo(() => (project.variantOf ? differingNodes(project, vs.differences) : new Map()), [project, vs.differences]);
}
