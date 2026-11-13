import { SETUP_FIELD_TYPE_LABEL, type Project, type SetupField, type SetupSection, type SetupSpec } from '@iss/model';
import { ruleWording } from './ruleDraft';

/**
 * What a document setup will create, in plain words: for a person to read before they approve it.
 * The fields and sections come from the cleaned setup; "shown when …" is restated from the rules of the project that
 * was actually built from it, so the sentence a person reads is the condition the engine will test.
 */
export interface SetupOutline {
  /** One line per data field. */
  fields: Array<{ label: string; kind: string; detail: string; required: boolean }>;
  /** One entry per section, top to bottom. A message lists its versions in the order they are tried. */
  sections: Array<{ kind: string; text: string; versions?: Array<{ title: string; shownWhen: string; fallback: boolean }> }>;
  email: { subject: string; intro: string } | null;
  sms: string | null;
  /** The whole outline as sentences, for a plain list. */
  lines: string[];
}

const q = (s: string): string => `“${s}”`;
const clip = (s: string, max = 90): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t; };
const list = (items: string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const COLUMN_WORD: Record<string, string> = { text: 'text', number: 'whole number', amount: 'amount', date: 'date' };

function fieldDetail(f: SetupField): string {
  if (f.type === 'choice') return `One of ${list((f.choices ?? []).map(q))}`;
  if (f.type === 'list') return `Columns: ${list((f.columns ?? []).map((c) => `${c.label} (${COLUMN_WORD[c.type]})`))}`;
  if (f.example === undefined) return '';
  return `For example ${f.type === 'amount' ? `$${f.example}` : f.example}`;
}

const SECTION_KIND: Record<SetupSection['type'], string> = { heading: 'Heading', paragraph: 'Paragraph', keyFigures: 'Key figures', table: 'Table', messages: 'Message', notice: 'Notice', action: 'Button', divider: 'Divider' };

export function setupOutline(spec: SetupSpec, project: Project): SetupOutline {
  const fields = spec.fields.map((f) => ({ label: f.label, kind: SETUP_FIELD_TYPE_LABEL[f.type], detail: fieldDetail(f), required: !!f.required }));
  const sections = spec.sections.map((s, i): SetupOutline['sections'][number] => {
    const kind = SECTION_KIND[s.type];
    switch (s.type) {
      case 'heading': return { kind, text: q(clip(s.text)) };
      case 'paragraph': return { kind, text: q(clip(s.text)) };
      case 'keyFigures': return { kind, text: list(s.fields) };
      case 'table': return { kind, text: `${s.list}: ${list(s.columns ?? [])}${s.totalColumn ? `, with the total of ${s.totalColumn}` : ''}` };
      case 'notice': return { kind, text: q(clip(s.text)) };
      case 'action': return { kind, text: `${q(s.label)} opens ${s.url}` };
      case 'divider': return { kind, text: 'A line across the page' };
      case 'messages': {
        // The component built for this section and the rules that choose its versions.
        const node = project.nodes.find((n) => n.id === `message-${i + 1}`);
        const built = new Set(node?.variantIds ?? []);
        const versions = s.versions.map((v, k) => ({ v, id: `message-${i + 1}-v${k + 1}` })).filter((x) => built.has(x.id)).map(({ v, id }) => {
          const rule = project.rules.find((r) => r.then.op === 'selectVariant' && r.then.targetNodeId === node!.id && r.then.variantId === id);
          const fallback = node!.fallbackVariantId === id;
          return { title: v.title, fallback, shownWhen: fallback ? 'Shown when no other version applies.' : rule ? `Shown when ${ruleWording.condition(project, rule.when)}.` : 'Never shown: it has no rule.' };
        });
        const order = versions.filter((v) => !v.fallback).length > 1 ? ' The versions are tried in the order listed; the first that applies is shown.' : '';
        return { kind, text: `${s.name}: ${versions.length} version${versions.length === 1 ? '' : 's'}.${order}`, versions };
      }
    }
  });
  const email = spec.email ? { subject: spec.email.subject, intro: spec.email.intro } : null;
  const sms = spec.sms ?? null;

  const lines: string[] = [];
  lines.push(fields.length ? `${fields.length} data field${fields.length === 1 ? '' : 's'}:` : 'No data fields.');
  for (const f of fields) lines.push(`${f.label}: ${f.kind.toLowerCase()}${f.required ? ', required' : ''}${f.detail ? `. ${f.detail}` : ''}.`);
  lines.push(sections.length ? `${sections.length} section${sections.length === 1 ? '' : 's'}, from top to bottom:` : 'No sections.');
  for (const s of sections) {
    lines.push(`${s.kind}: ${s.text}`);
    for (const v of s.versions ?? []) lines.push(`${q(v.title)}: ${v.shownWhen}`);
  }
  if (email?.subject) lines.push(`Email subject: ${q(email.subject)}`);
  if (email?.intro) lines.push(`Email opening text: ${q(clip(email.intro, 160))}`);
  if (sms) lines.push(`Text message: ${q(sms)}`);
  if (!email && !sms) lines.push('The email and the text message keep the standard wording.');
  return { fields, sections, email, sms, lines };
}
