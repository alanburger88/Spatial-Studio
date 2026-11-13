import type { ActivityQuery } from './types';

/**
 * Turns a plain question about the activity log ("who approved last week", "saves by Thandi since Monday") into the
 * filters the log understands. Pure: the current time is passed in as `now`; all dates are worked out in UTC.
 *
 * Result conventions:
 *  - `user` is the id of the matched person; `projectId` the id of the matched project.
 *  - `action` is an exact action ("project.save") or a prefix ending in a dot ("workflow.").
 *  - `since` is inclusive and `until` is exclusive, both ISO timestamps. A period that runs up to now has no `until`.
 *  - `text` holds space-separated words to look for in an entry's sentence (all of them): the word for a recognised
 *    area that has no action of its own ("rule", "wording", "translation") followed by every word that was not understood.
 *  - `understood` says what was recognised; `ignored` lists the meaningful words that were not turned into a filter.
 */

export interface ActivityContext { now: string; users?: Array<{ id: string; name: string }>; projects?: Array<{ projectId: string; title: string }> }

/* ------------------------------------------------------------------ dates (UTC, no Intl) */

const DAY = 86400000;
const HOUR = 3600000;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY_RE = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri)';
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fourteen: 14, thirty: 30 };

const startOfDay = (ms: number): number => Math.floor(ms / DAY) * DAY;
const iso = (ms: number): string => new Date(ms).toISOString();
const monthIndex = (word: string): number => MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(word.slice(0, 3)));
const weekdayIndex = (word: string): number => WEEKDAY_NAMES.findIndex((d) => d.toLowerCase().startsWith(word.slice(0, 3)));
const dayWords = (ms: number): string => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`; };
const weekdayWords = (ms: number): string => `${WEEKDAY_NAMES[new Date(ms).getUTCDay()]} ${dayWords(ms)}`;

/** A stretch of time named in the question. `end` is exclusive; `open` periods run up to now and get no upper bound. */
interface Span { start: number; end: number; open: boolean; label: string; from: string; raw: string }

function validDate(y: number, m: number, d: number): number | null {
  if (m < 0 || m > 11 || d < 1 || d > 31 || y < 1970 || y > 2999) return null;
  const ms = Date.UTC(y, m, d);
  const back = new Date(ms);
  return back.getUTCMonth() === m && back.getUTCDate() === d ? ms : null;
}

/* ------------------------------------------------------------------ words */

const STOP = new Set((
  'a an the of in on at to for from by with and or but not no is are was were be been being am do does did done has have had having will would can could should may might must ' +
  'i me my mine we us our you your he she it its they them their this that these those there here what which when where why how who whom whose ' +
  'show shows showing list lists find see get give tell want need look looking search display view pull bring let lets please thanks thank ' +
  'all any every everything anything something nothing some each both either other others more most many much few only just also even still ever yet again ' +
  'change changes changed changing edit edits edited editing update updates updated updating modify modified modification modifications made make makes making ' +
  'happen happened happening happens activity activities log logs logged history entry entries event events action actions thing things stuff item items ' +
  'people person persons someone somebody anyone anybody everyone everybody team colleague colleagues user users project projects document documents doc docs ' +
  'work worked working touch touched did doing during between about around over into out up down off so if then than as too very ' +
  'time times date dates day days week weeks month months year years recent recently lately latest last past previous ago now currently since before after until till ' +
  'whats who\'s whos im ive'
).split(' '));

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plain = (s: string): string => s.toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”"]/g, ' ').replace(/[–—]/g, ' - ').replace(/\s+/g, ' ').trim();
const wordsOf = (s: string): string[] => plain(s).replace(/[^a-z0-9' -]+/g, ' ').split(/[\s-]+/).filter(Boolean);

/** Project-title words that say what kind of document it is, not which project. */
const GENERIC_TITLE = new Set(['statement', 'statements', 'card', 'cards', 'credit', 'explanation', 'benefits', 'demo', 'sample', 'project', 'document', 'letter', 'notice', 'copy', 'draft', 'test', 'bill', 'invoice', 'health', 'plan']);

/* ------------------------------------------------------------------ areas */

interface Area { re: RegExp; action?: string; text?: string; label: string }

/** Order matters: the more specific wording comes first. Action names are the ones the server records. */
const AREAS: Area[] = [
  { re: /\b(?:failed|unsuccessful|rejected) (?:sign[- ]?ins?|log[- ]?ins?|logins?)\b|\bfailed to (?:sign|log) in\b|\bwrong passwords?\b/, action: 'auth.login_failed', label: 'Failed sign-ins' },
  { re: /\b(?:signed|logged|signs|logs|sign|log)[- ]?(?:out|off)\b|\blog[- ]?outs?\b|\bsign[- ]?outs?\b/, action: 'auth.logout', label: 'Sign-outs' },
  { re: /\b(?:signed|logged|signs|logs|sign|log)[- ]?(?:in|on)\b|\blog[- ]?ins?\b|\bsign[- ]?ins?\b/, action: 'auth.login', label: 'Sign-ins' },
  { re: /\b(?:requested|asked for|requests?|requesting) changes\b|\bchanges? requests?\b|\bchanges requested\b|\bsent back\b|\bpushed back\b/, action: 'workflow.request_changes', label: 'Changes requested' },
  { re: /\b(?:submitted|submits?|submitting|sent|send) (?:it |this |them )?for (?:review|approval)\b|\bsubmitted\b|\bsubmissions?\b/, action: 'workflow.submit', label: 'Submitted for review' },
  { re: /\bpublish(?:ed|es|ing)?\b|\bwent live\b/, action: 'workflow.publish', label: 'Published' },
  { re: /\bapprov(?:ed|es|e|als?|ing)\b|\bsign(?:ed)?[- ]offs?\b/, action: 'workflow.approve', label: 'Approvals' },
  { re: /\b(?:moved |sent |put )?back to draft\b/, action: 'workflow.reopen', label: 'Moved back to draft' },
  { re: /\breview(?:s|ed|ing|ers?)?\b|\bworkflow\b/, action: 'workflow.', label: 'Review and approval' },
  { re: /\brepl(?:y|ies|ied|ying)\b/, action: 'comment.reply', label: 'Replies to comments' },
  { re: /\bresolv(?:ed|es|e|ing)\b/, action: 'comment.resolve', label: 'Resolved comments' },
  { re: /\bcomment(?:s|ed|ing)?\b|\bthreads?\b|\bdiscussions?\b|\bfeedback\b/, action: 'comment.', label: 'Comments' },
  { re: /\bbatch(?:es)?(?: runs?)?\b|\bexport(?:s|ed|ing)?\b|\bbulk runs?\b/, action: 'batch.', label: 'Batch runs and exports' },
  { re: /\bimport(?:s|ed|ing)?\b|\buploaded (?:records|customers|data)\b/, action: 'records.import', label: 'Imported records' },
  { re: /\b(?:records|customer files?|customer data)\b/, action: 'records.', label: 'Imported records' },
  { re: /\bupload(?:s|ed|ing)?\b/, action: 'asset.upload', label: 'Uploaded images' },
  { re: /\b(?:images?|pictures?|logos?)\b/, action: 'asset.', label: 'Images' },
  { re: /\buser accounts?\b|\bnew users?\b|\b(?:added|invited|disabled|removed) (?:a |an |the )?users?\b|\broles?\b|\bpermissions?\b|\bpassword resets?\b/, action: 'user.', label: 'User accounts' },
  { re: /\b(?:ai|a\.i\.|assistant|assistants|assist|assisted|suggestions?|suggested)\b/, action: 'assist.', label: 'Changes made with the assistant' },
  { re: /\brestor(?:e|ed|es|ing)\b|\broll(?:ed|s)? back\b|\brollbacks?\b|\brevert(?:ed|s|ing)?\b/, action: 'project.restore', label: 'Restored versions' },
  { re: /\breset(?:s|ting)?\b/, action: 'project.reset', label: 'Resets to the sample' },
  { re: /\brenam(?:e|ed|es|ing)\b/, action: 'project.rename', label: 'Renamed projects' },
  { re: /\bduplicat(?:e|ed|es|ing)\b|\bcopied\b/, action: 'project.duplicate', label: 'Copied projects' },
  { re: /\bdelet(?:ed|es|e|ing) (?:the |a |this )?projects?\b|\bprojects? (?:was |were )?deleted\b/, action: 'project.delete', label: 'Deleted projects' },
  { re: /\bsav(?:e|ed|es|ing)\b/, action: 'project.save', label: 'Saves' },
  { re: /\bversions?\b/, action: 'project.', label: 'Saves and versions' },
  { re: /\bsnapshots?\b/, action: 'snapshots.reset', label: 'Cleared journey snapshots' },
  { re: /\brules?\b|\bconditions?\b|\bpriorit(?:y|ies)\b/, text: 'rule', label: 'Rules' },
  { re: /\btranslat(?:ions?|ed|es|e|ing|ors?)\b|\blanguages?\b|\bspanish\b|\bfrench\b|\bgerman\b|\bportuguese\b/, text: 'translation', label: 'Translations' },
  { re: /\bwording\b|\bcontent\b|\btexts?\b|\bmessages?\b|\bdisclosures?\b/, text: 'wording', label: 'Wording' },
  { re: /\blayouts?\b|\bcomponents?\b/, text: 'component', label: 'Layout and components' },
  { re: /\btest cases?\b|\btests?\b/, text: 'test', label: 'Tests' },
];

const PREFIX_LABEL: Record<string, string> = {
  'auth.': 'Sign-ins and sign-outs', 'workflow.': 'Review and approval', 'comment.': 'Comments', 'batch.': 'Batch runs and exports', 'records.': 'Imported records',
  'asset.': 'Images', 'user.': 'User accounts', 'assist.': 'Changes made with the assistant', 'project.': 'Saves and versions', 'snapshots.': 'Cleared journey snapshots',
};

/* ------------------------------------------------------------------ parser */

export function parseActivityQuery(text: string, ctx: ActivityContext): ActivityQuery {
  const understood: string[] = [];
  const ignored: string[] = [];
  const out: ActivityQuery = { understood, ignored };
  /** Said back in a fixed order: who, what, when, where. */
  const said: { who: string[]; what: string[]; when: string[]; where: string[] } = { who: [], what: [], when: [], where: [] };
  let work = ` ${plain(String(text ?? '')).replace(/[?!;()[\]{}]/g, ' ').replace(/\s+/g, ' ')} `;
  if (!work.trim()) return out;
  const nowMs = Date.parse(ctx.now);
  const clockOk = Number.isFinite(nowMs);
  const today = clockOk ? startOfDay(nowMs) : 0;
  const ignore = (s: string) => { for (const w of wordsOf(s)) if (w.length > 1 && !ignored.includes(w)) ignored.push(w); };
  /** Replaces a recognised stretch with a divider so later patterns cannot run across it. */
  const take = (re: RegExp, on: (m: RegExpExecArray) => string | void): boolean => {
    const m = re.exec(work);
    if (!m) return false;
    const put = on(m);
    work = `${work.slice(0, m.index)} ${typeof put === 'string' ? put : '|'} ${work.slice(m.index + m[0].length)}`.replace(/\s+/g, ' ');
    return true;
  };

  /* ---- people named after "by": before dates, so a person called April or May is a person */
  const users = (ctx.users ?? []).filter((u) => u && typeof u.name === 'string' && u.name.trim());
  const nameForms = (u: { id: string; name: string }): string[] => {
    const ws = wordsOf(u.name);
    const single = [ws[0], ws[ws.length - 1]].filter((w, i, a) => w && w.length >= 2 && a.indexOf(w) === i && users.filter((o) => { const ow = wordsOf(o.name); return ow[0] === w || ow[ow.length - 1] === w; }).length === 1);
    return [ws.join(' '), ...single, plain(u.id)].filter((f, i, a) => f && a.indexOf(f) === i);
  };
  const findUser = (prefix: string): boolean => {
    let best: { u: { id: string; name: string }; re: RegExp; len: number } | null = null;
    for (const u of users) for (const f of nameForms(u)) {
      const re = new RegExp(`${prefix}(?<![a-z0-9@.])${esc(f)}(?:'s)?(?![a-z0-9@])`);
      if (re.test(work) && (!best || f.length > best.len)) best = { u, re, len: f.length };
    }
    if (!best) return false;
    const hit = best;
    take(hit.re, () => undefined);
    if (!out.user) { out.user = hit.u.id; said.who.push(`By ${hit.u.name.trim()}`); } else if (out.user !== hit.u.id) ignore(hit.u.name);
    return true;
  };
  findUser('\\b(?:by|from) ');

  /* ---- dates and periods become numbered markers */
  const spans: Span[] = [];
  const mark = (s: Omit<Span, 'raw'>, raw: string): string => { spans.push({ ...s, raw: raw.trim() }); return `@${spans.length - 1}@`; };
  const daySpan = (ms: number, label?: string): Omit<Span, 'raw'> => ({ start: ms, end: ms + DAY, open: false, label: label ?? dayWords(ms), from: dayWords(ms) });
  const inferYear = (m: number, d: number): number => {
    const y = new Date(nowMs).getUTCFullYear();
    const ms = validDate(y, m, d);
    return ms !== null && ms > nowMs ? y - 1 : y;
  };
  if (clockOk) {
    // 2026-11-12 (a time of day after it is dropped: the log is filtered by day)
    while (take(/\b(\d{4})-(\d{2})-(\d{2})(?:t[\d:.]+(?:z|[+-]\d{2}:?\d{2})?)?(?![\d-])/, (m) => {
      const ms = validDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return ms === null ? ' ' : mark(daySpan(ms), m[0]);
    })) { /* all of them */ }
    // 12 Nov, 12th of November 2026
    while (take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MONTH_RE}\\b\\.?(?:,? (\\d{4}))?(?![\\d-])`), (m) => {
      const mo = monthIndex(m[2]), d = Number(m[1]);
      const ms = validDate(m[3] ? Number(m[3]) : inferYear(mo, d), mo, d);
      return ms === null ? ' ' : mark(daySpan(ms), m[0]);
    })) { /* all of them */ }
    // Nov 12, November 12th 2026
    while (take(new RegExp(`\\b${MONTH_RE}\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b(?:,? (\\d{4}))?(?![\\d-])`), (m) => {
      const mo = monthIndex(m[1]), d = Number(m[2]);
      const ms = validDate(m[3] ? Number(m[3]) : inferYear(mo, d), mo, d);
      return ms === null ? ' ' : mark(daySpan(ms), m[0]);
    })) { /* all of them */ }
    // November 2026, or a month name after in / during / since / from / until / before / after
    const monthSpan = (mo: number, y: number): Omit<Span, 'raw'> => {
      const start = Date.UTC(y, mo, 1), end = Date.UTC(y, mo + 1, 1);
      return { start, end, open: false, label: `${MONTH_NAMES[mo]} ${y}`, from: dayWords(start) };
    };
    while (take(new RegExp(`\\b${MONTH_RE}\\.?,? (\\d{4})\\b`), (m) => mark(monthSpan(monthIndex(m[1]), Number(m[2])), m[0]))) { /* all of them */ }
    while (take(new RegExp(`\\b(in|during|since|from|until|till|before|after|through|to|and) ${MONTH_RE}\\b\\.?(?! \\d)`), (m) => {
      const mo = monthIndex(m[2]);
      const y = new Date(nowMs).getUTCFullYear();
      return `${m[1]} ${mark(monthSpan(mo, Date.UTC(y, mo, 1) > nowMs ? y - 1 : y), m[2])}`;
    })) { /* all of them */ }

    // rolling periods: last 7 days, past two weeks, last 24 hours, the last hour
    const unitMs: Record<string, number> = { hour: HOUR, day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY };
    while (take(/\b(?:(?:in|over|during|for|within) )?(?:the )?(last|past|previous) (\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fourteen|thirty) (hour|day|week|month|year)s?\b/, (m) => {
      const n = /^\d+$/.test(m[2]) ? Number(m[2]) : NUMBER_WORDS[m[2]] ?? 1;
      const start = nowMs - n * unitMs[m[3]];
      const what = `Last ${n === 1 ? m[3] : `${n} ${m[3]}s`}`;
      return mark({ start, end: nowMs, open: true, label: `${what} (since ${dayWords(start)})`, from: dayWords(start) }, m[0]);
    })) { /* all of them */ }
    take(/\b(?:(?:in|over|during|within) )?(?:the )?(?:last|past) (hour|day)\b|\b(?:(?:in|over|during|within) )?(?:the )?past (week|month|year)\b/, (m) => {
      const unit = m[1] ?? m[2];
      const start = nowMs - unitMs[unit];
      return mark({ start, end: nowMs, open: true, label: `Last ${unit === 'day' ? '24 hours' : unit} (since ${dayWords(start)})`, from: dayWords(start) }, m[0]);
    });
    // 3 days ago
    while (take(/\b(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten) (day|week)s? ago\b/, (m) => {
      const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]] ?? 1;
      return mark(daySpan(today - n * (m[2] === 'week' ? 7 : 1) * DAY), m[0]);
    })) { /* all of them */ }

    // calendar periods
    const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
    const d0 = new Date(today);
    const y0 = d0.getUTCFullYear(), m0 = d0.getUTCMonth();
    take(/\b(?:the )?(?:last|previous) week\b/, (m) => mark({ start: monday - 7 * DAY, end: monday, open: false, label: `Last week (${dayWords(monday - 7 * DAY)} to ${dayWords(monday - DAY)})`, from: weekdayWords(monday - 7 * DAY) }, m[0]));
    take(/\bthis week\b/, (m) => mark({ start: monday, end: monday + 7 * DAY, open: true, label: `This week (since ${weekdayWords(monday)})`, from: weekdayWords(monday) }, m[0]));
    take(/\b(?:the )?(?:last|previous) month\b/, (m) => { const s = Date.UTC(y0, m0 - 1, 1); return mark({ start: s, end: Date.UTC(y0, m0, 1), open: false, label: `Last month (${MONTH_NAMES[new Date(s).getUTCMonth()]} ${new Date(s).getUTCFullYear()})`, from: dayWords(s) }, m[0]); });
    take(/\bthis month\b/, (m) => { const s = Date.UTC(y0, m0, 1); return mark({ start: s, end: Date.UTC(y0, m0 + 1, 1), open: true, label: `This month (since ${dayWords(s)})`, from: dayWords(s) }, m[0]); });
    take(/\b(?:the )?(?:last|previous) year\b/, (m) => mark({ start: Date.UTC(y0 - 1, 0, 1), end: Date.UTC(y0, 0, 1), open: false, label: `Last year (${y0 - 1})`, from: dayWords(Date.UTC(y0 - 1, 0, 1)) }, m[0]));
    take(/\bthis year\b/, (m) => mark({ start: Date.UTC(y0, 0, 1), end: Date.UTC(y0 + 1, 0, 1), open: true, label: `This year (since ${dayWords(Date.UTC(y0, 0, 1))})`, from: dayWords(Date.UTC(y0, 0, 1)) }, m[0]));
    take(/\byesterday\b/, (m) => mark({ ...daySpan(today - DAY, `Yesterday (${dayWords(today - DAY)})`), from: `yesterday (${dayWords(today - DAY)})` }, m[0]));
    take(/\b(?:today|this morning|this afternoon|this evening|tonight)\b/, (m) => mark({ start: today, end: today + DAY, open: true, label: `Today (${dayWords(today)})`, from: `today (${dayWords(today)})` }, m[0]));
    // weekdays: the most recent one; "last Monday" is never today
    while (take(new RegExp(`\\b(?:(last|this|on) )?${WEEKDAY_RE}\\b`), (m) => {
      let back = (new Date(today).getUTCDay() - weekdayIndex(m[2]) + 7) % 7;
      if (back === 0 && m[1] === 'last') back = 7;
      const ms = today - back * DAY;
      return mark({ start: ms, end: ms + DAY, open: back === 0, label: weekdayWords(ms), from: weekdayWords(ms) }, m[0]);
    })) { /* all of them */ }

    // how the first period is meant: a range, "since", "before", "until", or the period itself
    const S = (i: string): Span => spans[Number(i)];
    const setTime = (since: number | undefined, until: number | undefined, label: string) => {
      if (out.since === undefined && out.until === undefined) {
        if (since !== undefined) out.since = iso(since);
        if (until !== undefined) out.until = iso(until);
        said.when.push(label);
        return true;
      }
      return false;
    };
    take(/\b(?:from|between) @(\d+)@ (?:to|and|until|till|through|-) @(\d+)@/, (m) => {
      const a = S(m[1]), b = S(m[2]);
      if (b.end <= a.start) { ignore(`${a.raw} ${b.raw}`); return; }
      setTime(a.start, b.open ? undefined : b.end, `From ${a.from} to ${b.open ? 'now' : dayWords(b.end - DAY)}`);
    });
    take(/@(\d+)@ (?:to|until|till|through|-) @(\d+)@/, (m) => {
      const a = S(m[1]), b = S(m[2]);
      if (b.end <= a.start || !setTime(a.start, b.open ? undefined : b.end, `From ${a.from} to ${b.open ? 'now' : dayWords(b.end - DAY)}`)) ignore(`${a.raw} ${b.raw}`);
    });
    while (take(/(?:\b(since|from|starting|after|before|until|till|up to|through|on|in|during|at) )?@(\d+)@/, (m) => {
      const s = S(m[2]);
      const how = m[1] ?? '';
      let ok: boolean;
      if (how === 'since' || how === 'from' || how === 'starting') ok = setTime(s.start, undefined, `Since ${s.from}`);
      else if (how === 'after') ok = s.open ? false : setTime(s.end, undefined, `After ${dayWords(s.end - DAY)}`);
      else if (how === 'before') ok = setTime(undefined, s.start, `Before ${s.from}`);
      else if (how === 'until' || how === 'till' || how === 'up to' || how === 'through') ok = setTime(undefined, s.open ? undefined : s.end, s.open ? 'Up to now' : `Up to and including ${dayWords(s.end - DAY)}`);
      else ok = setTime(s.start, s.open ? undefined : s.end, s.label);
      if (!ok) ignore(s.raw);
    })) { /* every marker is consumed; only the first sets the period */ }
  }

  /* ---- people */
  while (findUser('')) { /* a second, different person is reported as ignored */ }
  const asksWho = /\b(?:who|whom|whose|who's|whos)\b/.test(work);
  // "by me", "my changes": the question does not say who is asking, so this cannot become a filter
  if (!out.user && take(/\b(?:by|from) (?:me|myself)\b|\bmy(?: own)?\b|\bmine\b|\bi\b/, () => undefined)) ignore('me');
  // a name after "by" that is nobody we know
  if (!out.user) take(/\bby ([a-z][a-z'-]+(?: [a-z][a-z'-]+)?)\b/, (m) => { const unknown = m[1].split(' ').filter((w) => !STOP.has(w)); if (unknown.length) ignore(unknown.join(' ')); else return ` ${m[1]} `; });

  /* ---- projects */
  const projects = (ctx.projects ?? []).filter((p) => p && typeof p.projectId === 'string');
  const projectForms = (p: { projectId: string; title: string }): string[] => {
    const title = plain(p.title ?? '');
    const whole = wordsOf(title).join(' ');
    const lead = wordsOf(title.split(/ - |: | \(|,/)[0] ?? '').join(' ');
    const distinctive = wordsOf(title).filter((w) => w.length >= 4 && !GENERIC_TITLE.has(w) && !STOP.has(w) && projects.filter((o) => wordsOf(o.title ?? '').includes(w)).length === 1);
    return [whole, lead, plain(p.projectId), wordsOf(p.projectId).join(' '), ...distinctive].filter((f, i, a) => f && f.length >= 3 && a.indexOf(f) === i);
  };
  {
    let best: { p: { projectId: string; title: string }; re: RegExp; len: number } | null = null;
    for (const p of projects) for (const f of projectForms(p)) {
      const re = new RegExp(`\\b(?:(?:in|on|for|of) )?(?:the )?(?:project )?(?<![a-z0-9])${esc(f).replace(/ /g, '[ -]')}(?![a-z0-9])(?: project)?`);
      if (re.test(work) && (!best || f.length > best.len)) best = { p, re, len: f.length };
    }
    if (best) {
      const hit = best;
      take(hit.re, () => undefined);
      out.projectId = hit.p.projectId;
      said.where.push(`Project “${(hit.p.title ?? hit.p.projectId).trim()}”`);
    }
  }

  /* ---- areas */
  const hits: Array<{ area: Area; at: number; raw: string }> = [];
  for (const area of AREAS) {
    for (;;) {
      const m = area.re.exec(work);
      if (!m) break;
      hits.push({ area, at: m.index, raw: m[0] });
      work = `${work.slice(0, m.index)}${' '.repeat(m[0].length)}${work.slice(m.index + m[0].length)}`;
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const actionHits = hits.filter((h) => h.area.action);
  if (actionHits.length) {
    const first = actionHits[0];
    const prefix = `${first.area.action!.split('.')[0]}.`;
    const family = actionHits.filter((h) => h.area.action!.startsWith(prefix));
    const specific = [...new Set(family.map((h) => h.area.action!).filter((a) => a !== prefix))];
    // "resolved comments" is the resolving; "review and approval" is the whole review step
    const narrow = specific.length === 1 && (family.every((h) => h.area.action === specific[0]) || prefix !== 'workflow.');
    const chosen = narrow ? family.find((h) => h.area.action === specific[0])! : family.length === 1 ? first : null;
    out.action = chosen ? chosen.area.action! : prefix;
    said.what.push(chosen ? chosen.area.label : PREFIX_LABEL[prefix] ?? first.area.label);
    for (const h of actionHits) if (!family.includes(h)) ignore(h.raw);
  }
  const stems: string[] = [];
  for (const h of hits) if (h.area.text && !stems.includes(h.area.text)) { stems.push(h.area.text); said.what.push(h.area.label); }

  if (asksWho && !out.user) said.who.push('Anyone (each entry shows who did it)');
  understood.push(...said.who, ...said.what, ...said.when, ...said.where);

  /* ---- what is left */
  const leftover = work.replace(/@\d+@/g, ' ').replace(/[|,.:/]/g, ' ').split(/\s+/).map((w) => w.replace(/^['-]+|['-]+$/g, '')).filter((w) => w.length > 1 && /[a-z0-9]/.test(w) && !STOP.has(w) && !STOP.has(w.replace(/'s$/, '')));
  const unknown = leftover.filter((w, i, a) => a.indexOf(w) === i && !ignored.includes(w));
  const textWords = [...stems, ...unknown];
  for (const w of unknown) ignored.push(w);
  if (textWords.length) out.text = textWords.join(' ');
  return out;
}
