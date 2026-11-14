import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  LIBRARY_KIND_LABEL, LINK_STATUS_LABEL, libraryContentFromProject,
  type Command, type LibraryKind, type LibraryLink, type LibraryPlacement,
} from '@iss/model';
import { COMPARISON_OUTCOME_LABEL } from '@iss/scenarios';
import { api, type LibraryImpactDto, type LibraryItemDto } from '../../api/client';
import { useCan, useStudio } from '../../state/store';
import { Dialog, Loading } from '../../ui/common';
import { Icon } from '../../ui/icons';
import { approvedOf, errorText, itemFromSource, useLibrary, useLibraryItems, useLinkStatus } from './libraryData';
import '../Library.css';

/**
 * The pieces every screen uses for the shared library: the "Library · title · v3" chip on linked content, the read-only
 * notice with Unlink and Update available, the update dialog with its impact, "Add to library" and "From the library".
 * Every change to a document goes through the command bus as one undoable step.
 */

/** "Library · Contact panel · v3", with "Update available" or "Not in this library" when that is so. */
export function LibraryChip({ link }: { link: LibraryLink }) {
  const { status } = useLinkStatus(link);
  return (
    <span className="lib-chipwrap" data-testid="lib-chip" data-status={status ?? 'loading'} data-item={link.itemId}>
      <span className="chip accent lib-chip" title={`${LIBRARY_KIND_LABEL[link.kind]} from the shared library, version ${link.version}. It is read-only here.`}>
        <Icon.lock width={11} height={11} aria-hidden="true" /> Library · {link.title} · v{link.version}
      </span>
      {status && status !== 'current' && <span className={`chip ${status === 'behind' ? 'info' : 'warning'}`} data-testid="lib-chip-status">{LINK_STATUS_LABEL[status]}</span>}
    </span>
  );
}

/** The read-only notice for linked content: what it is, Unlink, and Update available when a newer approved version exists. */
export function LinkedNotice({ link, what }: { link: LibraryLink; what: string }) {
  const { status, latest } = useLinkStatus(link);
  const [updating, setUpdating] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const canEdit = useCan('edit');
  const unlink = () => { if (useStudio.getState().dispatch({ type: 'UNLINK_LIBRARY_ITEM', linkId: link.linkId }).ok) { setConfirmUnlink(false); useStudio.getState().toast({ kind: 'success', title: 'Unlinked from the library', message: `${what} is now this document’s own. Undo puts the link back.` }); } };
  return (
    <div className="callout lib-notice" data-testid="lib-linked-notice" data-link={link.linkId}>
      <div className="row wrap" style={{ gap: 6 }}><LibraryChip link={link} /></div>
      <p className="lib-notice-text" data-testid="lib-readonly-note">
        {what} comes from the shared library and is read-only in this document.{' '}
        {status === 'not-in-library' ? 'This studio’s library does not have it (it came with a file), so it can only be unlinked.' : 'Change it in the library, or unlink it to make it this document’s own.'}
      </p>
      <div className="row wrap" style={{ gap: 6 }}>
        {status === 'behind' && latest !== null && <button type="button" className="btn sm primary" onClick={() => setUpdating(true)} disabled={!canEdit} data-testid="lib-update-available">Update available: version {latest}</button>}
        <button type="button" className="btn sm" onClick={() => setConfirmUnlink(true)} disabled={!canEdit} data-testid="lib-unlink">Unlink</button>
        {status !== 'not-in-library' && <Link className="btn sm ghost" to={`/library?item=${encodeURIComponent(link.itemId)}`} data-testid="lib-open-item">Open in the library</Link>}
      </div>
      {updating && latest !== null && <UpdateDialog link={link} version={latest} onClose={() => setUpdating(false)} />}
      {confirmUnlink && (
        <Dialog title={`Unlink “${link.title}”?`} onClose={() => setConfirmUnlink(false)} labelledBy="lib-unlink-title"
          footer={<><button className="btn" onClick={() => setConfirmUnlink(false)}>Keep the link</button><button className="btn primary" onClick={unlink} data-testid="lib-unlink-confirm">Unlink</button></>}>
          <p>The content stays exactly as it is and becomes this document’s own, so it can be edited here. It will no longer receive updates from the library. Undo puts the link back.</p>
        </Dialog>
      )}
    </div>
  );
}

/** Opens a newer approved version: the change, which synthetic customers would see something different, then applying it. */
export function UpdateDialog({ link, version, onClose }: { link: LibraryLink; version: number; onClose: () => void }) {
  const project = useStudio((s) => s.project)!;
  const [impact, setImpact] = useState<LibraryImpactDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.libraryImpact(link.itemId, { projectId: project.projectId, version, linkId: link.linkId, project })
      .then((r) => { if (live) setImpact(r); }).catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link.itemId, link.linkId, version]);
  const changed = impact ? impact.comparison.customers.filter((c) => c.outcome !== 'same') : [];
  const apply = () => {
    if (!impact) return;
    const r = useStudio.getState().dispatch({ type: 'UPDATE_LIBRARY_LINK', linkId: link.linkId, version, content: impact.content, title: link.title });
    if (r.ok) { useStudio.getState().toast({ kind: 'success', title: `Updated to version ${version}`, message: `“${link.title}” in this document now matches the library. One undo step; save and review the document as usual.` }); onClose(); }
  };
  return (
    <Dialog title={`Update “${link.title}” to version ${version}`} onClose={onClose} labelledBy="lib-update-title"
      footer={<><button className="btn" onClick={onClose}>Not now</button><button className="btn primary" onClick={apply} disabled={!impact} data-testid="lib-update-apply">Apply the update</button></>}>
      <div className="lib-update" data-testid="lib-update-dialog">
        {error ? <div className="callout error" role="alert" data-testid="lib-update-error">{error}</div> : !impact ? <Loading label="Working out the impact on the synthetic customers…" /> : (
          <>
            <p className="lib-impact-count" data-testid="lib-impact-count" data-changed={changed.length} data-evaluated={impact.comparison.evaluated}>
              <strong>{changed.length} of {impact.comparison.evaluated} synthetic customers</strong> would see something different{impact.comparison.styleChanged ? ', and the look of every page may change' : ''}.
            </p>
            <section aria-labelledby="lib-changes-h">
              <h3 className="section-title" id="lib-changes-h">What changes in the document</h3>
              <ul className="lib-bullets" data-testid="lib-impact-changes">{impact.changes.flatMap((s) => s.items.map((it, i) => <li key={`${s.title}-${i}`}>{it}</li>))}</ul>
            </section>
            <section aria-labelledby="lib-diff-h">
              <h3 className="section-title" id="lib-diff-h">What customers would see differently</h3>
              {changed.length === 0 ? <p className="muted" data-testid="lib-impact-none">No synthetic customer would see a difference.</p> : (
                <ul className="list-rows lib-impact-list" data-testid="lib-impact-list">
                  {changed.slice(0, 8).map((c) => (
                    <li key={c.recordId}>
                      <div className="row" style={{ gap: 6 }}><strong>{c.name}</strong><span className="chip">{COMPARISON_OUTCOME_LABEL[c.outcome]}</span></div>
                      <ul className="lib-bullets">{c.changes.slice(0, 3).map((x, i) => <li key={i}><span className="muted">{x.name}:</span> {x.before ? <><del>{clip(x.before)}</del> → </> : ''}<ins>{clip(x.after) || 'not shown'}</ins></li>)}</ul>
                    </li>
                  ))}
                  {changed.length > 8 && <li className="muted">…and {changed.length - 8} more synthetic customers</li>}
                </ul>
              )}
            </section>
            <p className="muted lib-small">Applying it is one undoable step. The document then goes through its own review and approval like any other change.</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The command that links a document to an approved version in place of the thing the item was made from. */
export function linkInPlace(item: Pick<LibraryItemDto, 'id' | 'kind' | 'title'>, version: number, content: unknown, ref: string): Command {
  const placement: LibraryPlacement | undefined = item.kind === 'block' ? { replaceNodeId: ref } : item.kind === 'wording' ? { partId: ref } : item.kind === 'lookup-table' ? { tableId: ref } : undefined;
  return { type: 'LINK_LIBRARY_ITEM', item: { id: item.id, kind: item.kind, title: item.title }, version, content, ...(placement ? { placement } : {}) };
}

/**
 * "Add to library": the document's content (as it is now, saved or not) becomes the first draft of a new item, or the
 * next draft of the item it was first taken from. Once approved, the document can link to it in place.
 */
export function AddToLibraryDialog({ kind, refId, defaultTitle, onClose }: { kind: LibraryKind; refId: string; defaultTitle: string; onClose: () => void }) {
  const project = useStudio((s) => s.project)!;
  const { items, can } = useLibraryItems();
  const existing = itemFromSource(items, kind, project.projectId, refId);
  const [mode, setMode] = useState<'new' | 'version'>(existing ? 'version' : 'new');
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ item: LibraryItemDto; version: number } | null>(null);
  const taken = useMemo(() => libraryContentFromProject(project, kind, refId), [project, kind, refId]);
  useEffect(() => { if (existing && mode === 'new' && !done) setMode('version'); }, [existing?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if ('error' in taken) return;
    setBusy(true); setError(null);
    try {
      if (mode === 'version' && existing) {
        const r = await api.saveLibraryDraft(existing.id, { content: taken.content, note: note.trim() || undefined });
        setDone({ item: r.item, version: r.version });
      } else {
        const r = await api.createLibraryItem({ kind, title: title.trim(), description: description.trim() || undefined, note: note.trim() || undefined, content: taken.content, source: { projectId: project.projectId, ref: refId } });
        setDone({ item: r.item, version: 1 });
      }
      await useLibrary.getState().load(true);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const approveAndLink = async () => {
    if (!done) return;
    setBusy(true); setError(null);
    try {
      await api.approveLibraryDraft(done.item.id);
      const v = await api.libraryVersion(done.item.id, 'latest');
      await useLibrary.getState().load(true);
      const r = useStudio.getState().dispatch(linkInPlace(done.item, v.version.version, v.content, refId));
      if (r.ok) { useStudio.getState().toast({ kind: 'success', title: 'Approved and linked', message: `This document now uses “${done.item.title}” version ${v.version.version} from the library.` }); onClose(); }
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog title={`Add to the library: ${LIBRARY_KIND_LABEL[kind].toLowerCase()}`} onClose={onClose} labelledBy="lib-add-title-h"
      footer={done
        ? <>{can.approve && <button className="btn primary" onClick={approveAndLink} disabled={busy} data-testid="lib-add-approve-link">Approve and link this document</button>}<button className="btn" onClick={onClose} data-testid="lib-add-close">Close</button></>
        : <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={busy || 'error' in taken || (mode === 'new' && title.trim().length < 2)} data-testid="lib-add-save">{mode === 'version' ? 'Save as a new draft version' : 'Add to the library'}</button></>}>
      <div className="lib-form" data-testid="lib-add-dialog">
        {'error' in taken ? <div className="callout warning" role="alert">{taken.error}</div> : done ? (
          <div className="callout accent" role="status" data-testid="lib-add-done">
            <strong>“{done.item.title}” version {done.version} is a draft in the library.</strong>{' '}
            {can.approve ? 'Approve it to freeze it and link this document to it, or leave it for another approver.' : 'An approver approves it; then this document can link to it from here.'}
          </div>
        ) : (
          <>
            <p className="muted">The {LIBRARY_KIND_LABEL[kind].toLowerCase()} is copied from this document as it is now. It becomes a draft that an approver approves; then any document can use it, read-only, and receive its updates.</p>
            {existing && (
              <fieldset className="lib-choice">
                <legend>This was added to the library before, as “{existing.title}”</legend>
                <label><input type="radio" checked={mode === 'version'} onChange={() => setMode('version')} data-testid="lib-add-as-version" /> Save it as the next version of “{existing.title}”</label>
                <label><input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> Add it as a new item</label>
              </fieldset>
            )}
            {mode === 'new' && (
              <>
                <label className="field">Name<input className="input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} data-testid="lib-add-title" /></label>
                <label className="field">What it is for (optional)<input className="input" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} data-testid="lib-add-description" /></label>
              </>
            )}
            <label className="field">Note for the approver (optional)<input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} data-testid="lib-add-note" /></label>
          </>
        )}
        {error && <div className="callout error" role="alert" data-testid="lib-add-error">{error}</div>}
      </div>
    </Dialog>
  );
}

/** "From the library": approved items of one kind, newest version of each; picking one fetches its content. */
export function PickFromLibraryDialog({ kind, title, hint, onPick, onClose }: { kind: LibraryKind; title: string; hint: string; onPick: (item: LibraryItemDto, version: number, content: unknown) => boolean; onClose: () => void }) {
  const { items, ready } = useLibraryItems();
  const list = approvedOf(items, kind);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void useLibrary.getState().load(true); }, []);
  const pick = async (item: LibraryItemDto) => {
    setBusy(item.id); setError(null);
    try {
      const v = await api.libraryVersion(item.id, 'latest');
      if (onPick(item, v.version.version, v.content)) onClose();
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };
  return (
    <Dialog title={title} onClose={onClose} labelledBy="lib-pick-title">
      <div className="lib-pick" data-testid="lib-pick-dialog">
        <p className="muted">{hint}</p>
        {!ready ? <Loading label="Reading the library…" /> : list.length === 0 ? (
          <div className="empty" data-testid="lib-pick-empty"><strong>No approved {LIBRARY_KIND_LABEL[kind].toLowerCase()} in the library yet</strong><span>Add one from a document with “Add to library”; once an approver approves it, it is listed here.</span></div>
        ) : (
          <ul className="list-rows lib-pick-list">
            {list.map((i) => (
              <li key={i.id}>
                <button type="button" className="lib-pick-item" onClick={() => pick(i)} disabled={!!busy} data-testid={`lib-pick-item-${i.id}`}>
                  <span className="grow"><strong>{i.title}</strong>{i.description && <span className="muted"> · {i.description}</span>}</span>
                  <span className="chip count">v{i.latest}</span>
                  {busy === i.id && <span className="spinner" aria-hidden="true" />}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <div className="callout error" role="alert" data-testid="lib-pick-error">{error}</div>}
      </div>
    </Dialog>
  );
}

/**
 * For something in the document that is not linked: "Add to library", and, when it was added before and an approved
 * version exists, "Link to the approved version" (it then becomes read-only here).
 */
export function NotLinkedActions({ kind, refId, defaultTitle, label }: { kind: LibraryKind; refId: string; defaultTitle: string; label: string }) {
  const project = useStudio((s) => s.project)!;
  const { items, can } = useLibraryItems();
  const canEdit = useCan('edit');
  const [adding, setAdding] = useState(false);
  const source = itemFromSource(items, kind, project.projectId, refId);
  const linkSource = async () => {
    if (!source || source.latest === null) return;
    try {
      const v = await api.libraryVersion(source.id, 'latest');
      if (useStudio.getState().dispatch(linkInPlace(source, v.version.version, v.content, refId)).ok) useStudio.getState().toast({ kind: 'success', title: 'Linked to the library', message: `This document now uses “${source.title}” version ${v.version.version}. It is read-only here.` });
    } catch (e) { useStudio.getState().toast({ kind: 'error', title: 'Could not link', message: errorText(e) }); }
  };
  return (
    <div className="row wrap lib-actions" style={{ gap: 6 }}>
      {source && source.latest !== null && <button type="button" className="btn sm primary" onClick={linkSource} disabled={!canEdit} data-testid="lib-link-source" title={`Use the approved version ${source.latest} of “${source.title}” here, read-only`}>Link to “{source.title}” v{source.latest}</button>}
      <button type="button" className="btn sm" onClick={() => setAdding(true)} disabled={!can.create && !canEdit} data-testid="lib-add-open" title={`Put ${label} in the shared library so other documents can use it`}>
        <Icon.plus width={13} height={13} /> Add to library
      </button>
      {adding && <AddToLibraryDialog kind={kind} refId={refId} defaultTitle={defaultTitle} onClose={() => setAdding(false)} />}
    </div>
  );
}
