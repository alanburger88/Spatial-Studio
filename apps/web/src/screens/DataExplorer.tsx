import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { editBlockedReason, useCan, useStudio } from '../state/store';
import { Dialog, Empty, ScreenHeader } from '../ui/common';
import { CustomerList } from './data/CustomerList';
import { blankRecord, problemsFor, recordName } from './data/explorerModel';
import { Workspace } from './data/Workspace';
import './DataExplorer.css';

/** Data Explorer (S16): see, edit, add and remove the customers this document is tested with, as whole nested records. */
export function DataExplorer() {
  const project = useStudio((s) => s.project)!;
  const records = useStudio((s) => s.records);
  const personas = useStudio((s) => s.personas);
  const ctxRecord = useStudio((s) => s.ctx.recordId);
  const blockedReason = useStudio((s) => editBlockedReason(s.session));
  const canEdit = useCan('edit');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const dirtyRef = useRef(false);
  const [pending, setPending] = useState<null | { run: () => void }>(null);
  const [busy, setBusy] = useState(false);

  const wanted = params.get('customer');
  // Opened from a blocker: `blocker=<id>&highlight=<path,path>` (kept for the customer it was opened on, and its editable copy).
  const blockerId = params.get('blocker');
  const highlightParam = params.get('highlight') ?? '';
  const highlight = useMemo(() => highlightParam.split(',').map((x) => x.trim()).filter(Boolean), [highlightParam]);
  const selectedId = records.some((r) => r.recordId === wanted) ? wanted! : records.some((r) => r.recordId === ctxRecord) ? ctxRecord : records[0]?.recordId ?? '';
  const saved = records.find((r) => r.recordId === selectedId);

  const broken = useMemo(() => new Set(records.filter((r) => problemsFor(r, project).length > 0).map((r) => r.recordId)), [records, project]);

  const onDirty = useCallback((d: boolean) => { dirtyRef.current = d; }, []);
  /** Run something that leaves the customer being edited; ask first when there are unsaved edits. */
  const guard = useCallback((run: () => void) => { if (dirtyRef.current) setPending({ run }); else run(); }, []);
  const show = useCallback((id: string) => setParams({ customer: id }, { replace: true }), [setParams]);

  // Leaving the screen with unsaved edits: in-app links ask first, and closing the tab warns.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.origin !== window.location.origin || a.pathname === window.location.pathname) return;
      e.preventDefault(); e.stopPropagation();
      const to = a.pathname + a.search + a.hash;
      setPending({ run: () => navigate(to) });
    };
    const onUnload = (e: BeforeUnloadEvent) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } };
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onUnload);
    return () => { document.removeEventListener('click', onClick, true); window.removeEventListener('beforeunload', onUnload); };
  }, [navigate]);

  const toastError = (title: string, e: unknown) => useStudio.getState().toast({ kind: 'error', title, message: e instanceof Error ? e.message : undefined });
  const add = async (body: { record?: unknown; copyOf?: string }, done: string, keepBlocker = false) => {
    setBusy(true);
    try {
      const r = await api.addRecord(project.projectId, body);
      await useStudio.getState().refreshRecords();
      if (keepBlocker && blockerId) setParams({ customer: r.record.recordId, blocker: blockerId, ...(highlightParam ? { highlight: highlightParam } : {}) }, { replace: true });
      else show(r.record.recordId);
      useStudio.getState().toast({ kind: 'success', title: done, message: recordName(r.record) });
    } catch (e) { toastError('The customer was not added', e); } finally { setBusy(false); }
  };
  const makeCopy = (id: string) => void add({ copyOf: id }, 'Editable copy made', true);
  const newBlank = () => guard(() => void add({ record: blankRecord(project) }, 'New customer added'));
  const newCopy = () => guard(() => void add({ copyOf: selectedId }, 'Copy added'));
  const deleted = async (id: string) => {
    const order = records.map((r) => r.recordId);
    await useStudio.getState().refreshRecords();
    const left = useStudio.getState().records.map((r) => r.recordId);
    const next = order.slice(order.indexOf(id) + 1).find((x) => left.includes(x)) ?? left[0];
    if (next) show(next);
  };
  const preview = (id: string) => { useStudio.getState().setCtx({ recordId: id, overrides: {}, journeyCursor: null }); navigate(`/studio/${project.projectId}/design`); };

  return (
    <section className="screen" data-testid="data-explorer">
      <ScreenHeader id="S16" title="Data Explorer" subtitle="See, edit, add and remove the customers this document is tested with. Each customer is shown the way the data is built: sections inside sections, with lists such as transactions inside them. Sample customers are shared by every document, so make an editable copy to change one." />
      <div className="screen-body dx-body">
        {records.length === 0 || !saved ? (
          <div className="dx-wide"><Empty title="No customers for this document" message="Generate test customers from Rules & Data, or import some." /></div>
        ) : (
          <>
            <CustomerList records={records} personas={personas} selectedId={selectedId} onSelect={(id) => { if (id !== selectedId) guard(() => show(id)); }} broken={broken}
              canEdit={canEdit && !busy} disabledReason={blockedReason} onNewBlank={newBlank} onNewCopy={newCopy} />
            <Workspace key={`${project.projectId}:${saved.recordId}`} project={project} saved={saved} canEdit={canEdit} blockedReason={blockedReason}
              onDirty={onDirty} onMakeCopy={makeCopy} onDeleted={(id) => void deleted(id)} onPreview={preview}
              highlight={blockerId && saved.recordId === wanted ? highlight : undefined} blockerId={saved.recordId === wanted ? blockerId : null} />
          </>
        )}
      </div>
      {pending && (
        <Dialog title="Leave without saving?" onClose={() => setPending(null)} labelledBy="dx-leave-title"
          footer={<><button type="button" className="btn" data-testid="dx-leave-stay" onClick={() => setPending(null)}>Keep editing</button><button type="button" className="btn danger" data-testid="dx-leave-discard" onClick={() => { const p = pending; dirtyRef.current = false; setPending(null); p.run(); }}>Discard changes</button></>}>
          <p data-testid="dx-leave-dialog">You have changes to {recordName(saved)} that are not saved. If you leave now they will be lost.</p>
        </Dialog>
      )}
    </section>
  );
}
