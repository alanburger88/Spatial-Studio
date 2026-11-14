import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { workApi, type MyWorkDto, type NotificationDto, type NotificationTargetDto } from '../api/work';
import { useStudio } from '../state/store';
import { When } from '../ui/time';
import { useDrawers } from './drawers';
import { useNotifyState, type NotifyTab } from './notifyState';
import './notifications.css';

/**
 * The bell's panel (its own download): notifications newest first, each saying what happened in which document and
 * opening the right place, and "My work": the blockers this person owns that are not fixed and the documents waiting
 * for their review or approval, across every document. Reloaded whenever it opens and whenever the count changes.
 */

const STATUS_WORDS: Record<string, string> = { open: 'Open', 'being-fixed': 'Being fixed', fixed: 'Fixed', 'known-data-problem': 'Known data problem' };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function NotificationsPanel() {
  const tab = useNotifyState((s) => s.tab);
  const rev = useNotifyState((s) => s.rev);
  const unread = useNotifyState((s) => s.unread);
  const authEnabled = useStudio((s) => !!s.session?.authEnabled);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [news, setNews] = useState<NotificationDto[] | null>(null);
  const [work, setWork] = useState<MyWorkDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const close = () => useNotifyState.getState().close();

  useEffect(() => {
    let live = true;
    workApi.notifications(50).then((r) => { if (!live) return; setNews(r.notifications); useNotifyState.getState().setUnread(r.unread); }).catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    workApi.myWork().then((r) => live && setWork(r)).catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
  }, [rev]);

  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!root.current?.contains(t) && !t.closest?.('[data-testid=bell]')) close();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('mousedown', onDown); };
  }, []);
  // Leaving the page (a notification opened something) closes the panel.
  const first = useRef(pathname);
  useEffect(() => { if (pathname !== first.current) close(); }, [pathname]);

  const setTab = (t: NotifyTab) => useNotifyState.setState({ tab: t });
  const go = (t: NotificationTargetDto | null, kind?: string) => {
    if (!t) return;
    const base = `/studio/${encodeURIComponent(t.projectId)}`;
    if (t.screen === 'blockers') navigate(`${base}/blockers${t.blockerId ? `?${kind === 'blocker.fixed' ? 'fixed' : 'blocker'}=${encodeURIComponent(t.blockerId)}` : ''}`);
    else {
      if (!pathname.startsWith(`${base}/`)) navigate(`${base}/overview`);
      if (t.screen === 'comment' && t.nodeId) window.setTimeout(() => { const st = useStudio.getState(); if (st.project?.nodes.some((n) => n.id === t.nodeId)) st.select(t.nodeId!); }, 0);
      useDrawers.getState().show('review');
    }
    close();
  };
  const openOne = (n: NotificationDto) => {
    if (!n.read) {
      setNews((list) => list?.map((x) => (x.id === n.id ? { ...x, read: true } : x)) ?? list);
      workApi.readNotification(n.id).then((r) => useNotifyState.getState().setUnread(r.unread)).catch(() => undefined);
    }
    go(n.target, n.kind);
  };
  const readAll = () => {
    setNews((list) => list?.map((x) => ({ ...x, read: true })) ?? list);
    useNotifyState.getState().setUnread(0);
    workApi.readAllNotifications().catch(() => undefined);
  };
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = tab === 'news' ? 'work' : 'news';
    setTab(next);
    window.setTimeout(() => root.current?.querySelector<HTMLElement>(`#notify-tab-${next}`)?.focus(), 0);
  };
  const workCount = work ? work.blockers.length + work.reviews.length : null;

  return (
    <div className="notify-panel" ref={root} role="dialog" aria-label="Notifications and My work" data-testid="notify-panel">
      <div className="notify-head">
        <div className="notify-tabs" role="tablist" aria-label="Notifications and My work" onKeyDown={onTabKey}>
          <button type="button" role="tab" id="notify-tab-news" aria-selected={tab === 'news'} aria-controls="notify-body" tabIndex={tab === 'news' ? 0 : -1} onClick={() => setTab('news')} data-testid="notify-tab-news">
            Notifications {unread > 0 && <span className="chip count">{unread} unread</span>}
          </button>
          <button type="button" role="tab" id="notify-tab-work" aria-selected={tab === 'work'} aria-controls="notify-body" tabIndex={tab === 'work' ? 0 : -1} onClick={() => setTab('work')} data-testid="notify-tab-work">
            My work {workCount !== null && <span className="chip count">{workCount}</span>}
          </button>
        </div>
        <button type="button" className="btn ghost icon sm" onClick={close} aria-label="Close" data-testid="notify-close">✕</button>
      </div>
      <div className="notify-body" id="notify-body" role="tabpanel" aria-labelledby={`notify-tab-${tab}`}>
        {error && <p className="callout warning notify-error" role="alert">{error}</p>}
        {tab === 'news' ? (
          news === null ? <p className="muted notify-wait" role="status">Loading…</p> : (
            <>
              {news.length > 0 && (
                <div className="notify-actions">
                  <span className="muted">Newest first</span>
                  <button type="button" className="btn ghost sm" onClick={readAll} disabled={!news.some((n) => !n.read) && unread === 0} data-testid="notify-read-all">Mark all as read</button>
                </div>
              )}
              {news.length === 0 ? (
                <div className="notify-empty" data-testid="notify-empty">
                  <p><strong>Nothing new.</strong></p>
                  {authEnabled
                    ? <p className="muted">You hear here when a blocker is given to you, when someone adds a note to one you own or it is fixed, when a document is submitted for your review, when your submission is approved or sent back, and when someone replies to your comment.</p>
                    : <p className="muted" data-testid="notify-local">Sign-in is off, so you are the only person in the studio and your own actions do not notify you. You still hear when the studio finds a blocker you own fixed. With sign-in on, people are told when work is given to them.</p>}
                  <button type="button" className="btn sm" onClick={() => setTab('work')}>See My work</button>
                </div>
              ) : (
                <ul className="list-rows notify-list" data-testid="notify-list">
                  {news.map((n) => (
                    <li key={n.id} className={n.read ? '' : 'unread'}>
                      <button type="button" className="notify-item" onClick={() => openOne(n)} disabled={!n.target} data-testid="notify-item" data-kind={n.kind} data-read={n.read ? 'yes' : 'no'}>
                        <span className="notify-dot" aria-hidden="true" />
                        <span className="notify-text">{!n.read && <span className="sr-only">Unread: </span>}{n.text}</span>
                        <span className="notify-meta muted"><When iso={n.at} /></span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )
        ) : (
          work === null ? <p className="muted notify-wait" role="status">Loading…</p> : (
            <div className="notify-work" data-testid="my-work">
              <section aria-labelledby="mw-blockers">
                <h3 id="mw-blockers" className="section-title">Blockers you own <span className="chip count">{work.blockers.length}</span></h3>
                {work.blockers.length === 0
                  ? <p className="muted notify-none" data-testid="my-work-no-blockers">No blocker is yours to fix. On a document’s Blockers screen, choose a blocker and give it an owner{authEnabled ? '' : ' (with sign-in off, that is you)'}.</p>
                  : (
                    <ul className="list-rows notify-list">
                      {work.blockers.map((b) => (
                        <li key={`${b.projectId}|${b.blockerId}`}>
                          <button type="button" className="notify-item" onClick={() => go({ screen: 'blockers', projectId: b.projectId, blockerId: b.blockerId })} data-testid="my-work-blocker" data-blocker={b.blockerId}>
                            <span className="notify-text"><strong>{b.title}</strong><span className="muted"> in “{b.documentTitle}”</span></span>
                            <span className="notify-meta">
                              <span className={`chip${b.status === 'being-fixed' ? ' info' : b.status === 'known-data-problem' ? ' warning' : ''}`}>{STATUS_WORDS[b.status] ?? b.status}</span>
                              {b.customerCount ? <span className="chip count">{plural(b.customerCount, 'customer')} stopped</span> : null}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
              </section>
              <section aria-labelledby="mw-reviews">
                <h3 id="mw-reviews" className="section-title">Waiting for your review or approval <span className="chip count">{work.reviews.length}</span></h3>
                {work.reviews.length === 0
                  ? <p className="muted notify-none" data-testid="my-work-no-reviews">{work.user.role === 'author' ? 'Authors do not review or approve, so nothing waits here for you.' : 'No document is in review.'}</p>
                  : (
                    <ul className="list-rows notify-list">
                      {work.reviews.map((r) => (
                        <li key={r.projectId}>
                          <button type="button" className="notify-item" onClick={() => go({ screen: 'review', projectId: r.projectId })} data-testid="my-work-review" data-project={r.projectId}>
                            <span className="notify-text"><strong>{r.documentTitle}</strong>{r.modelVersion ? <span className="muted"> · version {r.modelVersion}</span> : null}</span>
                            <span className="notify-meta muted">{r.canApprove ? 'Review or approve' : 'Review'}{r.submittedBy ? ` · submitted by ${r.mine ? 'you' : r.submittedBy}` : ''} · <When iso={r.submittedAt} /></span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
              </section>
              {!authEnabled && <p className="hint notify-local" data-testid="my-work-local">Sign-in is off: you are the local admin, so every blocker given an owner is yours, and every document in review waits for you.</p>}
            </div>
          )
        )}
      </div>
    </div>
  );
}
