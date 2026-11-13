import { richFromMarkup } from './rich';
import { deepClone } from './data';
import type { DocNode, DocumentType, Project } from './types';

export interface TemplateInfo {
  id: string;
  title: string;
  documentType: DocumentType;
  description: string;
  /** `builtin` = shipped with the studio; `saved` = published from a document by an approver or admin. Absent means built-in. */
  source?: 'builtin' | 'saved';
  /** Saved templates only: the latest version number, and every version, newest first. */
  version?: number;
  versions?: TemplateVersionInfo[];
  /** Saved templates only: hidden from the "New project" list, but kept (projects started from it still name it). */
  retired?: boolean;
}

/** One frozen version of a saved template. */
export interface TemplateVersionInfo {
  version: number;
  savedAt: string;
  savedBy: { id: string; name: string } | null;
  /** What changed in this version, in the saver's words. */
  note: string;
  /** The document and saved version it was taken from. */
  from: { projectId: string; title: string; modelVersion: number };
  /** Counted at save time, so the list can describe a version without loading it. */
  counts: TemplateCounts;
}
export interface TemplateCounts { components: number; rules: number; messages: number; languages: number; tests: number }

export const TEMPLATE_TITLE_MAX = 80;
export const TEMPLATE_DESCRIPTION_MAX = 300;
export const TEMPLATE_NOTE_MAX = 200;

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

/* ------------------------------------------------------------------ saved templates */

/** The identity and bookkeeping a project carries that a template (or a project file being imported) must not. */
const IDENTITY_KEYS = ['lastSavedAt', 'derivedFrom', 'fromTemplate', 'importedFrom'] as const;

export function templateCounts(p: Project): TemplateCounts {
  return { components: p.nodes.length, rules: p.rules.length, messages: p.contentParts.length, languages: (p.languages ?? ['es-US']).length, tests: (p.testCases ?? []).length };
}

/**
 * What a saved template keeps from a document: everything a new document should start with
 * (layout, rules, wording, translations, email and SMS wording, glossary, styles, brand, pinned tests),
 * and nothing that belongs to the one document (its id and title, version number, save time, where it came from).
 * Customers, version history, review state and comments are stored outside the project and never travel.
 */
export function templateContentOf(project: Project): Project {
  const content = deepClone(project) as Project & Record<string, unknown>;
  for (const k of IDENTITY_KEYS) delete content[k];
  content.projectId = 'template';
  content.modelVersion = 1;
  return content;
}

/** A new editable document from a saved template version. */
export function projectFromSavedTemplate(content: Project, opts: { projectId: string; title: string; templateId: string; version: number; templateTitle: string }): Project {
  const p = deepClone(content) as Project & Record<string, unknown>;
  for (const k of IDENTITY_KEYS) delete p[k];
  return { ...(p as Project), projectId: opts.projectId, title: opts.title, modelVersion: 1, fromTemplate: { templateId: opts.templateId, version: opts.version, title: opts.templateTitle } };
}

/* ------------------------------------------------------------------ project files */

export const PROJECT_FILE_FORMAT = 'iss-project';

export interface ProjectFileProblem { code: string; message: string }

const SAFE_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const SAFE_LINK = /^(https?:|mailto:|tel:|#|\/)/i;

/**
 * Structural checks on a project read from a file, beyond what a normal save checks: a file can come from anywhere.
 * Returns every problem found (empty = the file can be opened). Never throws.
 */
export function projectFileProblems(raw: unknown): ProjectFileProblem[] {
  const out: ProjectFileProblem[] = [];
  const bad = (code: string, message: string) => { out.push({ code, message }); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [{ code: 'NOT_A_PROJECT', message: 'The file does not contain a studio project.' }];
  const p = raw as Record<string, any>;
  for (const k of ['nodes', 'rules', 'contentParts', 'presentationProfiles']) if (!Array.isArray(p[k])) bad('NOT_A_PROJECT', `The file has no "${k}" list, so it is not a studio project.`);
  if (out.length) return out;
  if (typeof p.schemaVersion !== 'string') bad('SCHEMA_VERSION', 'The file does not say which project format version it uses.');
  if (typeof p.title !== 'string' || !p.title.trim()) bad('TITLE', 'The project in the file has no title.');
  if (p.documentType !== 'credit-statement' && p.documentType !== 'eob') bad('DOCUMENT_TYPE', `The file is for a kind of document this studio does not have data for (${String(p.documentType)}).`);
  if (!p.issuer || typeof p.issuer !== 'object' || typeof p.issuer.name !== 'string') bad('ISSUER', 'The project in the file has no issuer.');
  if (!p.journey || typeof p.journey !== 'object' || !Array.isArray(p.journey.events)) bad('JOURNEY', 'The project in the file has no journey.');
  const ids = new Set<string>();
  for (const n of p.nodes as any[]) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !n.id || typeof n.type !== 'string') { bad('COMPONENT', 'A component in the file has no id or type.'); continue; }
    if (ids.has(n.id)) bad('COMPONENT', `Two components share the id "${n.id}".`);
    ids.add(n.id);
  }
  if (typeof p.rootNodeId !== 'string' || !ids.has(p.rootNodeId)) bad('ROOT', 'The file does not name a top-level component that exists.');
  const called = (n: any) => (typeof n?.name === 'string' && n.name.trim() ? n.name.trim().slice(0, 60) : String(n?.id));
  for (const n of p.nodes as any[]) {
    if (!n || typeof n !== 'object') continue;
    if (n.children !== undefined) {
      if (!Array.isArray(n.children)) bad('COMPONENT', `The component “${called(n)}” has a broken list of contents.`);
      else for (const c of n.children) if (!ids.has(c)) bad('COMPONENT', `The component “${called(n)}” contains “${String(c).slice(0, 60)}”, which is not in the file.`);
    }
    const src = n.image?.src;
    if (typeof src === 'string' && /^[a-z][a-z0-9+.-]*:|^\/\//i.test(src) && !SAFE_IMAGE.test(src) && !/^asset:[a-z0-9-]+$/.test(src)) bad('IMAGE', `The image “${called(n)}” points outside the file. Only images stored in the file (PNG, JPEG or WebP) can be imported.`);
    for (const href of [n.action?.url, n.qr?.url]) if (typeof href === 'string' && href && !SAFE_LINK.test(href) && !href.includes('{{') && /^[a-z][a-z0-9+.-]*:/i.test(href)) bad('LINK', `The link in “${called(n)}” is not a web, email or phone link.`);
  }
  const logo = p.brand?.logoDataUri;
  if (typeof logo === 'string' && logo && !SAFE_IMAGE.test(logo)) bad('IMAGE', 'The brand logo points outside the file. Only an image stored in the file can be imported.');
  const partIds = new Set<string>();
  for (const c of p.contentParts as any[]) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id) { bad('MESSAGE', 'A message in the file has no id.'); continue; }
    if (partIds.has(c.id)) bad('MESSAGE', `Two messages share the id "${c.id}".`);
    partIds.add(c.id);
  }
  const ruleIds = new Set<string>();
  for (const r of p.rules as any[]) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) { bad('RULE', 'A rule in the file has no id.'); continue; }
    if (ruleIds.has(r.id)) bad('RULE', `Two rules share the id "${r.id}".`);
    ruleIds.add(r.id);
  }
  return out.slice(0, 20);
}

/** A project file is either the bare project (what "Export project" downloads) or an envelope `{ format: "iss-project", project }`. */
export function projectInFile(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as any).format === PROJECT_FILE_FORMAT && (raw as any).project) return (raw as any).project;
  return raw;
}
