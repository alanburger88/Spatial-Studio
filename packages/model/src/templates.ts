import { richFromMarkup } from './rich';
import { deepClone } from './data';
import type { DocNode, DocumentType, Project } from './types';

export interface TemplateInfo {
  id: string;
  title: string;
  documentType: DocumentType;
  description: string;
}

export const TEMPLATES: TemplateInfo[] = [
  { id: 'credit-card-statement', title: 'Credit-card statement', documentType: 'credit-statement', description: 'The Aster Card monthly statement: balance summary, payment guidance driven by rules, transactions, rewards and mandatory disclosures.' },
  { id: 'explanation-of-benefits', title: 'Explanation of benefits', documentType: 'eob', description: 'The HarborCare explanation of benefits: claim amounts, claim message rules, member responsibility and the not-a-bill banner.' },
  { id: 'blank-letter', title: 'Blank letter', documentType: 'credit-statement', description: 'A minimal letter: issuer header, a personalised greeting, one body paragraph and a footer. No rules yet.' },
];

/**
 * The approved sample projects the templates are derived from. The model package does not import the fixture
 * JSON itself (the web bundle must stay small), so the host (API or test) registers `seedProjects()` once.
 */
let seeds: Project[] = [];
export function registerTemplateSeeds(projects: Project[]): void { seeds = projects; }

export interface TemplateOptions {
  projectId: string;
  title: string;
  /** Blank letter only: which sample data the letter is written against. */
  documentType?: DocumentType;
}

function seedFor(documentType: DocumentType, explicit?: Project[]): Project {
  const s = (explicit ?? seeds).find((p) => p.documentType === documentType);
  if (!s) throw new Error('Template seeds are not registered. Call registerTemplateSeeds(seedProjects()) first.');
  return s;
}

export function projectFromTemplate(templateId: string, opts: TemplateOptions, explicitSeeds?: Project[]): Project {
  const info = TEMPLATES.find((t) => t.id === templateId);
  if (!info) throw new Error(`Unknown template ${templateId}.`);
  const docType: DocumentType = templateId === 'blank-letter' ? (opts.documentType ?? info.documentType) : info.documentType;
  const base = deepClone(seedFor(docType, explicitSeeds));
  const { lastSavedAt: _l, ...rest } = base as Project & { lastSavedAt?: string };
  const project: Project = { ...rest, projectId: opts.projectId, title: opts.title, modelVersion: 1 };
  delete (project as any).testCases;
  delete (project as any).derivedFrom;
  if (templateId !== 'blank-letter') return project;

  const byId = new Map(base.nodes.map((n) => [n.id, n]));
  const pick = (id: string): DocNode => deepClone(byId.get(id)!);
  const issuer = project.issuer.name;
  const header = pick('document-header');
  const footer = pick('page-footer');
  footer.headerFooter = { ...footer.headerFooter!, text: `${issuer} (fictional) · Synthetic demonstration — not a legal document` };
  const greeting: DocNode = {
    id: 'greeting', type: 'rich-text', name: 'Greeting', content: richFromMarkup('Dear {{customer.givenName}},'),
    layout: { paged: { mode: 'flow', widthPct: 100, align: 'left', spaceBeforePt: 0 }, html: { area: 'main', span: 12 } },
  };
  const body: DocNode = {
    id: 'letter-body', type: 'rich-text', name: 'Letter body',
    content: richFromMarkup('Write your message here. Keep it short and plain, and add rules later to vary it for different customers.'),
    layout: { paged: { mode: 'flow', widthPct: 100, align: 'left', spaceBeforePt: 10 }, html: { area: 'main', span: 12 } },
  };
  const logo = pick('issuer-logo');
  project.nodes = [
    { id: 'doc-root', type: 'container', name: 'Letter', children: ['issuer-logo', 'document-header', 'page-footer', 'greeting', 'letter-body'] },
    logo, header, footer, greeting, body,
  ];
  project.rules = [];
  project.contentParts = [];
  project.journey = { snapshotPolicy: 'issued-is-immutable', events: [] };
  return project;
}
