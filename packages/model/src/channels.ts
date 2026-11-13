import type { ChannelConfig, EmailSectionId, Project } from './types';

/**
 * Email and SMS wording. The defaults reproduce the fixed wording the channel renderers used before the wording became
 * editable, so an untouched project composes exactly the same email and SMS as before.
 *
 * Texts are plain sentences with `{{data.field}}` tokens (the same allowlisted fields as document text) plus four
 * channel tokens: `{{issuer.name}}`, `{{issuer.product}}`, `{{keyFacts}}` (the "label: value" list of the key figures)
 * and `{{link}}` (the first https action link of the document; when there is none, the sentence part holding it is dropped).
 */
export const CHANNEL_TOKENS = ['issuer.name', 'issuer.product', 'keyFacts', 'link'] as const;
export const EMAIL_SECTION_IDS: EmailSectionId[] = ['keyFacts', 'messages', 'tables', 'summaries', 'actions'];
export const EMAIL_SECTION_LABELS: Record<EmailSectionId, string> = {
  keyFacts: 'Key figures', messages: 'Selected messages', tables: 'Short tables', summaries: 'Summaries of long tables and charts', actions: 'Action buttons',
};
export const CHANNEL_TEXT_LIMITS = { subject: 200, preheader: 200, title: 120, keyFactsHeading: 80, intro: 2000, closing: 2000, sms: 1000 } as const;

export function defaultChannels(project: Pick<Project, 'documentType'>): ChannelConfig {
  const sections = EMAIL_SECTION_IDS.map((id) => ({ id, show: true }));
  if (project.documentType === 'custom') {
    // A document with its own data: nothing is known about what it shows, so the wording names only the issuer,
    // the key figures (when the document has any) and the link (when it has one).
    return {
      email: {
        subject: 'Your {{issuer.name}} document is ready',
        preheader: 'Your {{issuer.name}} document is ready. {{keyFacts}}',
        title: 'Your document is ready',
        intro: '', closing: '', keyFactsHeading: 'Key facts', sections,
      },
      sms: { text: 'DEMO {{issuer.name}}: Your document is ready. Details: {{link}}' },
    };
  }
  if (project.documentType === 'eob') {
    return {
      email: {
        subject: 'Your {{issuer.name}} Explanation of Benefits is ready — this is not a bill',
        preheader: 'THIS IS NOT A BILL. {{keyFacts}}',
        title: 'Your Explanation of Benefits is ready',
        intro: '', closing: '', keyFactsHeading: 'Key facts', sections,
      },
      sms: { text: 'DEMO {{issuer.name}}: Your Explanation of Benefits for claim {{claim.claimId}} is ready. THIS IS NOT A BILL. Details: {{link}}' },
    };
  }
  return {
    email: {
      subject: 'Your {{issuer.product}} statement is ready — {{card.minimumDueCents}} minimum due {{card.dueDate}}',
      preheader: '{{keyFacts}}',
      title: 'Your statement is ready',
      intro: '', closing: '', keyFactsHeading: 'Key facts', sections,
    },
    sms: { text: 'DEMO {{issuer.name}}: Your statement is ready. New balance {{card.newBalanceCents}}; minimum due {{card.minimumDueCents}} by {{card.dueDate}}. {{link}}' },
  };
}

/** The effective channel settings: the project's own where set, the defaults elsewhere; every section listed exactly once. */
export function channelConfig(project: Pick<Project, 'documentType' | 'channels'>): ChannelConfig {
  const d = defaultChannels(project);
  const c = project.channels;
  if (!c) return d;
  const listed = (c.email?.sections ?? []).filter((s) => EMAIL_SECTION_IDS.includes(s.id));
  const sections = [...listed.filter((s, i) => listed.findIndex((x) => x.id === s.id) === i), ...d.email.sections.filter((s) => !listed.some((x) => x.id === s.id))];
  return { email: { ...d.email, ...c.email, sections }, sms: { ...d.sms, ...c.sms } };
}

/** The translatable channel texts, by string id. Empty optional texts are left out. */
export function channelStrings(project: Pick<Project, 'documentType' | 'channels'>): Array<{ id: string; title: string; source: string }> {
  const c = channelConfig(project);
  return [
    { id: '@email/subject', title: 'Email · subject line', source: c.email.subject },
    { id: '@email/preheader', title: 'Email · preview text', source: c.email.preheader },
    { id: '@email/title', title: 'Email · heading', source: c.email.title },
    { id: '@email/intro', title: 'Email · opening text', source: c.email.intro },
    { id: '@email/keyFactsHeading', title: 'Email · key figures heading', source: c.email.keyFactsHeading },
    { id: '@email/closing', title: 'Email · closing text', source: c.email.closing },
    { id: '@sms/text', title: 'SMS · message', source: c.sms.text },
  ].filter((s) => s.source.trim());
}

/** Writes a (translated) channel text back onto a channel config copy. */
export function setChannelString(c: ChannelConfig, id: string, text: string): void {
  if (id === '@sms/text') c.sms.text = text;
  else if (id.startsWith('@email/')) {
    const k = id.slice('@email/'.length) as 'subject' | 'preheader' | 'title' | 'intro' | 'closing' | 'keyFactsHeading';
    if (k in c.email && k !== ('sections' as string)) (c.email as unknown as Record<string, string>)[k] = text;
  }
}
