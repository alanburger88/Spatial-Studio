import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { LIBRARY_KINDS, LIBRARY_KIND_HINT, LIBRARY_KIND_LABEL, LINK_STATUS_LABEL, linkStatus, type LibraryContent, type LibraryKind, type LibraryUsage, type Project } from '@iss/model';
import { api, type LibraryItemDto } from '../api/client';
import { Dialog, ErrorState, Loading, ScreenHeader } from '../ui/common';
import { Icon } from '../ui/icons';
import { fmtAbs, When } from '../ui/time';
import { DraftEditor } from './library/DraftEditor';
import { Duplicates } from './library/Duplicates';
import { errorText, useLibrary, useLibraryCan } from './library/libraryData';
import { ContentPreview } from './library/Preview';
import './Library.css';

/**
 * S25 Library: the things many documents share (a brand, building blocks, wording, a glossary, the house wording rules,
 * lookup tables), each in numbered versions. Anyone can look; authors propose items and versions; approvers approve them.
 * A document links to an approved version and is updated only by a reviewed step in the document.
 */
export function Library() {
  const items = useLibrary((s) => s.items);
  const can = useLibraryCan();
  const status = useLibrary((s) => s.status);
  const error = useLibrary((s) => s.error);
  const [params, setParams] = useSearchParams();
  const [kind, setKind] = useState<LibraryKind | ''>('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => { void useLibrary.getState().load(true); }, []);
  const documentId = params.get('document');
  const shown = useMemo(() => items.filter((i) => (!kind || i.kind === kind) && (!q.trim() || `${i.title} ${i.description}`.toLowerCase().includes(q.trim().toLowerCase()))), [items, kind, q]);
  const selectedId = params.get('item') ?? shown[0]?.id ?? null;
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const choose = (id: string) => { const next = new URLSearchParams(params); next.set('item', id); next.delete('document'); next.delete('view'); setParams(next, { replace: true }); };
  const view = params.get('view') === 'duplicates' ? 'duplicates' : 'items';
  const showView = (v: 'items' | 'duplicates') => { const next = new URLSearchParams(params); if (v === 'duplicates') next.set('view', 'duplicates'); else next.delete('view'); next.delete('document'); setParams(next); };

  return (
    <section className="screen lib-screen" data-testid="library-screen">
      <ScreenHeader id="S25" title="Library" subtitle="Brands, building blocks, wording, glossaries, wording rules and lookup tables that many documents share. Each item has numbered versions; an approved version is frozen. Documents link to an approved version and take a newer one only by a reviewed update."
        actions={can.create ? <button className="btn primary sm" onClick={() => setCreating(true)} data-testid="lib-new-item"><Icon.plus width={14} height={14} /> New item</button> : undefined} />
      {/* Two views of the library: its items, and duplicate wording across documents (`?view=duplicates`). */}
      <div className="tabs lib-views" role="tablist" aria-label="Library views">
        <button type="button" role="tab" aria-selected={view === 'items'} onClick={() => showView('items')} data-testid="lib-view-items">Items</button>
        <button type="button" role="tab" aria-selected={view === 'duplicates'} onClick={() => showView('duplicates')} data-testid="lib-view-duplicates">Duplicate wording</button>
      </div>
      {view === 'duplicates' ? <Duplicates /> : <>
      {documentId && <DocumentLinks projectId={documentId} items={items} onClose={() => { const n = new URLSearchParams(params); n.delete('document'); setParams(n, { replace: true }); }} />}
      {status === 'error' ? <ErrorState title="The library could not be loaded" message={error ?? ''} onRetry={() => useLibrary.getState().load(true)} />
        : status !== 'ready' && !items.length ? <Loading label="Reading the library…" />
        : !items.length ? (
          <div className="empty lib-empty" data-testid="lib-empty">
            <strong>The library is empty</strong>
            <span>Open a document and use “Add to library” on a component, a message, the brand (Styles &amp; brand) or the glossary (Content &amp; Translations). Once an approver approves it, every document can use it from “From the library”.</span>
            {can.create && <button className="btn" onClick={() => setCreating(true)} data-testid="lib-empty-new">Or add the first item here</button>}
            <Link to="/projects" className="btn ghost">Go to the projects</Link>
          </div>
        ) : (
          <div className="screen-body workbench lib-body">
            <aside className="panel lib-list" aria-label="Library items" data-side="left" data-side-title="Items">
              <div className="panel-head">Items <span className="sub">{shown.length} of {items.length}</span></div>
              <div className="panel-body lib-filterbox">
                <div className="lib-filters">
                  <label className="sr-only" htmlFor="lib-kind">Kind</label>
                  <select id="lib-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as LibraryKind | '')} data-testid="lib-filter-kind">
                    <option value="">All kinds</option>
                    {LIBRARY_KINDS.map((k) => <option key={k} value={k}>{LIBRARY_KIND_LABEL[k]}</option>)}
                  </select>
                  <label className="sr-only" htmlFor="lib-q">Search</label>
                  <input id="lib-q" className="input" type="search" placeholder="Search names" value={q} onChange={(e) => setQ(e.target.value)} data-testid="lib-search" />
                </div>
              </div>
              <div className="panel-body flush">
                {LIBRARY_KINDS.filter((k) => shown.some((i) => i.kind === k)).map((k) => (
                  <section key={k} aria-label={LIBRARY_KIND_LABEL[k]}>
                    <h2 className="lib-group" title={LIBRARY_KIND_HINT[k]}>{LIBRARY_KIND_LABEL[k]}</h2>
                    <ul className="list-rows">
                      {shown.filter((i) => i.kind === k).map((i) => (
                        <li key={i.id} aria-current={i.id === selectedId ? 'true' : undefined}>
                          <button type="button" className="lib-row" onClick={() => choose(i.id)} data-testid={`lib-item-${i.id}`} aria-pressed={i.id === selectedId}>
                            <span className="lib-row-title">{i.title}</span>
                            <span className="lib-row-meta">
                              {i.latest !== null ? <span className="chip count">v{i.latest}</span> : <span className="muted">not approved yet</span>}
                              {i.draft !== null && <span className="chip warning" data-testid="lib-draft-marker">Draft v{i.draft}</span>}
                              <span className="muted" data-testid="lib-usage">{i.usage.documents} document{i.usage.documents === 1 ? '' : 's'}{i.usage.behind ? `, ${i.usage.behind} behind` : ''}</span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
                {!shown.length && <p className="muted lib-pad">No item matches.</p>}
              </div>
            </aside>
            <div className="lib-detail-wrap">{selected ? <ItemDetail key={selected.id} item={selected} /> : <div className="empty"><strong>Choose an item</strong></div>}</div>
          </div>
        )}
      </>}
      {creating && <DraftEditor item={null} start={null} onClose={() => setCreating(false)} onSaved={choose} />}
    </section>
  );
}

/* ------------------------------------------------------------------ one item */

function ItemDetail({ item }: { item: LibraryItemDto }) {
  const can = useLibraryCan();
  const [usage, setUsage] = useState<LibraryUsage[] | null>(null);
  const [version, setVersion] = useState<number>(item.draft ?? item.latest ?? item.versions[0]?.version ?? 1);
  const [content, setContent] = useState<{ v: number; content: LibraryContent } | null>(null);
  const [editing, setEditing] = useState<null | 'new' | 'draft'>(null);
  const [approving, setApproving] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const reload = async () => { await useLibrary.getState().load(true); };
  useEffect(() => { let live = true; api.libraryItem(item.id).then((r) => { if (live) setUsage(r.usage); }).catch(() => { if (live) setUsage([]); }); return () => { live = false; }; }, [item]);
  useEffect(() => { setVersion(item.draft ?? item.latest ?? item.versions[0]?.version ?? 1); }, [item.draft, item.latest]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true;
    setContent(null);
    api.libraryVersion(item.id, version).then((r) => { if (live) setContent({ v: version, content: r.content }); }).catch(() => undefined);
    return () => { live = false; };
  }, [item.id, version, item.versions[0]?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const v = item.versions.find((x) => x.version === version);
  const act = async (fn: () => Promise<string>) => {
    setBusy(true); setMsg(null);
    try { const text = await fn(); setMsg({ kind: 'ok', text }); await reload(); } catch (e) { setMsg({ kind: 'error', text: errorText(e) }); } finally { setBusy(false); }
  };
  const approve = () => act(async () => { const r = await api.approveLibraryDraft(item.id, note.trim() || undefined); setApproving(false); setNote(''); const behind = r.usage.filter((u) => u.behind).length; return `Version ${r.version} is approved and frozen.${behind ? ` ${behind} document${behind === 1 ? '' : 's'} can now update to it; each reviews the change first.` : ''}`; });
  const discard = () => act(async () => { const r = await api.discardLibraryDraft(item.id); return r.item ? `The draft version ${r.discarded} was discarded.` : 'The draft was discarded. The item had no approved version, so it is gone.'; });
  const draftContent = item.draft !== null && content?.v === item.draft ? content.content : null;
  const latestContent = item.latest !== null && content?.v === item.latest ? content.content : null;
  return (
    <article className="panel lib-detail" aria-labelledby="lib-detail-title" data-testid="lib-detail" data-item={item.id}>
      <div className="panel-head lib-detail-head">
        <h2 id="lib-detail-title" className="lib-detail-title">{item.title}</h2>
        <span className="chip">{LIBRARY_KIND_LABEL[item.kind]}</span>
        {item.latest !== null ? <span className="chip accent" data-testid="lib-latest">Approved v{item.latest}</span> : <span className="chip warning">Not approved yet</span>}
        {item.draft !== null && <span className="chip warning">Draft v{item.draft}</span>}
      </div>
      <div className="panel-body lib-detail-body">
        {item.description && <p>{item.description}</p>}
        <p className="muted lib-small">Added {item.createdBy ? `by ${item.createdBy.name} ` : ''}<When iso={item.createdAt} />{item.source ? <> from <Link to={`/studio/${item.source.projectId}/overview`}>{item.source.projectTitle}</Link></> : ''}.</p>

        <div className="row wrap lib-actions" data-testid="lib-actions">
          {can.create && item.draft === null && <button className="btn sm" onClick={() => setEditing('new')} disabled={busy} data-testid="lib-new-version">New version as a draft</button>}
          {can.create && item.draft !== null && <button className="btn sm" onClick={() => setEditing('draft')} disabled={busy} data-testid="lib-edit-draft">Edit the draft</button>}
          {can.approve && item.draft !== null && <button className="btn sm primary" onClick={() => setApproving(true)} disabled={busy} data-testid="lib-approve">Approve version {item.draft}</button>}
          {(can.create || can.approve) && item.draft !== null && <button className="btn sm ghost" onClick={discard} disabled={busy} data-testid="lib-discard">Discard the draft</button>}
          {!can.create && !can.approve && <span className="muted" data-testid="lib-readonly-role">You can look at the library. Authors add items and versions; approvers approve them.</span>}
          {!can.approve && can.create && item.draft !== null && <span className="muted">An approver approves the draft.</span>}
        </div>
        {msg && <div className={`callout ${msg.kind === 'error' ? 'error' : 'accent'}`} role={msg.kind === 'error' ? 'alert' : 'status'} data-testid="lib-message">{msg.text}</div>}

        <div className="lib-cols">
          <section aria-labelledby="lib-versions-h" className="lib-versions">
            <h3 className="section-title" id="lib-versions-h">Versions</h3>
            <ul className="list-rows" data-testid="lib-versions">
              {item.versions.map((x) => (
                <li key={x.version} aria-current={x.version === version ? 'true' : undefined}>
                  <button type="button" className="lib-row" onClick={() => setVersion(x.version)} aria-pressed={x.version === version} data-testid={`lib-version-${x.version}`}>
                    <span className="lib-row-title">Version {x.version} <span className={`chip ${x.state === 'approved' ? 'accent' : 'warning'}`}>{x.state === 'approved' ? 'Approved' : 'Draft'}</span></span>
                    <span className="lib-row-meta muted">{x.note || 'No note'} · {x.state === 'approved' && x.approvedAt ? <>approved {x.approvedBy ? `by ${x.approvedBy.name} ` : ''}<time dateTime={x.approvedAt} title={fmtAbs(x.approvedAt)}>{fmtAbs(x.approvedAt)}</time></> : <>saved <time dateTime={x.updatedAt}>{fmtAbs(x.updatedAt)}</time></>}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="lib-used-h" className="lib-used">
            <h3 className="section-title" id="lib-used-h">Where it is used</h3>
            {usage === null ? <Loading label="Looking through the documents…" /> : !usage.length ? <p className="muted" data-testid="lib-used-none">No document uses it yet. In a document, use “From the library” to add it.</p> : (
              <ul className="list-rows" data-testid="lib-used">
                {usage.map((u) => (
                  <li key={`${u.projectId}:${u.linkId}`} data-testid="lib-used-doc" data-behind={u.behind ? 'true' : 'false'}>
                    <Link to={`/studio/${u.projectId}/overview`}>{u.title}</Link>
                    <span className="muted"> · version {u.version}</span>
                    {u.behind ? <span className="chip info" style={{ marginLeft: 6 }}>Behind: version {item.latest} is approved</span> : <span className="chip" style={{ marginLeft: 6 }}>Up to date</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section aria-labelledby="lib-preview-h" className="lib-preview">
          <h3 className="section-title" id="lib-preview-h">Version {version}{v ? ` · ${v.state === 'approved' ? 'approved' : 'draft'}` : ''}</h3>
          {!content || content.v !== version ? <Loading label="Loading this version…" /> : <ContentPreview kind={item.kind} content={content.content} hostProjectId={item.source?.projectId ?? usage?.[0]?.projectId ?? null} />}
        </section>
      </div>
      {editing && <DraftEditor item={item} start={editing === 'draft' ? draftContent : latestContent} onClose={() => setEditing(null)} onSaved={() => undefined} />}
      {approving && (
        <Dialog title={`Approve version ${item.draft} of “${item.title}”?`} onClose={() => setApproving(false)} labelledBy="lib-approve-title"
          footer={<><button className="btn" onClick={() => setApproving(false)}>Cancel</button><button className="btn primary" onClick={approve} disabled={busy} data-testid="lib-approve-confirm">Approve and freeze</button></>}>
          <p>Once approved, this version is frozen: nothing can change it, and a change is a new version. Documents that use an earlier version are not changed; each sees “Update available” and reviews the change before taking it.</p>
          <label className="field">Note (optional)<input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} data-testid="lib-approve-note" /></label>
        </Dialog>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ one document's links (from Overview) */

function DocumentLinks({ projectId, items, onClose }: { projectId: string; items: LibraryItemDto[]; onClose: () => void }) {
  const [project, setProject] = useState<Project | null>(null);
  useEffect(() => { void api.project(projectId).then((r) => setProject(r.project)).catch(() => undefined); }, [projectId]);
  if (!project) return null;
  const links = project.libraryLinks ?? [];
  const where = (k: LibraryKind) => (k === 'glossary' ? 'content' : k === 'lookup-table' ? 'lookup-tables' : 'design');
  return (
    <section className="callout lib-doclinks" aria-labelledby="lib-doclinks-h" data-testid="lib-document-links">
      <div className="row"><h2 className="lib-subh" id="lib-doclinks-h">Library items used by “{project.title}” (last saved version)</h2><button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close this list"><Icon.close width={14} height={14} /></button></div>
      {!links.length ? <p className="muted">This document uses nothing from the library.</p> : (
        <ul className="list-rows">
          {links.map((l) => {
            const st = linkStatus(l, items);
            return (
              <li key={l.linkId} data-testid="lib-document-link" data-status={st}>
                <strong>{l.title}</strong> <span className="muted">· {LIBRARY_KIND_LABEL[l.kind]} · version {l.version}</span>{' '}
                <span className={`chip ${st === 'behind' ? 'info' : st === 'not-in-library' ? 'warning' : ''}`}>{LINK_STATUS_LABEL[st]}</span>{' '}
                <Link to={`/studio/${project.projectId}/${where(l.kind)}`}>Open in the document</Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
