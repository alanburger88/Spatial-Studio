import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ROLES, ROLE_LABEL, ROLE_SUMMARY, type Project, type Role } from '@iss/model';
import { api, type AuditEventDto, type AuditQuery, type SessionUser } from '../api/client';
import { useCan, useStudio } from '../state/store';
import { ErrorState, Proof, ScreenHeader } from '../ui/common';
import { nodeTitle } from '../ui/plain';
import { When, fmtAbs } from '../shell/History';
import './Activity.css';

/* ------------------------------------------------------------------ plain sentences */

const CATEGORIES: Array<{ id: string; label: string }> = [
  { id: '', label: 'Everything' },
  { id: 'project.', label: 'Saves & versions' },
  { id: 'workflow.', label: 'Review & approval' },
  { id: 'comment.', label: 'Comments' },
  { id: 'records.', label: 'Imported records' },
  { id: 'asset.', label: 'Images' },
  { id: 'batch.', label: 'Batch runs' },
  { id: 'user.', label: 'User accounts' },
  { id: 'auth.', label: 'Sign-ins' },
];
const PERIODS: Array<{ id: string; label: string; ms: number | null }> = [
  { id: 'all', label: 'Any time', ms: null },
  { id: '1h', label: 'Last hour', ms: 3600e3 },
  { id: '1d', label: 'Last 24 hours', ms: 86400e3 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 86400e3 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 86400e3 },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function changeSummary(c: Record<string, number> | undefined): string {
  if (!c) return '';
  const words: Record<string, [string, string]> = { title: ['title', 'title'], components: ['component', 'components'], rules: ['rule', 'rules'], content: ['wording change', 'wording changes'], customFields: ['data field', 'data fields'], styles: ['style', 'styles'], brand: ['brand setting', 'brand settings'], testCases: ['test', 'tests'], journey: ['journey event', 'journey events'], profiles: ['output profile', 'output profiles'], other: ['other change', 'other changes'] };
  const parts = Object.entries(c).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${n === 1 ? words[k]?.[0] ?? k : words[k]?.[1] ?? k}`);
  return parts.length ? parts.join(', ') : 'no content changes';
}

/** One readable sentence per audit entry. Never invents facts: everything comes from the stored entry. */
export function auditSentence(e: AuditEventDto, project: Project | null): string {
  const d = e.detail ?? {};
  const v = e.modelVersion !== null ? `v${e.modelVersion}` : '';
  const node = (id: unknown) => { const s = String(id ?? ''); return project && project.projectId === e.projectId && project.nodes.some((n) => n.id === s) ? `“${nodeTitle(project, s)}”` : d.nodeName ? `“${d.nodeName}”` : s ? `component ${s}` : 'a component'; };
  switch (e.action) {
    case 'project.save': return `Saved ${v} (${changeSummary(d.changes)})${d.workflow ? ` — moved back to draft from ${String(d.workflow.from).replace('_', ' ')}` : ''}`;
    case 'project.restore': return `Restored v${d.restoredVersion} as ${v}`;
    case 'project.reset': return `Restored the approved sample as ${v}`;
    case 'project.duplicate': return `Created “${d.title ?? e.projectId}” as a copy of ${d.from} v${d.fromVersion}`;
    case 'project.rename': return `Renamed “${d.from}” to “${d.to}”`;
    case 'project.delete': return `Deleted project “${d.title}”`;
    case 'workflow.submit': return `Submitted ${v} for review`;
    case 'workflow.request_changes': return `Requested changes on ${v}`;
    case 'workflow.approve': return `Approved ${v}`;
    case 'workflow.publish': return `Published ${v}`;
    case 'workflow.reopen': return `Moved ${v} back to draft`;
    case 'comment.create': return `Commented on ${node(d.nodeId)}`;
    case 'comment.reply': return `Replied to a comment on ${node(d.nodeId)}`;
    case 'comment.resolve': return `Resolved a comment thread on ${node(d.nodeId)}`;
    case 'comment.reopen': return `Reopened a comment thread on ${node(d.nodeId)}`;
    case 'comment.delete': return `Deleted a comment on ${node(d.nodeId)}`;
    case 'records.import': return `Imported ${plural(Number(d.imported ?? 0), 'record')}${d.rejected ? ` (${d.rejected} rejected)` : ''} from ${String(d.format ?? 'a file').toUpperCase()}`;
    case 'records.clear': return `Removed ${plural(Number(d.removed ?? 0), 'imported record')}`;
    case 'asset.upload': return d.duplicate ? `Re-uploaded image “${d.name}” (already in the library)` : `Uploaded image “${d.name}”`;
    case 'asset.delete': return `Deleted image “${d.name}”`;
    case 'batch.start': return `Started a batch run for ${plural(Number(d.records ?? 0), 'synthetic record')} (${(d.outputs ?? []).map((o: string) => o.toUpperCase()).join(' + ')})${d.unsavedModel ? ' using unsaved changes' : ''}`;
    case 'batch.cancel': return 'Cancelled a batch run';
    case 'snapshots.reset': return 'Cleared the issued journey snapshots';
    case 'user.create': return `Added ${d.email} as ${ROLE_LABEL[d.role as Role] ?? d.role}`;
    case 'user.update': return `Updated ${d.email}: ${(d.changed ?? []).map((k: string) => (k === 'role' ? `role is now ${ROLE_LABEL[d.role as Role] ?? d.role}` : k === 'disabled' ? (d.disabled ? 'disabled' : 'enabled') : k === 'password' ? 'password reset' : k)).join(', ') || 'no change'}`;
    case 'auth.login': return 'Signed in';
    case 'auth.logout': return 'Signed out';
    case 'auth.login_failed': return `Failed sign-in for ${d.email ?? 'an unknown account'}`;
    default: return `Changed data (${d.route ?? e.action})`;
  }
}

/* ------------------------------------------------------------------ screen */

export function Activity({ global = false }: { global?: boolean }) {
  const project = useStudio((s) => (global ? null : s.project));
  const projects = useStudio((s) => s.projects);
  const session = useStudio((s) => s.session);
  const canManage = useCan('manage_users') && !!session?.authEnabled;
  const [tab, setTab] = useState<'log' | 'users'>('log');
  return (
    <section className="screen" data-testid="activity-screen">
      <ScreenHeader id="S14" title={global ? 'Activity — all projects' : 'Activity'}
        subtitle="Every change is recorded: who saved, restored, reviewed, commented, imported or exported, and when. Entries describe what happened without copying document text or comment bodies."
        actions={global ? <Link to="/projects" className="btn sm">Back to projects</Link> : <Link to="/activity" className="btn sm" data-testid="activity-all-projects">All projects</Link>} />
      {canManage && (
        <div className="tabs act-tabs" role="tablist" aria-label="Activity sections">
          <button type="button" role="tab" aria-selected={tab === 'log'} onClick={() => setTab('log')} data-testid="activity-tab-log">Activity log</button>
          <button type="button" role="tab" aria-selected={tab === 'users'} onClick={() => setTab('users')} data-testid="activity-tab-users">Users &amp; roles</button>
        </div>
      )}
      <div className="screen-body act-body">
        {tab === 'users' && canManage ? <UsersAdmin /> : <AuditLog projectId={project?.projectId ?? null} project={project} projects={global ? projects : []} />}
      </div>
    </section>
  );
}

function AuditLog({ projectId, project, projects }: { projectId: string | null; project: Project | null; projects: Array<{ projectId: string; title: string }> }) {
  const [user, setUser] = useState('');
  const [action, setAction] = useState('');
  const [period, setPeriod] = useState('all');
  const [projectFilter, setProjectFilter] = useState('');
  const [events, setEvents] = useState<AuditEventDto[] | null>(null);
  const [actors, setActors] = useState<Array<{ id: string; name: string; count: number }>>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const serverVersion = useStudio((s) => s.serverVersion);
  const titles = useMemo(() => new Map(projects.map((p) => [p.projectId, p.title])), [projects]);

  const query = useCallback((before?: number): AuditQuery => {
    const ms = PERIODS.find((p) => p.id === period)?.ms ?? null;
    return { projectId: projectId ?? (projectFilter || undefined), user: user || undefined, action: action || undefined, since: ms ? new Date(Date.now() - ms).toISOString() : undefined, before, limit: 50 };
  }, [projectId, projectFilter, user, action, period]);

  const load = useCallback(() => {
    setError(null);
    api.audit(query()).then((r) => { setEvents(r.events); setNext(r.nextBefore); setActors(r.actors); }).catch((e) => setError(e.message));
  }, [query]);
  useEffect(() => { load(); }, [load, serverVersion]);

  const more = async () => {
    if (next === null) return;
    setLoadingMore(true);
    try { const r = await api.audit(query(next)); setEvents((ev) => [...(ev ?? []), ...r.events]); setNext(r.nextBefore); } catch (e: any) { setError(e.message); } finally { setLoadingMore(false); }
  };
  const filtered = !!(user || action || period !== 'all' || projectFilter);

  return (
    <div className="panel act-panel">
      <div className="panel-head act-filters" role="search" aria-label="Filter activity">
        <label className="act-filter"><span>Who</span>
          <select className="select" value={user} onChange={(e) => setUser(e.target.value)} data-testid="activity-filter-user">
            <option value="">Anyone</option>
            {actors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="act-filter"><span>What</span>
          <select className="select" value={action} onChange={(e) => setAction(e.target.value)} data-testid="activity-filter-action">
            {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label className="act-filter"><span>When</span>
          <select className="select" value={period} onChange={(e) => setPeriod(e.target.value)} data-testid="activity-filter-when">
            {PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        {!projectId && (
          <label className="act-filter"><span>Project</span>
            <select className="select" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} data-testid="activity-filter-project">
              <option value="">All projects</option>
              {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.title}</option>)}
            </select>
          </label>
        )}
        <div className="right">
          {filtered && <button type="button" className="btn ghost sm" onClick={() => { setUser(''); setAction(''); setPeriod('all'); setProjectFilter(''); }}>Clear filters</button>}
          <button type="button" className="btn sm" onClick={load} data-testid="activity-refresh">Refresh</button>
        </div>
      </div>
      <div className="panel-body act-table-wrap">
        {error ? <ErrorState title="Activity could not be loaded" message={error} onRetry={load} /> : !events ? <div className="empty"><span className="spinner" /> Loading activity…</div> : !events.length ? (
          <div className="empty"><strong>No activity{filtered ? ' matches these filters' : ' recorded yet'}</strong><span>{filtered ? 'Try a wider time range or clear the filters.' : 'Saves, reviews, comments and imports will appear here.'}</span></div>
        ) : (
          <table className="table act-table">
            <caption className="sr-only">Activity, newest first</caption>
            <thead><tr><th scope="col" className="c-when">When</th><th scope="col" className="c-who">Who</th><th scope="col">What happened</th>{!projectId && <th scope="col" className="c-proj">Project</th>}<th scope="col" className="c-proof"><span className="sr-only">Details</span></th></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} data-testid="activity-row" data-action={e.action}>
                  <td className="c-when"><When iso={e.at} /></td>
                  <td className="c-who" title={e.user ?? undefined}>{e.userName ?? <span className="muted">Unknown</span>}</td>
                  <td className="c-what">{auditSentence(e, project)}</td>
                  {!projectId && <td className="c-proj">{!e.projectId ? <span className="muted">—</span> : titles.has(e.projectId) ? <Link to={`/studio/${e.projectId}/activity`} title={`${titles.get(e.projectId)} (${e.projectId})`}>{titles.get(e.projectId)}</Link> : <span className="muted" title="This project no longer exists">{e.projectId} (deleted)</span>}</td>}
                  <td className="c-proof">
                    <Proof label="Details">
                      <span className="act-proof mono" title={JSON.stringify(e.detail ?? {}, null, 1)}><span className="act-code">#{e.id} · {e.action}{e.modelVersion !== null ? ` · v${e.modelVersion}` : ''}{e.user ? ` · ${e.user}` : ''} · {fmtAbs(e.at)}</span>{Object.keys(e.detail ?? {}).length ? JSON.stringify(e.detail) : ''}</span>
                    </Proof>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {events && next !== null && <div className="act-more"><button type="button" className="btn sm" onClick={more} disabled={loadingMore} data-testid="activity-load-more">{loadingMore ? 'Loading…' : 'Show older activity'}</button></div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ user admin (admin only, AUTH=on) */

function UsersAdmin() {
  const me = useStudio((s) => s.session?.user);
  const toast = useStudio.getState().toast;
  const [users, setUsers] = useState<SessionUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', email: '', role: 'author' as Role, password: '' });
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [newPw, setNewPw] = useState('');
  const load = useCallback(() => { api.users().then((r) => setUsers(r.users)).catch((e) => setError(e.message)); }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast({ kind: 'success', title: ok }); load(); return true; } catch (e: any) { toast({ kind: 'error', title: 'Not changed', message: e.message }); return false; }
  };
  if (error) return <ErrorState title="Users could not be loaded" message={error} onRetry={load} />;
  return (
    <div className="act-users" data-testid="users-panel">
      <div className="panel">
        <div className="panel-head">People <span className="sub">{users ? `${users.length} account${users.length === 1 ? '' : 's'}` : ''}</span></div>
        <div className="panel-body" style={{ padding: 0 }}>
          {!users ? <div className="empty"><span className="spinner" /></div> : (
            <table className="table">
              <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} data-testid="user-row" data-email={u.email ?? ''}>
                    <td><strong>{u.name}</strong>{u.id === me?.id && <span className="chip accent" style={{ marginLeft: 6 }}>You</span>}</td>
                    <td className="act-email" title={u.email ?? ''}>{u.email}</td>
                    <td>
                      <select className="select" aria-label={`Role for ${u.name}`} value={u.role} disabled={u.id === me?.id} title={u.id === me?.id ? 'You cannot change your own role' : ROLE_SUMMARY[u.role]} onChange={(e) => run(() => api.updateUser(u.id, { role: e.target.value as Role }), `${u.name} is now ${ROLE_LABEL[e.target.value as Role]}`)}>
                        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    </td>
                    <td>{u.disabled ? <span className="chip error">Disabled</span> : <span className="chip accent">Active</span>}</td>
                    <td className="act-user-actions">
                      {resetFor === u.id ? (
                        <form className="row" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.updateUser(u.id, { password: newPw }), `Password reset for ${u.name}`)) { setResetFor(null); setNewPw(''); } }}>
                          <input className="input" type="password" autoComplete="new-password" aria-label={`New password for ${u.name}`} placeholder="New password (8+)" value={newPw} onChange={(e) => setNewPw(e.target.value)} minLength={8} required autoFocus />
                          <button type="submit" className="btn sm primary">Set</button>
                          <button type="button" className="btn sm ghost" onClick={() => { setResetFor(null); setNewPw(''); }}>Cancel</button>
                        </form>
                      ) : (
                        <div className="row">
                          <button type="button" className="btn sm" onClick={() => setResetFor(u.id)}>Reset password</button>
                          {u.id !== me?.id && <button type="button" className={`btn sm${u.disabled ? '' : ' danger'}`} onClick={() => run(() => api.updateUser(u.id, { disabled: !u.disabled }), `${u.name} ${u.disabled ? 'enabled' : 'disabled'}`)} data-testid="user-toggle">{u.disabled ? 'Enable' : 'Disable'}</button>}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <form className="panel act-newuser" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.createUser(form), `Added ${form.email}`)) setForm({ name: '', email: '', role: 'author', password: '' }); }}>
        <div className="panel-head">Add a person</div>
        <div className="panel-body">
          <label className="field"><span className="label">Name</span><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} maxLength={80} data-testid="user-create-name" /></label>
          <label className="field"><span className="label">Email</span><input className="input" type="email" autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required data-testid="user-create-email" /></label>
          <label className="field"><span className="label">Role</span>
            <select className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })} data-testid="user-create-role">
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]} — {ROLE_SUMMARY[r]}</option>)}
            </select>
          </label>
          <label className="field"><span className="label">Temporary password</span><input className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} data-testid="user-create-password" /><span className="hint">At least 8 characters. Share it privately; they can be given a new one any time.</span></label>
          <button type="submit" className="btn primary" data-testid="user-create-submit">Add person</button>
        </div>
      </form>
    </div>
  );
}
