import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { currentRelease, type Role } from '@iss/model';
import { ApiFailure, api, type ProjectReleasesDto, type ReleaseDetailDto } from '../api/client';
import { useStudio } from '../state/store';
import { Empty, ErrorState, Loading, ScreenHeader } from '../ui/common';
import { useWorkflow } from '../shell/workflow';
import { LiveCards } from './releases/LiveCards';
import { ReleaseList } from './releases/ReleaseList';
import { ReleaseDetail } from './releases/ReleaseDetail';
import { ReviewLinksPanel } from './releases/ReviewLinks'; // review links (wave 4)
import './Releases.css';

/**
 * Releases (S18): the frozen, numbered copies of this document made when it was approved, what is live in Test and
 * Production, the package to hand to the receiving team and the log of what they said. Everything is read from the
 * releases API (docs/api/RELEASES.md); who may do what comes from the shared rules in @iss/model.
 */
export function Releases() {
  const project = useStudio((s) => s.project)!;
  const savedVersion = useStudio((s) => s.serverVersion);
  const session = useStudio((s) => s.session);
  const wf = useWorkflow((s) => (s.wf && s.wf.projectId === project.projectId ? s.wf : null));
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<ProjectReleasesDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  const onChanged = useCallback(() => setRev((r) => r + 1), []);
  // With sign-in off everyone is the built-in local admin (as everywhere in the studio).
  const role: Role | null = session?.authEnabled ? session.user?.role ?? null : 'admin';

  // The list: again whenever something here changes, a version is saved or the review state moves (approving makes a release).
  useEffect(() => {
    let live = true;
    api.projectReleases(project.projectId)
      .then((d) => { if (live) { setData(d); setError(null); } })
      .catch((e) => { if (live) setError(e instanceof ApiFailure ? e.message : 'The releases could not be loaded.'); });
    return () => { live = false; };
  }, [project.projectId, rev, savedVersion, wf?.state, wf?.updatedAt]);

  const releases = data?.releases ?? [];
  const asked = Number(params.get('release'));
  const selected = useMemo(() => releases.find((r) => r.number === asked) ?? releases[0] ?? null, [releases, asked]);
  const select = (n: number) => setParams((p) => { const next = new URLSearchParams(p); next.set('release', String(n)); return next; }, { replace: true });

  // The selected release in full: its stage history, handover log and what the caller may do.
  const [detail, setDetail] = useState<ReleaseDetailDto | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const selectedId = selected?.id ?? null;
  useEffect(() => { setDetail(null); setDetailError(null); }, [selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    let live = true;
    api.release(selectedId)
      .then((d) => { if (live) { setDetail(d); setDetailError(null); } })
      .catch((e) => { if (live) setDetailError(e instanceof ApiFailure ? e.message : 'The release could not be loaded.'); });
    return () => { live = false; };
  }, [selectedId, rev]);

  const [creating, setCreating] = useState(false);
  const create = async () => {
    setCreating(true);
    try {
      const res = await api.createRelease(project.projectId);
      useStudio.getState().toast({ kind: res.created ? 'success' : 'info', title: res.created ? `Release ${res.release.number} created` : 'No new release', message: res.message });
      if (res.created) select(res.release.number);
      onChanged();
    } catch (e) {
      useStudio.getState().toast({ kind: 'error', title: 'No release was created', message: e instanceof ApiFailure ? e.message : 'That did not work.' });
    } finally { setCreating(false); }
  };

  const latest = releases[0] ?? null;
  const production = currentRelease(releases, 'production');
  const test = currentRelease(releases, 'test');
  const state = wf?.state ?? null;
  const next = latest ? latest.number + 1 : 1;
  const changedHint = state === 'in_review'
    ? `It is in review: approving it creates release ${next}.`
    : state === 'approved' || state === 'published'
      ? (data?.create.allowed ? `It is approved: create release ${next} from the approved version.` : `It is approved, but ${data?.create.reason?.replace(/\.$/, '') ?? 'no release can be made from it yet'}.`)
      : `To release it, submit it for review and approve it: approving creates release ${next}.`;

  const createButton = data?.create.allowed ? (
    <button type="button" className="btn primary" data-testid="rel-create" disabled={creating} onClick={create}>{creating ? 'Creating…' : 'Create a release from the approved version'}</button>
  ) : null;

  return (
    <section className="screen" data-testid="releases-screen">
      <ScreenHeader id="S18" title="Releases" subtitle="Approved, frozen versions of this document, their stage and the package to hand over." />
      <div className={`screen-body rel-body${releases.length ? '' : ' single'}`}>
        {error && !data ? <ErrorState title="Releases could not be loaded" message={error} onRetry={onChanged} />
          : !data ? <Loading label="Loading releases…" />
          : releases.length === 0 ? (
            <div className="rel-main" data-testid="rel-empty">
              <LiveCards production={null} test={null} latest={null} savedVersion={savedVersion} selected={null} onSelect={select} changedHint={null} />
              <Empty title="This document has no release yet"
                message="A release is made when an approver approves the document: the approved version is frozen as release 1 at Test, ready to hand to the team that produces the documents. Submit the document for review, then approve it from the review panel.">
                {createButton ?? (state === 'approved' || state === 'published'
                  ? <p className="muted" data-testid="rel-create-why">{data.create.reason ?? 'This document is approved but has no release.'}</p>
                  : <p className="muted" data-testid="rel-state-now">{state ? `This document is ${(wf?.label ?? state).toLowerCase()} now.` : 'This document is not approved.'}</p>)}
              </Empty>
            </div>
          ) : (
            <>
              <div className="rel-main">
                <LiveCards production={production} test={test} latest={latest} savedVersion={savedVersion} selected={selected?.number ?? null} onSelect={select} changedHint={changedHint} />
                <div className="panel rel-listpanel">
                  <div className="panel-head">
                    <h2 className="section-title">All releases <span className="chip count">{releases.length}</span></h2>
                    <div className="right">{createButton}</div>
                  </div>
                  {data.create.allowed === false && data.create.reason && state && (state === 'approved' || state === 'published') && <p className="muted rel-create-why" data-testid="rel-create-why">{data.create.reason}</p>}
                  {Number.isFinite(asked) && asked > 0 && !releases.some((r) => r.number === asked) && <p className="muted rel-create-why" role="status">There is no release {asked}: showing release {selected?.number}.</p>}
                  <div className="panel-body flush"><ReleaseList releases={releases} selected={selected?.number ?? null} onSelect={select} /></div>
                </div>
                <ReviewLinksPanel projectId={project.projectId} />
              </div>
              <aside className="panel rel-detail" aria-label="Release details" data-side="right" data-side-title="Release details">
                <div className="panel-body">
                  {detailError ? <ErrorState title="This release could not be loaded" message={detailError} onRetry={onChanged} />
                    : !detail ? <Loading label="Loading release…" />
                    : <ReleaseDetail detail={detail} releases={releases} role={role} onChanged={onChanged} />}
                </div>
              </aside>
            </>
          )}
      </div>
    </section>
  );
}
