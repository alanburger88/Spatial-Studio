import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { languageName } from '@iss/model';
import { ApiFailure, api, type CommentWithLinkDto } from '../api/client';
import { useStudio } from '../state/store';
import { nodeTitle } from '../ui/plain';
import { When } from '../ui/time';
import { useCommentsRev } from '../screens/design/Comments';
import { useReviewLinksRev } from '../screens/releases/ReviewLinks';

/**
 * Review panel, "From review links" (wave 4): comments that arrived through a review link. The typed name is always
 * shown with the link's label ("Name (review link: label)"), never as a user. Anyone who may comment can answer and
 * resolve them; the person with the link sees the answers.
 */
export function ReviewLinkThreads({ pid, onNavigate }: { pid: string; onNavigate: () => void }) {
  const project = useStudio((s) => s.project)!;
  const records = useStudio((s) => s.records);
  const session = useStudio((s) => s.session);
  const rev = useCommentsRev((s) => s.rev);
  const linksRev = useReviewLinksRev((s) => s.rev);
  const [all, setAll] = useState<CommentWithLinkDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const mayComment = !session?.authEnabled || session.permissions.includes('comment');

  useEffect(() => {
    let live = true;
    api.comments(pid, { status: 'all' }).then((r) => { if (live) { setAll(r.comments as CommentWithLinkDto[]); setError(null); } }, (e) => live && setError(e instanceof ApiFailure ? e.message : 'The comments could not be loaded.'));
    return () => { live = false; };
  }, [pid, rev, linksRev, n]);

  const threads = useMemo(() => {
    const roots = (all ?? []).filter((c) => !c.parentId && c.reviewLink);
    return roots.map((c) => ({ c, replies: (all ?? []).filter((r) => r.parentId === c.id) }))
      .sort((a, b) => Number(!!a.c.resolvedAt) - Number(!!b.c.resolvedAt) || b.c.createdAt.localeCompare(a.c.createdAt));
  }, [all]);
  const open = threads.filter((t) => !t.c.resolvedAt);
  const resolved = threads.filter((t) => !!t.c.resolvedAt);
  const name = (id: string) => { const r = records.find((x) => x.recordId === id); return r ? `${r.customer.givenName} ${r.customer.familyName}`.trim() : id; };
  const changed = () => { setN((x) => x + 1); useCommentsRev.getState().bump(); };

  const one = ({ c, replies }: (typeof threads)[number]) => (
    <li key={c.id} className="rl-thread" data-testid="review-link-thread" data-id={c.id} data-resolved={c.resolvedAt ? 'true' : 'false'}>
      <div className="rev-snippet">
        <span className="who" data-testid="review-link-thread-author">{c.authorName}</span> <span className="when"><When iso={c.createdAt} /></span>
        <div className="muted rl-thread-about">{name(c.reviewLink!.recordId)} · {c.reviewLink!.outputLabel} · {languageName(c.reviewLink!.locale)} · version {c.modelVersion}{c.nodeId && project.nodes.some((x) => x.id === c.nodeId) ? <> · {nodeTitle(project, c.nodeId)}</> : ' · whole document'}</div>
        <div className="rl-thread-body">{c.body}</div>
      </div>
      {replies.length > 0 && (
        <ul className="rl-thread-replies">
          {replies.map((r) => <li key={r.id} className="rev-snippet" data-testid="review-link-answer"><span className="who">{r.authorName}</span> <span className="when"><When iso={r.createdAt} /></span><div className="rl-thread-body">{r.body}</div></li>)}
        </ul>
      )}
      {mayComment && <ThreadActions pid={pid} c={c} onChanged={changed} />}
    </li>
  );

  return (
    <section className="drawer-section" aria-labelledby="wf-links-h" data-testid="review-from-links">
      <h3 id="wf-links-h">From review links <span className="count">{all ? `${open.length} open` : ''}</span></h3>
      {error ? <p className="muted">{error}</p>
        : !all ? <p className="muted"><span className="spinner" /> Loading…</p>
        : threads.length === 0 ? <p className="muted" style={{ marginTop: 0 }}>No comments from review links. <Link to={`/studio/${pid}/releases#review-links`} onClick={onNavigate}>Share a release for review</Link> to ask someone without an account.</p>
        : (
          <>
            {open.length > 0 ? <ul className="rl-threads">{open.map(one)}</ul> : <p className="muted" style={{ marginTop: 0 }}>Every comment from a review link is resolved.</p>}
            {resolved.length > 0 && (
              <details className="rl-resolved">
                <summary className="linkbtn">{resolved.length} resolved</summary>
                <ul className="rl-threads">{resolved.map(one)}</ul>
              </details>
            )}
          </>
        )}
    </section>
  );
}

function ThreadActions({ pid, c, onChanged }: { pid: string; c: CommentWithLinkDto; onChanged: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [replying, setReplying] = useState(false);
  const fail = (title: string, e: unknown) => useStudio.getState().toast({ kind: 'error', title, message: e instanceof ApiFailure ? e.message : 'That did not work.' });
  const reply = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try { await api.addComment(pid, { parentId: c.id, body: text.trim() }); setText(''); setReplying(false); onChanged(); }
    catch (err) { fail('The answer was not sent', err); } finally { setBusy(false); }
  };
  const resolve = async (resolved: boolean) => {
    setBusy(true);
    try { await api.resolveComment(pid, c.id, resolved); onChanged(); }
    catch (err) { fail(resolved ? 'Not resolved' : 'Not reopened', err); } finally { setBusy(false); }
  };
  return (
    <div className="rl-thread-actions">
      {replying ? (
        <form onSubmit={reply} className="rl-thread-reply">
          <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} aria-label={`Answer ${c.authorName}`} placeholder="Your answer. The person with the link sees it." autoFocus data-testid="review-link-reply-text" />
          <div className="btns">
            <button type="submit" className="btn sm primary" disabled={busy || !text.trim()} data-testid="review-link-reply-send">{busy ? 'Sending…' : 'Send answer'}</button>
            <button type="button" className="btn sm ghost" onClick={() => { setReplying(false); setText(''); }}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="btns">
          <button type="button" className="btn sm" onClick={() => setReplying(true)} data-testid="review-link-reply">Answer</button>
          <button type="button" className="btn sm" onClick={() => resolve(!c.resolvedAt)} disabled={busy} data-testid="review-link-resolve">{c.resolvedAt ? 'Reopen' : 'Resolve'}</button>
        </div>
      )}
    </div>
  );
}
