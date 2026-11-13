import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ROLES, ROLE_LABEL, ROLE_SUMMARY, type Project, type Role } from '@iss/model';
import { parseActivityQuery, type ActivityQuery } from '@iss/scenarios';
import { api, type AuditEventDto, type AuditQuery, type SessionUser } from '../api/client';
import { useCan, useStudio } from '../state/store';
import { ErrorState, Proof, ScreenHeader } from '../ui/common';
import { nodeTitle } from '../ui/plain';
import { fmtAbs } from '../shell/History';
import { SourceChip } from '../assist/common';
import './Activity.css';

/* ------------------------------------------------------------------ plain sentences */

const CATEGORIES: Array<{ id: string; label: string }> = [
  { id: '', label: 'Everything' },
  { id: 'project.', label: 'Saves & versions' },
  { id: 'template.', label: 'Templates' },
  { id: 'testdata.', label: 'Test customers' },
  { id: 'workflow.', label: 'Review & approval' },
  { id: 'release.', label: 'Releases' },
  { id: 'comment.', label: 'Comments' },
  { id: 'records.', label: 'Imported records' },
  { id: 'known-data.', label: 'Known data problems' },
  { id: 'asset.', label: 'Images' },
  { id: 'batch.', label: 'Batch runs' },
  { id: 'assist.', label: 'Assistant-assisted changes' },
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
    case 'project.create': return d.setup ? `Created “${d.title ?? e.projectId}” from a ${d.setup === 'ai' ? 'description, set up by the assistant (AI suggestion, approved by this person)' : 'data file, set up by the studio (built-in)'}` : `Created “${d.title ?? e.projectId}” from the template “${d.templateTitle ?? d.templateId}”${d.templateVersion ? ` v${d.templateVersion}` : ''}`;
    case 'project.import': return `Imported “${d.title ?? e.projectId}” from a project file (“${d.fromTitle}” v${d.fromVersion})`;
    case 'records.add': return d.copyOf ? `Made an editable copy of a customer (${d.name})` : `Added the customer ${d.name}`;
    case 'records.edit': return `Edited the customer ${d.name}${d.wasGenerated ? ' (a generated customer, now kept as this document’s own)' : ''}`;
    case 'records.delete': return `Removed the customer ${d.name}`;
    case 'known-data.add': return `Set aside a known data problem for ${d.name ?? 'a customer'}: ${d.blocker ?? 'a problem in the customer’s data'}`;
    case 'known-data.remove': return `Removed the known data problem for ${d.name ?? 'a customer'}, who counts as stopped again`;
    case 'known-data.lapse': return d.why === 'customer-gone' ? 'A known data problem was removed because its customer no longer exists' : `A known data problem for ${d.name ?? 'a customer'} no longer applied and was removed (the problem no longer stops them)`;
    case 'testdata.generate': return `Generated ${plural(Number(d.customers ?? 0), 'test customer')} for this document${d.replaced ? ` (replacing ${d.replaced})` : ''}${d.unreachable ? `; ${plural(Number(d.unreachable), 'outcome')} could not be reached` : ''}`;
    case 'testdata.clear': return `Removed ${plural(Number(d.removed ?? 0), 'generated test customer')}`;
    case 'template.save': return d.newTemplate ? `Saved a new template “${d.title}” (v${d.version})` : `Saved version ${d.version} of the template “${d.title}”`;
    case 'template.retire': return `Retired the template “${d.title}”`;
    case 'template.unretire': return `Brought back the template “${d.title}”`;
    case 'template.reset': return `Removed ${plural(Number(d.removed ?? 0), 'saved template')}`;
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
    case 'assist.applied': return `Applied an assistant proposal: ${String(d.label ?? 'a change')} (${d.source === 'ai' ? 'AI suggestion' : 'built-in'}${Number(d.changes ?? 1) > 1 ? `, ${d.changes} changes in one step` : ''})`;
    case 'user.create': return `Added ${d.email} as ${ROLE_LABEL[d.role as Role] ?? d.role}`;
    case 'user.update': return `Updated ${d.email}: ${(d.changed ?? []).map((k: string) => (k === 'role' ? `role is now ${ROLE_LABEL[d.role as Role] ?? d.role}` : k === 'disabled' ? (d.disabled ? 'disabled' : 'enabled') : k === 'password' ? 'password reset' : k)).join(', ') || 'no change'}`;
    case 'release.create': return `Created release ${d.number} of “${d.title}” at ${d.stage ?? 'Test'}${d.origin === 'manual' ? ' from the approved version' : ' by approving it'}${Array.isArray(d.supersededAtTest) && d.supersededAtTest.length ? `; it replaces ${d.supersededAtTest.length === 1 ? 'release' : 'releases'} ${d.supersededAtTest.join(', ')} in Test` : ''}`;
    case 'release.promote': return `Moved release ${d.number} of “${d.title}” to ${d.stage ?? 'Production'}${Array.isArray(d.superseded) && d.superseded.length ? `, replacing ${d.superseded.length === 1 ? 'release' : 'releases'} ${d.superseded.join(', ')}` : ''}${d.withNote ? ' (with a note)' : ''}`;
    case 'release.withdraw': return `Withdrew release ${d.number} of “${d.title}” from ${d.stage}${d.withReason ? ' (reason recorded on the release)' : ''}`;
    case 'release.handover': return `Marked release ${d.number} of “${d.title}” as ${String(d.kind ?? 'handed over').toLowerCase()}${d.stage ? ` in ${d.stage}` : ''}${d.withNote ? ' (with a note)' : ''}`;
    case 'release.package': {
      const what = `the package for release ${d.number} of “${d.title}”`;
      switch (d.event) {
        case 'started': return `Started preparing ${what}`;
        case 'ready': return `Finished preparing ${what}${d.bytes ? ` (${Math.max(1, Math.round(Number(d.bytes) / 1024))} KB, ${plural(Number(d.files ?? 0), 'file')})` : ''}`;
        case 'failed': return `Could not prepare ${what}${d.reason ? `: ${d.reason}` : ''}`;
        case 'check-started': return `Started checking ${what}`;
        case 'checked': return d.reason ? `Could not check ${what}: ${d.reason}` : `Checked ${what}: ${d.same ? 'a new build matches the kept package' : 'a new build differs from the kept package (the kept package is unchanged)'}`;
        default: return `Worked on ${what}`;
      }
    }
    case 'release.runtime': {
      const what = `the runnable package for release ${d.number} of “${d.title}”`;
      switch (d.event) {
        case 'started': return `Started preparing ${what}`;
        case 'ready': return `Finished preparing ${what}${d.bytes ? ` (${(Number(d.bytes) / 1024 / 1024).toFixed(1)} MB, ${plural(Number(d.files ?? 0), 'file')})` : ''}`;
        case 'failed': return `Could not prepare ${what}${d.reason ? `: ${d.reason}` : ''}`;
        case 'check-started': return `Started checking ${what}`;
        case 'checked': return d.reason ? `Could not check ${what}: ${d.reason}` : `Checked ${what}: ${d.same ? 'a new build matches the kept package' : 'a new build differs from the kept package (the kept package is unchanged)'}`;
        default: return `Worked on ${what}`;
      }
    }
    case 'auth.login': return 'Signed in';
    case 'auth.logout': return 'Signed out';
    case 'auth.login_failed': return `Failed sign-in for ${d.email ?? 'an unknown account'}`;
    default: return `Changed data (${d.route ?? e.action})`;
  }
}


const ACTION_WORDS: Record<string, string> = { 'project.save': 'Saves', 'project.restore': 'Restores', 'workflow.approve': 'Approvals', 'workflow.submit': 'Submissions for review', 'workflow.publish': 'Publishing', 'workflow.request_changes': 'Requests for changes', 'comment.create': 'New comments', 'records.import': 'Record imports', 'auth.login': 'Sign-ins', 'batch.start': 'Batch runs', 'release.create': 'New releases', 'release.promote': 'Moves to Production', 'release.withdraw': 'Withdrawn releases', 'release.handover': 'Handover entries', 'release.package': 'Release packages', 'release.runtime': 'Runnable packages', 'known-data.add': 'Known data problems set aside', 'known-data.remove': 'Known data problems removed', 'known-data.lapse': 'Known data problems that lapsed' };
const actionLabel = (a: string): string => ACTION_WORDS[a] ?? CATEGORIES.find((c) => c.id === a)?.label ?? a;

/* ------------------------------------------------------------------ grouping */

type Entry = { kind: 'one'; e: AuditEventDto } | { kind: 'group'; key: string; label: string; items: AuditEventDto[] };
const dayKey = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function dayLabel(iso: string): string {
  const d = new Date(iso); const now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dayKey(iso) === dayKey(now.toISOString())) return 'Today';
  if (dayKey(iso) === dayKey(y.toISOString())) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
/** "5:44–5:46 PM" (or a single time when all entries fall in the same minute). */
function timeRange(items: AuditEventDto[]): string {
  const a = timeOf(items[items.length - 1].at); const b = timeOf(items[0].at);
  if (a === b) return a;
  const [ta, ma] = [a.replace(/\s?[AP]M$/i, ''), a.match(/[AP]M$/i)?.[0]]; const mb = b.match(/[AP]M$/i)?.[0];
  return ma && ma === mb ? `${ta}–${b}` : `${a}–${b}`;
}
const normalised = (e: AuditEventDto, project: Project | null) => auditSentence(e, project).replace(/ as v\d+/g, '').replace(/\bv\d+\b/g, 'v#');
const groupLabel = (e: AuditEventDto, project: Project | null) => (e.action === 'project.restore' ? 'Restored a previous version' : normalised(e, project).replace(/\bv#/g, 'a version'));

/** Consecutive entries by the same person, of the same kind, in the same project, on the same day collapse into one group. */
function groupEvents(events: AuditEventDto[], project: Project | null): Array<{ day: string; iso: string; entries: Entry[] }> {
  const days: Array<{ day: string; iso: string; entries: Entry[] }> = [];
  for (const e of events) {
    const k = dayKey(e.at);
    let day = days[days.length - 1];
    if (!day || day.day !== k) { day = { day: k, iso: e.at, entries: [] }; days.push(day); }
    const last = day.entries[day.entries.length - 1];
    const sig = (x: AuditEventDto) => `${x.user ?? ''}|${x.action}|${x.projectId ?? ''}|${normalised(x, project)}`;
    const prev = last ? (last.kind === 'one' ? last.e : last.items[0]) : null;
    if (last && prev && sig(prev) === sig(e)) {
      if (last.kind === 'one') day.entries[day.entries.length - 1] = { kind: 'group', key: `g${last.e.id}`, label: groupLabel(e, project), items: [last.e, e] };
      else last.items.push(e);
    } else day.entries.push({ kind: 'one', e });
  }
  return days;
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
  // Plain-words search: what was asked, what was understood, and the parts of it that the log cannot filter on the server.
  const [qText, setQText] = useState('');
  const [searched, setSearched] = useState<ActivityQuery | null>(null);
  const [range, setRange] = useState<{ since?: string; until?: string } | null>(null);
  const [words, setWords] = useState<string[]>([]);
  const [events, setEvents] = useState<AuditEventDto[] | null>(null);
  const [actors, setActors] = useState<Array<{ id: string; name: string; count: number }>>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const serverVersion = useStudio((s) => s.serverVersion);
  const titles = useMemo(() => new Map(projects.map((p) => [p.projectId, p.title])), [projects]);

  // The server filters by project, person, action and start time. An end time and words are applied here, on the rows fetched,
  // so while one of those is active we fetch a bigger page to search within.
  const clientFiltered = !!(range?.until || words.length);
  const query = useCallback((before?: number): AuditQuery => {
    const ms = PERIODS.find((p) => p.id === period)?.ms ?? null;
    return { projectId: projectId ?? (projectFilter || undefined), user: user || undefined, action: action || undefined, since: range?.since ?? (ms ? new Date(Date.now() - ms).toISOString() : undefined), before, limit: clientFiltered ? 200 : 50 };
  }, [projectId, projectFilter, user, action, period, range?.since, clientFiltered]);

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
  const shown = useMemo(() => {
    if (!events) return null;
    const until = range?.until ? Date.parse(range.until) : null;
    return events.filter((e) => {
      if (until !== null && !(Date.parse(e.at) < until)) return false;
      if (!words.length) return true;
      const hay = auditSentence(e, project).toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [events, range?.until, words, project]);
  const days = useMemo(() => (shown ? groupEvents(shown, project) : []), [shown, project]);
  const cols = projectId ? 4 : 5;
  const filtered = !!(user || action || period !== 'all' || projectFilter || range || words.length);

  const nameOfUser = (id: string) => actors.find((a) => a.id === id)?.name ?? id;
  const clearAll = () => { setUser(''); setAction(''); setPeriod('all'); setProjectFilter(''); setRange(null); setWords([]); setSearched(null); setQText(''); };
  const runSearch = () => {
    const text = qText.trim();
    if (!text) { clearAll(); return; }
    const q = parseActivityQuery(text, {
      now: new Date().toISOString(),
      users: actors.map((a) => ({ id: a.id, name: a.name })),
      projects: projectId ? (project ? [{ projectId: project.projectId, title: project.title }] : []) : projects,
    });
    setSearched(q);
    setUser(q.user ?? '');
    setAction(q.action ?? '');
    setPeriod('all');
    setRange(q.since || q.until ? { since: q.since, until: q.until } : null);
    setProjectFilter(!projectId && q.projectId ? q.projectId : '');
    // Words the search could not place are reported under "ignored" and are not used to hide entries.
    setWords((q.text ?? '').toLowerCase().split(/\s+/).filter((w) => w && !q.ignored.includes(w)));
  };
  const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const chips: Array<{ key: string; text: string; remove: () => void }> = [];
  if (searched) {
    if (searched.user && user === searched.user) chips.push({ key: 'user', text: `Person: ${nameOfUser(user)}`, remove: () => setUser('') });
    if (searched.action && action === searched.action) chips.push({ key: 'action', text: `Area: ${actionLabel(action)}`, remove: () => setAction('') });
    if (!projectId && searched.projectId && projectFilter === searched.projectId) chips.push({ key: 'project', text: `Project: ${titles.get(projectFilter) ?? projectFilter}`, remove: () => setProjectFilter('') });
    if (range) chips.push({ key: 'when', text: range.since && range.until ? `From ${day(range.since)} to ${day(new Date(Date.parse(range.until) - 1).toISOString())}` : range.since ? `From ${day(range.since)} to now` : `Until ${day(new Date(Date.parse(range.until!) - 1).toISOString())}`, remove: () => setRange(null) });
    if (words.length) chips.push({ key: 'words', text: `Words: ${words.join(' ')}`, remove: () => setWords([]) });
  }
  const ignoredWords = searched?.ignored ?? [];

  return (
    <div className="panel act-panel">
      <form className="act-search" role="search" aria-label="Search activity" onSubmit={(e) => { e.preventDefault(); runSearch(); }}>
        <label className="sr-only" htmlFor="activity-search">Ask about the activity in plain words</label>
        <input id="activity-search" className="input act-search-input" type="search" value={qText} onChange={(e) => setQText(e.target.value)} data-testid="activity-search" autoComplete="off" maxLength={200}
          placeholder="Ask, for example: who changed the payment rules last week?" />
        <button type="submit" className="btn sm primary" data-testid="activity-search-go">Search</button>
        {(searched || qText) && <button type="button" className="btn sm ghost" onClick={clearAll} data-testid="activity-search-clear">Clear</button>}
        {searched && <SourceChip source="builtin" />}
      </form>
      {searched && (chips.length > 0 || ignoredWords.length > 0 || clientFiltered) && (
        <div className="act-understood-wrap" aria-live="polite">
          {chips.length > 0 && (
            <div className="act-understood" data-testid="activity-understood" title={searched.understood.join(' · ')}>
              <span className="muted act-understood-lbl">Understood</span>
              {chips.map((c) => <span key={c.key} className="chip act-chip" data-testid="activity-chip" data-facet={c.key}>{c.text}<button type="button" className="act-chip-x" onClick={c.remove} aria-label={`Remove: ${c.text}`}>×</button></span>)}
            </div>
          )}
          {ignoredWords.length > 0 && <p className="act-ignored muted" data-testid="activity-ignored">Not used as a filter: {ignoredWords.map((w) => `“${w}”`).join(', ')}.</p>}
        </div>
      )}
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
            {action && !CATEGORIES.some((c) => c.id === action) && <option value={action}>{actionLabel(action)}</option>}
          </select>
        </label>
        <label className="act-filter"><span>When</span>
          <select className="select" value={range ? 'custom' : period} onChange={(e) => { setRange(null); setPeriod(e.target.value); }} data-testid="activity-filter-when">
            {range && <option value="custom">From your search</option>}
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
          {filtered && <button type="button" className="btn ghost sm" onClick={clearAll}>Clear filters</button>}
          <button type="button" className="btn sm" onClick={load} data-testid="activity-refresh">Refresh</button>
        </div>
      </div>
      <div className="panel-body act-table-wrap">
        {error ? <ErrorState title="Activity could not be loaded" message={error} onRetry={load} /> : !events || !shown ? <div className="empty"><span className="spinner" /> Loading activity…</div> : !shown.length ? (
          <div className="empty"><strong>No activity{filtered ? ' matches these filters' : ' recorded yet'}</strong><span>{filtered ? 'Try a wider time range or clear the filters.' : 'Saves, reviews, comments and imports will appear here.'}</span>
            {clientFiltered && next !== null && <span data-testid="activity-truncated">Showing matches within the latest {events.length} entries. Show older activity to look further back.</span>}</div>
        ) : (
          <table className="table act-table">
            <caption className="sr-only">Activity, newest first</caption>
            <thead><tr><th scope="col" className="c-when">When</th><th scope="col" className="c-who">Who</th><th scope="col">What happened</th>{!projectId && <th scope="col" className="c-proj">Project</th>}<th scope="col" className="c-proof"><span className="sr-only">Details</span></th></tr></thead>
            <tbody>
              {days.map((day) => (
                <Fragment key={day.day}>
                  <tr className="act-day"><th scope="colgroup" colSpan={cols}>{dayLabel(day.iso)}</th></tr>
                  {day.entries.map((en) => {
                    if (en.kind === 'one') return <EventRow key={en.e.id} e={en.e} project={project} projectId={projectId} titles={titles} />;
                    const first = en.items[0];
                    const isOpen = !!open[en.key];
                    return (
                      <Fragment key={en.key}>
                        <tr data-testid="activity-row" data-action={first.action} data-count={en.items.length} className="act-group">
                          <td className="c-when"><time title={`${fmtAbs(en.items[en.items.length - 1].at)} – ${fmtAbs(first.at)}`}>{timeRange(en.items)}</time></td>
                          <td className="c-who" title={first.user ?? undefined}>{first.userName ?? <span className="muted">Unknown</span>}</td>
                          <td className="c-what">
                            <button type="button" className="act-toggle" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [en.key]: !o[en.key] }))} data-testid="activity-group-toggle">
                              <span className="act-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span> {en.label} <span className="chip count">× {en.items.length}</span>
                            </button>
                          </td>
                          {!projectId && <ProjectCell e={first} titles={titles} />}
                          <td className="c-proof" />
                        </tr>
                        {isOpen && en.items.map((e) => <EventRow key={e.id} e={e} project={project} projectId={projectId} titles={titles} child groupId={`act-${en.key}`} />)}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        {events && clientFiltered && shown && shown.length > 0 && next !== null && <p className="muted act-truncated" data-testid="activity-truncated">Showing matches within the latest {events.length} entries.</p>}
        {events && next !== null && <div className="act-more"><button type="button" className="btn sm" onClick={more} disabled={loadingMore} data-testid="activity-load-more">{loadingMore ? 'Loading…' : 'Show older activity'}</button></div>}
      </div>
    </div>
  );
}


function ProjectCell({ e, titles }: { e: AuditEventDto; titles: Map<string, string> }) {
  return <td className="c-proj">{!e.projectId ? <span className="muted">—</span> : titles.has(e.projectId) ? <Link to={`/studio/${e.projectId}/activity`} title={`${titles.get(e.projectId)} (${e.projectId})`}>{titles.get(e.projectId)}</Link> : <span className="muted" title="This project no longer exists">{e.projectId} (deleted)</span>}</td>;
}

function EventRow({ e, project, projectId, titles, child, groupId }: { e: AuditEventDto; project: Project | null; projectId: string | null; titles: Map<string, string>; child?: boolean; groupId?: string }) {
  return (
    <tr id={groupId ? `${groupId}-${e.id}` : undefined} data-testid="activity-row" data-action={e.action} className={child ? 'act-child' : undefined}>
      <td className="c-when"><time dateTime={e.at} title={fmtAbs(e.at)}>{timeOf(e.at)}</time></td>
      <td className="c-who" title={e.user ?? undefined}>{e.userName ?? <span className="muted">Unknown</span>}</td>
      <td className="c-what">{auditSentence(e, project)}</td>
      {!projectId && <ProjectCell e={e} titles={titles} />}
      <td className="c-proof">
        <Proof label="Details">
          <span className="act-proof mono" title={JSON.stringify(e.detail ?? {}, null, 1)}><span className="act-code">#{e.id} · {e.action}{e.modelVersion !== null ? ` · v${e.modelVersion}` : ''}{e.user ? ` · ${e.user}` : ''} · {fmtAbs(e.at)}</span>{Object.keys(e.detail ?? {}).length ? JSON.stringify(e.detail) : ''}</span>
        </Proof>
      </td>
    </tr>
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
