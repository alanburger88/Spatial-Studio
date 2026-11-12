import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { COMMENT_MAX } from '@iss/model';
import { api, type CommentDto } from '../../api/client';
import { useCan, useStudio } from '../../state/store';
import { When } from '../../shell/History';
import '../../shell/collab.css';

/** Bumped after any comment change so every open comment list (inspector tab, review panel) refreshes. */
export const useCommentsRev = create<{ rev: number; bump(): void }>((set) => ({ rev: 0, bump: () => set((s) => ({ rev: s.rev + 1 })) }));

function Composer({ placeholder, label, submitLabel, onSubmit, testIds = true, autoFocus }: { placeholder: string; label: string; submitLabel: string; onSubmit: (body: string) => Promise<boolean>; testIds?: boolean; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const left = COMMENT_MAX - text.length;
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await onSubmit(text);
    setBusy(false);
    if (ok) setText('');
  };
  return (
    <div className="cmt-compose">
      <textarea className="textarea" aria-label={label} placeholder={placeholder} value={text} maxLength={COMMENT_MAX} autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
        {...(testIds ? { 'data-testid': 'comment-input' } : {})} />
      <div className="row">
        <span className="counter" aria-live="polite">{left < 200 ? `${left} characters left` : 'Plain text · Ctrl+Enter to send'}</span>
        <button type="button" className="btn primary sm" onClick={send} disabled={!text.trim() || busy} {...(testIds ? { 'data-testid': 'comment-submit' } : {})}>{busy ? 'Sending…' : submitLabel}</button>
      </div>
    </div>
  );
}

/** Review comments pinned to one component: threads, replies, resolve/reopen, delete own. */
export function CommentsTab({ nodeId }: { nodeId: string }) {
  const projectId = useStudio((s) => s.project?.projectId);
  const modelVersion = useStudio((s) => s.serverVersion);
  const rev = useCommentsRev((s) => s.rev);
  const canComment = useCan('comment');
  const [comments, setComments] = useState<CommentDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    api.comments(projectId, { nodeId }).then((r) => { if (live) { setComments(r.comments); setError(null); } }).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [projectId, nodeId, rev]);

  if (!projectId) return null;
  const toast = useStudio.getState().toast;
  const run = async (fn: () => Promise<unknown>, fail: string) => {
    try { await fn(); useCommentsRev.getState().bump(); return true; } catch (e: any) { toast({ kind: 'error', title: fail, message: e.message }); return false; }
  };
  const roots = (comments ?? []).filter((c) => !c.parentId);
  const replies = (id: string) => (comments ?? []).filter((c) => c.parentId === id);
  const open = roots.filter((r) => !r.resolvedAt);
  const resolved = roots.filter((r) => r.resolvedAt);

  const thread = (root: CommentDto) => (
    <article key={root.id} className={`cmt-thread${root.resolvedAt ? ' resolved' : ''}`} aria-label={`Comment by ${root.authorName}`}>
      {[root, ...replies(root.id)].map((c) => (
        <div key={c.id} className={`cmt-item${c.parentId ? ' reply' : ''}`} data-testid="comment-item" data-comment-id={c.id} data-resolved={root.resolvedAt ? 'true' : 'false'}>
          <div className="head">
            <span className="who">{c.authorName}</span>
            <span className="when"><When iso={c.createdAt} /> · on v{c.modelVersion}{c.modelVersion !== modelVersion ? ' (older version)' : ''}</span>
            {c.mine && canComment && <button type="button" className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => run(() => api.deleteComment(projectId, c.id), 'Could not delete comment')} aria-label={c.parentId ? 'Delete reply' : 'Delete comment thread'}>Delete</button>}
          </div>
          <div className="body">{c.body}</div>
        </div>
      ))}
      {root.resolvedAt && <div className="cmt-tools muted" style={{ fontSize: 11.5 }}>Resolved by {root.resolvedBy ?? 'someone'} · <When iso={root.resolvedAt} /></div>}
      {canComment && (
        <div className="cmt-tools">
          {!root.resolvedAt && <button type="button" className="btn ghost sm" onClick={() => setReplyTo(replyTo === root.id ? null : root.id)} aria-expanded={replyTo === root.id}>Reply</button>}
          <button type="button" className="btn ghost sm" onClick={() => run(() => api.resolveComment(projectId, root.id, !root.resolvedAt), 'Could not update comment')} data-testid="comment-resolve">{root.resolvedAt ? 'Reopen' : 'Resolve'}</button>
        </div>
      )}
      {replyTo === root.id && (
        <div className="cmt-reply">
          <Composer testIds={false} autoFocus label={`Reply to ${root.authorName}`} placeholder="Write a reply…" submitLabel="Reply" onSubmit={(body) => run(() => api.addComment(projectId, { parentId: root.id, body }), 'Could not reply').then((ok) => { if (ok) setReplyTo(null); return ok; })} />
        </div>
      )}
    </article>
  );

  return (
    <div className="cmt" data-testid="comments-tab" data-node={nodeId}>
      {error && <div className="callout error" role="alert">Comments could not be loaded: {error}</div>}
      {!comments && !error && <div className="muted"><span className="spinner" /> Loading comments…</div>}
      {comments && !open.length && <p className="muted" style={{ margin: 0 }}>No open comments on this component.</p>}
      {open.map(thread)}
      {resolved.length > 0 && (
        <>
          <button type="button" className="btn ghost sm cmt-resolved-toggle" aria-expanded={showResolved} onClick={() => setShowResolved(!showResolved)}>{showResolved ? 'Hide' : 'Show'} {resolved.length} resolved</button>
          {showResolved && resolved.map(thread)}
        </>
      )}
      {canComment
        ? <Composer label="New comment on this component" placeholder="Comment on this component…" submitLabel="Comment" onSubmit={(body) => run(() => api.addComment(projectId, { nodeId, body }), 'Could not add comment')} />
        : <p className="muted">Your role cannot comment.</p>}
    </div>
  );
}
