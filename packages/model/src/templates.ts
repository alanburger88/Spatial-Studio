import { richFromMarkup } from './rich';
import { deepClone } from './data';
import { validateCustomFields } from './fields';
import { pageDesignProblems } from './pageDesign';
import { SCHEMA_VERSION, isDocumentType } from './types';
import type { DocNode, DocumentType, PresentationProfile, Project } from './types';

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

/** The starter that begins from nothing: an empty page and the project's own data fields. */
export const BLANK_PROJECT_TEMPLATE_ID = 'blank-project';

export const TEMPLATES: TemplateInfo[] = [
  { id: 'credit-card-statement', title: 'Credit-card statement', documentType: 'credit-statement', description: 'The Aster Card monthly statement: balance summary, payment guidance driven by rules, transactions, rewards and mandatory disclosures.' },
  { id: 'explanation-of-benefits', title: 'Explanation of benefits', documentType: 'eob', description: 'The HarborCare explanation of benefits: claim amounts, claim message rules, member responsibility and the not-a-bill banner.' },
  { id: 'blank-letter', title: 'Blank letter', documentType: 'credit-statement', description: 'A minimal letter: issuer header, a personalised greeting, one body paragraph and a footer. No rules yet.' },
  { id: BLANK_PROJECT_TEMPLATE_ID, title: 'Blank project', documentType: 'custom', description: 'An empty page with your own data fields: only the customer’s name and language are given. You add the fields, the layout and the rules, and the studio generates customers to preview with.' },
];

/**
 * The page and web profiles every project starts with: US Letter pages with 14 mm margins (and the flow region that
 * leaves room for a first-page header), the AFP feasibility simulation of the same pages, and the responsive web page.
 * A fresh copy on every call. The two sample projects use exactly these.
 */
export function defaultPresentationProfiles(): PresentationProfile[] {
  const flowRegion = { firstPageTopPt: 184, otherPagesTopPt: 84, bottomPt: 738 };
  return [
    { id: 'paged-pdf', kind: 'paged', paper: 'US-Letter', pageMarginsMm: [14, 14, 14, 14], flowRegion: { ...flowRegion } },
    {
      id: 'paged-afp-sim', kind: 'afp-simulation', paper: 'US-Letter', duplex: false, simulationOnly: true,
      pageMarginsMm: [14, 14, 14, 14],
      flowRegion: { ...flowRegion },
      afp: {
        formdef: 'F1ISSSIM (conceptual)',
        pagedef: 'P1LTR01 (conceptual)',
        fontMap: { 'Inter Regular': 'X0ISS10 (concept mapping)', 'Inter Bold': 'X0ISSB0 (concept mapping)' },
        overlays: ['O1ISSHDR (issuer header, concept)'],
        resources: ['Page segment: issuer mark (concept)', 'Code page: T1001208 (concept)', 'Coded font mapping (concept)', 'Medium map: simplex letter (concept)'],
      },
    },
    { id: 'html-responsive', kind: 'responsive', breakpointsPx: [600, 960] },
  ];
}

/** The issuer colour a blank project gets when none is chosen: a neutral slate that reads on white and under white button text. */
export const NEUTRAL_ACCENT = '#475569';
export const ISSUER_NAME_MIN = 2;
export const ISSUER_NAME_MAX = 60;
export const ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/;

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
  /** Blank project only: who the document is from (defaults to the title). */
  issuerName?: string;
  /** Blank project only: the issuer's colour as `#rrggbb` (defaults to a neutral slate). */
  accent?: string;
}

/**
 * A project built from nothing: no sample logo, header, footer, wording, rules or data fields. One empty page (the
 * root container with no components), English only, the standard page and web profiles, and the user's own issuer.
 */
export function blankProject(opts: Pick<TemplateOptions, 'projectId' | 'title' | 'issuerName' | 'accent'>): Project {
  const name = opts.issuerName?.trim() || opts.title;
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: opts.projectId,
    title: opts.title,
    documentType: 'custom',
    modelVersion: 1,
    rootNodeId: 'doc-root',
    nodes: [{ id: 'doc-root', type: 'container', name: 'Document', children: [] }],
    presentationProfiles: defaultPresentationProfiles(),
    rules: [],
    contentParts: [],
    journey: { snapshotPolicy: 'issued-is-immutable', events: [] },
    issuer: { name, accent: opts.accent && ACCENT_PATTERN.test(opts.accent) ? opts.accent : NEUTRAL_ACCENT, product: opts.title },
    customFields: [],
    languages: [],
  };
}

function seedFor(documentType: DocumentType, explicit?: Project[]): Project {
  const s = (explicit ?? seeds).find((p) => p.documentType === documentType);
  if (!s) throw new Error('Template seeds are not registered. Call registerTemplateSeeds(seedProjects()) first.');
  return s;
}

export function projectFromTemplate(templateId: string, opts: TemplateOptions, explicitSeeds?: Project[]): Project {
  const info = TEMPLATES.find((t) => t.id === templateId);
  if (!info) throw new Error(`Unknown template ${templateId}.`);
  // The blank project needs no sample to start from.
  if (templateId === BLANK_PROJECT_TEMPLATE_ID) return blankProject(opts);
  // A blank letter is written against one of the two sample data sets (a document with its own data starts from "Blank project").
  const docType: DocumentType = templateId === 'blank-letter' ? (opts.documentType && opts.documentType !== 'custom' ? opts.documentType : info.documentType) : info.documentType;
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

/**
 * The project as a project file holds it, without the bookkeeping of the one document it was (when it was saved, what
 * it was copied, started or imported from). Unlike a template it keeps its id, title and version number: this is what
 * a release package carries as `template.json`, and it can be imported like any project file.
 */
export function projectFileContentOf(project: Project): Project {
  const content = deepClone(project) as Project & Record<string, unknown>;
  for (const k of IDENTITY_KEYS) delete content[k];
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
  if (!isDocumentType(p.documentType)) bad('DOCUMENT_TYPE', `The file is for a kind of document this studio does not have data for (${String(p.documentType)}).`);
  // The project's own data fields decide what a customer record may hold, so they are checked like the rest of the file.
  if (p.customFields !== undefined) {
    if (!Array.isArray(p.customFields) || p.customFields.some((f: unknown) => !f || typeof f !== 'object' || Array.isArray(f))) bad('DATA_FIELDS', 'The list of data fields in the file cannot be read.');
    else if (isDocumentType(p.documentType)) for (const e of validateCustomFields(p.documentType, p.customFields).slice(0, 5)) bad('DATA_FIELDS', `A data field in the file is not valid: ${e}`);
  }
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
  // Page design (wave 2): paper, margins, page templates and their backgrounds are checked like everything else in a file.
  for (const prof of p.presentationProfiles as any[]) {
    if (!prof || typeof prof !== 'object') { bad('PAGE_DESIGN', 'An output profile in the file cannot be read.'); continue; }
    if (prof.kind === 'responsive') continue;
    for (const t of Object.values(prof.pageTemplates && typeof prof.pageTemplates === 'object' ? prof.pageTemplates : {}) as any[]) {
      const img = t?.background?.image;
      if (typeof img === 'string' && img && !SAFE_IMAGE.test(img) && !/^asset:[a-z0-9-]+$/.test(img)) bad('IMAGE', 'A page background points outside the file. Only an image stored in the file can be imported.');
    }
    for (const m of pageDesignProblems(prof).slice(0, 3)) bad('PAGE_DESIGN', `The page design in the file cannot be used: ${m}`);
  }
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
