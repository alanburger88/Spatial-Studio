import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BlockerLink } from '@iss/scenarios';
import { useStudio } from '../state/store';
import { useSaveFlow } from '../state/saveFlow';
import { Dialog } from '../ui/common';
import { fmtAbs, fmtWhen } from '../ui/time';
import { KIND_SHORT, plural } from '../screens/blockers/labels';
import { blockerPath } from '../screens/blockers/link';
import './save-dialogs.css';

/**
 * Two dialogs about saving (a separate download, mounted only while one is open):
 * - "This save adds a blocker" (blockers phase 6): the new causes, how many customers each stops, where each is fixed;
 *   Go back (focused) or Save anyway.
 * - "A newer version was saved first" (wave 4, who else is editing): who saved the newer version and when, and the
 *   choices: load their version (your unsaved edits are lost), or keep editing and compare in Before & after.
 */
export function SaveDialogs() {
  const warning = useSaveFlow((s) => s.warning);
  const conflict = useStudio((s) => s.saveConflict);
  const projectId = useStudio((s) => s.project?.projectId);
  if (warning) return <SaveWarningDialog />;
  if (conflict && conflict.projectId === projectId) return <SaveConflictDialog />;
  return null;
}
export default SaveDialogs;

/** Where a cause is fixed, the way the Blockers screen opens it. */
function useOpenFix() {
  const navigate = useNavigate();
  return (link: BlockerLink | null, blockerId: string) => {
    const st = useStudio.getState();
    const p = st.project;
    if (!p) return;
    const base = `/studio/${p.projectId}`;
    if (!link) { navigate(blockerPath(p.projectId, blockerId)); return; }
    if (link.nodeId && p.nodes.some((n) => n.id === link.nodeId)) st.select(link.nodeId);
    if (link.view === 'data') navigate(`${base}/data${link.recordId ? `?customer=${encodeURIComponent(link.recordId)}` : ''}`);
    else navigate(`${base}/${link.view}${link.view === 'rules-data' && link.ruleId ? `?rule=${encodeURIComponent(link.ruleId)}` : ''}`);
  };
}

function SaveWarningDialog() {
  const w = useSaveFlow((s) => s.warning)!;
  const answer = useSaveFlow((s) => s.answer);
  const projectId = useStudio((s) => s.project?.projectId ?? '');
  const goBack = useRef<HTMLButtonElement>(null);
  const openFix = useOpenFix();
  const navigate = useNavigate();
  // Go back is the default: focused once the dialog has placed its own focus.
  useEffect(() => { const t = window.setTimeout(() => goBack.current?.focus(), 0); return () => window.clearTimeout(t); }, []);
  const n = w.causes.length;
  const back = () => answer(false);
  return (
    <Dialog title={<span data-testid="save-warning-title">{n === 1 ? 'This save adds a blocker' : `This save adds ${n} blockers`}</span>} onClose={back} labelledBy="save-warning-h"
      footer={<>
        <button type="button" className="btn" onClick={() => answer(true)} data-testid="save-warning-save">Save anyway</button>
        <button type="button" className="btn primary" ref={goBack} onClick={back} data-testid="save-warning-back">Go back</button>
      </>}>
      <div data-testid="save-warning" data-count={n}>
        <p className="sw-lead">The last saved version does not have {n === 1 ? 'this problem' : 'these problems'}. {n === 1 ? 'It stops' : 'They stop'} customers being issued the document until {n === 1 ? 'it is' : 'they are'} fixed. You can still save: approval is where blockers stop a document.</p>
        <ul className="sw-list list-rows">
          {w.causes.map((c) => (
            <li key={c.id} className="sw-cause" data-testid="save-warning-cause" data-blocker={c.id} data-kind={c.kind} data-count={c.customers}>
              <div className="sw-head">
                <span className="chip">{KIND_SHORT[c.kind]}</span>
                <strong className="sw-title">{c.title}</strong>
              </div>
              <div className="sw-meta">
                <span className="chip count" data-testid="save-warning-customers">{c.customers === 0 ? 'no customer stopped yet' : `stops ${c.customers} of ${plural(w.checked, 'synthetic customer')}`}</span>
                <button type="button" className="linkbtn" onClick={() => { back(); openFix(c.link, c.id); }} data-testid="save-warning-open">{c.link?.label ?? 'Open where this is fixed'}</button>
                <button type="button" className="linkbtn" onClick={() => { back(); navigate(blockerPath(projectId, c.id)); }} data-testid="save-warning-blockers">See it in Blockers</button>
              </div>
            </li>
          ))}
        </ul>
        <p className="muted sw-note" data-testid="save-warning-scope">
          This check covers rules, wording, translations and data{w.days > 1 ? `, on each of the ${w.days} days approval checks` : ''}, for {plural(w.checked, 'synthetic customer')}. Layout and PDF problems are not part of it: they need the pages to be composed, so run the full check on the Blockers screen for those.
        </p>
      </div>
    </Dialog>
  );
}

function SaveConflictDialog() {
  const c = useStudio((s) => s.saveConflict)!;
  const session = useStudio((s) => s.session);
  const projectId = useStudio((s) => s.project?.projectId ?? '');
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const close = () => useStudio.getState().clearSaveConflict();
  const me = session?.user?.name ?? null;
  const authOn = !!session?.authEnabled;
  // With sign-in off everyone is the local admin, so the other saver can only be named as another window.
  const who = !c.savedBy ? 'Someone' : !authOn ? 'Another window' : c.savedBy === me ? 'You, in another window,' : c.savedBy;
  const load = async () => {
    setBusy(true);
    try { await useStudio.getState().discardChanges(); } finally { setBusy(false); }
  };
  const compare = () => { close(); navigate(`/studio/${projectId}/compare?before=v${c.theirs}&after=working`); };
  return (
    <Dialog title={<span>A newer version was saved first</span>} onClose={close} labelledBy="save-conflict-h"
      footer={<>
        <button type="button" className="btn" onClick={close} data-testid="save-conflict-keep">Keep editing</button>
        <button type="button" className="btn" onClick={compare} data-testid="save-conflict-compare">Keep editing and compare</button>
        <button type="button" className="btn danger" onClick={() => void load()} disabled={busy} data-testid="save-conflict-load">{busy ? 'Loading…' : 'Load their version'}</button>
      </>}>
      <div data-testid="save-conflict" data-theirs={c.theirs} data-mine={c.mine}>
        <p className="sc-lead" data-testid="save-conflict-who">
          <strong>{who} saved version {c.theirs}</strong>{c.savedAt ? <> <time dateTime={c.savedAt} title={fmtAbs(c.savedAt)}>{fmtWhen(c.savedAt)}</time></> : null}, after you opened version {c.mine}. Your changes have <strong>not</strong> been saved, so nothing of theirs was overwritten.
        </p>
        <ul className="sc-choices">
          <li><strong>Load their version</strong>: opens version {c.theirs}. <span className="sc-loss">Your unsaved edits here are lost.</span></li>
          <li><strong>Keep editing and compare</strong>: your edits stay here, unsaved, and Before &amp; after shows version {c.theirs} beside your working version, so you can see what they changed and redo your edits on their version.</li>
        </ul>
        <p className="muted sc-note">The studio does not merge two people’s edits. Saving from this window stays refused until it has loaded the newer version.</p>
      </div>
    </Dialog>
  );
}
