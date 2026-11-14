import { useState } from 'react';
import type { BlockerKind } from '@iss/scenarios';
import type { BlockerWorkDto, BlockerWorkItem, WorkStatus } from '../../api/work';
import { useStudio } from '../../state/store';
import { When } from '../../ui/time';
import { KIND_LABEL } from './labels';
import { STATUS_CHIP, STATUS_LABEL, useBlockerWorkStore, useMe } from './work';

/**
 * Blockers phase 4 on the screen: the owner and status chips of a row, the "Owner, status and notes" part of the detail,
 * and the "Fixed" group. Anyone who may comment can give a blocker an owner, mark it "Being fixed" and add notes;
 * "Fixed" and "Known data problem" are worked out by the studio and cannot be chosen.
 */

const NOTE_MAX = 1000;

/** Why this person cannot assign, set the status or add notes (they may not comment), or null. */
export function useWorkBlockedReason(): string | null {
  const session = useStudio((s) => s.session);
  if (!session) return null;
  return session.permissions.includes('comment') ? null : 'Your role cannot comment, so it cannot give blockers an owner, change their status or add notes';
}

/** The status and owner of a row, as chips. */
export function WorkChips({ status, item, compact, ownerOnly }: { status: WorkStatus; item: BlockerWorkItem | undefined; compact?: boolean; /** Leave the status out (the row already shows it). */ ownerOnly?: boolean }) {
  const me = useMe();
  const owner = item?.owner;
  return (
    <>
      {!ownerOnly && status !== 'known-data-problem' && <span className={`chip ${STATUS_CHIP[status]}`.trim()} data-testid="bl-work-status" data-status={status}>{STATUS_LABEL[status]}</span>}
      {owner
        ? <span className="chip bl-owner" data-testid="bl-owner" data-owner={owner.id} title={`Owner: ${owner.name}`}>{owner.id === me.id ? 'Yours' : compact ? owner.name : `Owner: ${owner.name}`}</span>
        : !compact && <span className="chip bl-owner none" data-testid="bl-owner" data-owner="">No owner</span>}
    </>
  );
}

/** Owner picker, the "Being fixed" switch and the notes of one cause. */
export function WorkPanel({ blockerId, status, item, data, frozen }: { blockerId: string; status: WorkStatus; item: BlockerWorkItem | undefined; data: BlockerWorkDto | null; /** A fixed cause: its owner and status no longer change. */ frozen?: boolean }) {
  const projectId = useStudio((s) => s.project!.projectId);
  const blocked = useWorkBlockedReason();
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const people = data?.people ?? [];
  const authEnabled = data?.authEnabled ?? false;
  const run = async (fn: () => Promise<void>, ok?: () => void) => {
    setBusy(true);
    try { await fn(); ok?.(); }
    catch (e) { useStudio.getState().toast({ kind: 'error', title: 'Not changed', message: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  const store = useBlockerWorkStore.getState();
  const owner = item?.owner?.id ?? '';
  const beingFixed = status === 'being-fixed';
  const disabled = !data || busy || !!blocked;
  const trimmed = text.trim();
  return (
    <section className="bl-work" data-testid="bl-work" aria-labelledby="bl-work-h">
      <h3 className="section-title" id="bl-work-h">Owner, status and notes</h3>
      <div className="bl-work-row">
        <label className="field bl-work-owner">
          <span className="lbl">Owner</span>
          <select className="select" value={owner} disabled={disabled || frozen} onChange={(e) => void run(() => store.set(projectId, blockerId, { ownerId: e.target.value || null }))} data-testid="bl-owner-picker" title={blocked ?? undefined}>
            <option value="">No owner</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            {item?.owner && !people.some((p) => p.id === item.owner!.id) && <option value={item.owner.id}>{item.owner.name} (no longer a studio user)</option>}
          </select>
        </label>
        <label className={`bl-switch${frozen || status === 'known-data-problem' ? ' off' : ''}`} title={status === 'known-data-problem' ? 'Every customer it stops is set aside as a known data problem.' : frozen ? 'Fixed: no customer is stopped by it any more.' : 'Tell others someone is working on it'}>
          <input type="checkbox" role="switch" checked={beingFixed} aria-checked={beingFixed} disabled={disabled || frozen || status === 'known-data-problem'}
            onChange={(e) => void run(() => store.set(projectId, blockerId, { status: e.target.checked ? 'being-fixed' : 'open' }))} data-testid="bl-being-fixed" />
          <span className="bl-switch-track" aria-hidden="true"><span /></span>
          <span>Being fixed</span>
        </label>
      </div>
      <p className="hint bl-work-status" data-testid="bl-work-line">
        Status: <strong>{STATUS_LABEL[status]}</strong>
        {status === 'fixed' ? '. Worked out by the studio: no customer is stopped by it any more.'
          : status === 'known-data-problem' ? '. Every customer it stops is set aside by an approver.'
          : item?.statusBy && item.statusAt ? <> · set by {item.statusBy.name}, <When iso={item.statusAt} /></> : null}
        {status !== 'fixed' && <span className="muted"> “Fixed” is set by the studio when no customer is stopped any more.</span>}
      </p>
      {!authEnabled && data && <p className="hint bl-work-local" data-testid="bl-work-local">Sign-in is off, so the only possible owner is the local admin; giving blockers to people becomes useful with sign-in on.</p>}
      {blocked && <p className="hint bl-readonly">{blocked}.</p>}

      <h4 className="bl-notes-h">Notes {item?.notes.length ? <span className="chip count">{item.notes.length}</span> : null}</h4>
      {item?.notes.length ? (
        <ol className="bl-notes" data-testid="bl-notes">
          {item.notes.map((n) => (
            <li key={n.id} className="bl-note-item" data-testid="bl-note">
              <span className="bl-note-meta"><strong>{n.author?.name ?? 'Someone'}</strong> <span className="muted"><When iso={n.at} /></span></span>
              <span className="bl-note-body">{n.body}</span>
            </li>
          ))}
        </ol>
      ) : <p className="muted bl-notes-none">No notes yet.</p>}
      <form className="bl-note-form" onSubmit={(e) => { e.preventDefault(); if (trimmed) void run(() => store.note(projectId, blockerId, trimmed), () => setText('')); }}>
        <label className="sr-only" htmlFor={`bl-note-${blockerId}`}>Add a note</label>
        <textarea id={`bl-note-${blockerId}`} className="textarea" rows={2} maxLength={NOTE_MAX} value={text} onChange={(e) => setText(e.target.value)} disabled={disabled}
          placeholder="Add a note for the people fixing it (plain text)" data-testid="bl-note-input" />
        <div className="row bl-note-actions">
          <span className="hint">Notes stay in the studio: never in the document, a release or a package.</span>
          <button type="submit" className="btn sm" disabled={disabled || !trimmed} data-testid="bl-note-add">Add note</button>
        </div>
      </form>
    </section>
  );
}

/** One entry of the "Fixed" group: fixed by the studio (saved), or no longer found in the open, unsaved version. */
export interface FixedEntry { item: BlockerWorkItem; unsaved: boolean }

export function FixedGroup({ entries, selectedId, onSelect }: { entries: FixedEntry[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (!entries.length) return null;
  return (
    <section className="bl-group bl-fixed-group" data-testid="bl-fixed-group" aria-labelledby="bl-kind-h-fixed">
      <header className="bl-group-head">
        <h2 id="bl-kind-h-fixed">Fixed</h2>
        <span className="chip count">{entries.length}</span>
        <span className="muted bl-group-next">No customer is stopped by these any more. They stay here until the document is next approved.</span>
      </header>
      <ul className="list-rows bl-rows">
        {entries.map(({ item, unsaved }) => {
          const sel = selectedId === item.blockerId;
          return (
            <li key={item.blockerId} className={`bl-row-item${sel ? ' selected' : ''}`}>
              <button type="button" className="bl-row" data-testid={`bl-fixed-${item.blockerId}`} data-blocker={item.blockerId} data-unsaved={unsaved ? 'yes' : undefined} aria-current={sel ? 'true' : undefined} onClick={() => onSelect(item.blockerId)}>
                <span className="bl-row-top">
                  <strong className="bl-row-title">{item.title}</strong>
                  {unsaved ? <span className="chip info" title="Your unsaved changes clear it. Save, and the studio marks it Fixed.">Fixed when saved</span>
                    : <span className="chip accent" data-testid="bl-work-status" data-status="fixed">Fixed</span>}
                  <WorkChips status="fixed" item={item} compact ownerOnly />
                </span>
                <span className="bl-row-fix muted">{unsaved ? 'Not found in the open version.' : <>Fixed in version {item.fixedInVersion}{item.fixedAt ? <>, <When iso={item.fixedAt} /></> : null}.</>} {KIND_LABEL[item.kind as BlockerKind]}.</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The detail of a fixed cause: what it was, when it was fixed, and its owner and notes. */
export function FixedDetail({ entry, data }: { entry: FixedEntry; data: BlockerWorkDto | null }) {
  const { item, unsaved } = entry;
  return (
    <div className="bl-detail-body" data-testid="bl-fixed-detail" data-blocker={item.blockerId}>
      <div className="bl-detail-head">
        <h2 className="bl-detail-title">{item.title}</h2>
        <div className="bl-chips">
          <span className="chip">{KIND_LABEL[item.kind as BlockerKind]}</span>
          {unsaved ? <span className="chip info">Fixed when saved</span> : <span className="chip accent">Fixed</span>}
        </div>
      </div>
      <p className="bl-why">
        {unsaved
          ? 'Your unsaved changes clear this cause: no customer is stopped by it in the open version. Save, and the studio marks it Fixed.'
          : <>No customer is stopped by this any more. The studio found it fixed in version {item.fixedInVersion}{item.fixedAt ? <>, <When iso={item.fixedAt} /></> : null}. It stays listed here until the document is next approved, then drops off with its notes.</>}
      </p>
      <WorkPanel blockerId={item.blockerId} status={unsaved ? (item.status === 'being-fixed' ? 'being-fixed' : 'open') : 'fixed'} item={item} data={data} frozen={!unsaved} />
    </div>
  );
}
