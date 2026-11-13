/**
 * Canonical InfoSlips Spatial Studio model types.
 * One serialized project model is the source of truth for every view, output and projection.
 * Monetary values are always integer cents; dates are ISO-8601 strings.
 */

export const SCHEMA_VERSION = '1.0.0' as const;

/**
 * The kind of document a project is. `credit-statement` and `eob` come with a built-in set of data fields and sample
 * customers. `custom` ("Your own data") has only the customer's name and language plus the data fields the project
 * defines itself; its customers always belong to the project (generated for it, or supplied by the user).
 */
export type DocumentType = 'credit-statement' | 'eob' | 'custom';
/** What a person sees for each kind of document. */
export const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  'credit-statement': 'Credit-card statement',
  eob: 'Explanation of benefits',
  custom: 'Your own data',
};
export const DOCUMENT_TYPES = Object.keys(DOCUMENT_TYPE_LABEL) as DocumentType[];
export const isDocumentType = (v: unknown): v is DocumentType => typeof v === 'string' && (DOCUMENT_TYPES as string[]).includes(v);
export type ProfileId = 'paged-pdf' | 'paged-afp-sim' | 'html-responsive';
/** A BCP-47 language tag from the supported list in `languages.ts` ("en-US" is the source language). */
export type Locale = string;

export type ComponentType =
  | 'container'
  | 'rich-text'
  | 'image'
  | 'shape'
  | 'header-footer'
  | 'bound-field'
  | 'repeating-table'
  | 'summary-metric'
  | 'chart'
  | 'conditional-region'
  | 'variant-set'
  | 'disclosure'
  | 'action-link'
  | 'qr-code'
  | 'expandable-explanation';

export type Scalar = string | number | boolean | null;

/* ------------------------------------------------------------------ Rule AST */

export type ComparisonOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
export type Predicate =
  | { op: 'and' | 'or'; args: Predicate[] }
  | { op: 'not'; arg: Predicate }
  | { op: ComparisonOp; path: string; value: Scalar }
  | { op: 'in'; path: string; value: Scalar[] }
  | { op: 'isNull' | 'notNull'; path: string };

export type RuleAction =
  | { op: 'selectVariant'; targetNodeId: string; variantId: string }
  | { op: 'showSection'; targetNodeId: string }
  | { op: 'requireNodes'; nodeIds: string[] }
  | { op: 'setApprovedLocale'; locale: Locale; errorIfMissingMandatoryTranslation?: boolean }
  | { op: 'setPresentationHint'; hint: string };

export type RuleMode = 'exclusive' | 'additive' | 'obligation';

export interface Rule {
  id: string;
  scope: DocumentType;
  mode: RuleMode;
  priority: number;
  when: Predicate;
  then: RuleAction;
  version: number;
  exclusiveGroup?: string;
  /** Disabled rules stay in the model and trace but never match. */
  enabled?: boolean;
  title?: string;
  description?: string;
}

/* --------------------------------------------------------------- Rich text */

/** Restricted ProseMirror-compatible JSON. Only these node/mark types are allowed. */
export interface RichMark {
  type: 'bold' | 'italic' | 'link';
  attrs?: { href?: string };
}
export interface RichInline {
  type: 'text' | 'token' | 'hardBreak';
  text?: string;
  marks?: RichMark[];
  attrs?: { path?: string; format?: string };
}
export interface RichBlock {
  type: 'paragraph' | 'heading' | 'bulletList' | 'orderedList' | 'listItem';
  attrs?: { level?: number };
  content?: Array<RichBlock | RichInline>;
}
export interface RichDoc {
  type: 'doc';
  content: RichBlock[];
}

/* ------------------------------------------------------------------ Layout */

export interface PagedLayout {
  /** `fixed` = absolutely anchored on a page (pt). `flow` = placed in the flow region in child order. */
  mode: 'flow' | 'fixed';
  xPt?: number;
  yPt?: number;
  wPt?: number;
  hPt?: number;
  /** Fixed: which pages the element appears on. */
  pages?: 'first' | 'all' | 'following';
  /** Flow: width as % of the flow region, alignment and spacing. */
  widthPct?: number;
  align?: 'left' | 'center' | 'right';
  spaceBeforePt?: number;
  keepWithNext?: boolean;
  /** Container: lay children out in a row. */
  direction?: 'column' | 'row';
}

export interface ResponsiveLayout {
  area?: 'header' | 'main' | 'aside' | 'footer';
  /** Columns spanned out of 12 at desktop width. */
  span?: number;
  order?: number;
  hidden?: boolean;
  direction?: 'column' | 'row';
}

export interface NodeLayout {
  paged?: PagedLayout;
  html?: ResponsiveLayout;
}

/* ------------------------------------------------------------------- Nodes */

export interface TableColumn {
  key: string;
  label: string;
  format?: Formatter;
  align?: 'left' | 'right' | 'center';
  /** Domain guard: member-liability columns are never shown as debt when liability is unconfirmed. */
  domainRole?: 'member-liability';
  /** Sum this amount column in the table footer (and in the email). At most one column; tables of the built-in kinds total their amount column without it. */
  total?: boolean;
}

export type Formatter = 'usd-cents' | 'date' | 'text' | 'int' | 'percent' | 'points';
export type NullPolicy = 'blank' | 'fallback' | 'suppress' | 'error';

export interface DocNode {
  id: string;
  type: ComponentType;
  name?: string;
  children?: string[];
  layout?: NodeLayout;
  locked?: boolean;
  /** Purely decorative nodes are excluded from semantic parity. */
  decorative?: boolean;
  a11y?: { label?: string; role?: string };
  /** Inline visibility condition (typed AST, never JS). */
  visibleWhen?: Predicate;
  /** Hidden unless an additive `showSection` rule targets this node. */
  ruleDriven?: boolean;

  // Bound field / summary metric / chart / table
  binding?: string;
  formatter?: Formatter;
  label?: string;
  nullPolicy?: NullPolicy;
  fallbackText?: string;
  importance?: 'primary' | 'secondary';
  domainRole?: 'member-liability' | 'amount-due';

  // Rich text
  content?: RichDoc;
  /** Named text style from `project.styles` (A4). */
  styleId?: string;

  // Content-part backed nodes (disclosure, conditional single-part sections)
  contentPartId?: string;

  // Variant set / conditional region
  policy?: 'exclusive' | 'additive';
  variantIds?: string[];
  fallbackVariantId?: string;
  /** Conditional region inline conditions per variant, evaluated in order. */
  variantConditions?: Record<string, Predicate>;

  // Disclosure
  required?: boolean;
  protected?: boolean;
  jurisdiction?: string[];

  // Repeating table
  columns?: TableColumn[];
  flowContinuation?: boolean;
  repeatHeader?: 'always' | 'when-hinted' | 'never';
  caption?: string;
  sortable?: boolean;
  filterable?: boolean;

  // Chart
  chart?: { kind: 'bar' | 'donut'; groupBy?: string; valueKey?: string; series?: Array<{ label: string; path: string }>; title?: string; limit?: number; palette?: 'brand' | 'mono' };

  // Image
  image?: { src: string; alt: string; fit?: 'contain' | 'cover' };

  // Shape
  shape?: { kind: 'line' | 'rect'; stroke?: string; fill?: string; strokeWidthPt?: number; radiusPt?: number };

  // Header / footer
  headerFooter?: { role: 'page-header' | 'page-footer' | 'document-header'; text: string; repeat: boolean };

  // Action / link
  action?: { label: string; url: string; fallbackText: string };

  // QR
  qr?: { url: string; caption: string };

  // Expandable explanation
  explanation?: { title: string; summary: string; details: string };
}

/* -------------------------------------------------------------- Content parts */

export interface ContentPart {
  id: string;
  version: number;
  title: string;
  approvedLocales: Partial<Record<Locale, string>>;
  syntheticDemoOnly: boolean;
  type: 'text' | 'disclosure';
  /** Unapproved translation drafts (C1). Only `approvedLocales` ever reach a resolved document. */
  draftLocales?: Partial<Record<Locale, string>>;
}

/* ---------------------------------------------------------------- Profiles */

export interface PresentationProfile {
  id: ProfileId;
  kind: 'paged' | 'afp-simulation' | 'responsive';
  paper?: 'US-Letter';
  pageMarginsMm?: [number, number, number, number];
  duplex?: boolean;
  simulationOnly?: boolean;
  breakpointsPx?: number[];
  /** Paged flow region geometry in points (US Letter 612×792). */
  flowRegion?: { firstPageTopPt: number; otherPagesTopPt: number; bottomPt: number };
  afp?: {
    formdef: string;
    pagedef: string;
    fontMap: Record<string, string>;
    overlays: string[];
    resources: string[];
  };
}

/* ----------------------------------------------------------------- Journey */

export interface JourneyEffect {
  op: 'set';
  path: string;
  value: Scalar;
}
export interface JourneyEvent {
  eventId: string;
  effectiveAt?: string;
  eventType: string;
  label?: string;
  day?: number;
  payload?: Record<string, Scalar>;
  preconditions?: Array<{ path: string; op: ComparisonOp; value: Scalar }>;
  effects: JourneyEffect[];
  emits?: string;
}

/* ----------------------------------------------------------------- Project */

export interface Project {
  schemaVersion: string;
  projectId: string;
  title: string;
  documentType: DocumentType;
  modelVersion: number;
  rootNodeId: string;
  nodes: DocNode[];
  presentationProfiles: PresentationProfile[];
  rules: Rule[];
  contentParts: ContentPart[];
  journey: { snapshotPolicy: 'issued-is-immutable'; events: JourneyEvent[] };
  issuer: { name: string; accent: string; product: string };
  lastSavedAt?: string;
  /** Project-level data fields beyond the standard contract (paths `custom.<key>`); travel with the model for deterministic runs. */
  customFields?: CustomField[];
  /** Named paragraph/character styles (A4). */
  styles?: TextStyle[];
  /** Project brand kit (A4): applied by the renderers to every output. */
  brand?: BrandKit;
  /** Pinned regression scenarios with expected outcomes (B4). Travel with the model. */
  testCases?: TestCase[];
  /** Target languages of the project (never the English source). Absent on older projects, which behave as ["es-US"]. */
  languages?: Locale[];
  /**
   * Translations of every customer-visible text that is not a content part (labels, headings, rich text, table titles,
   * links, footers, email and SMS wording), keyed by the string id from `translatableStrings`. English is always the live model text.
   */
  strings?: Record<string, StringTranslation>;
  /** Who produced a draft that no person has edited or approved yet, keyed by `<locale>|<part or string id>`. */
  translationOrigins?: Record<string, TranslationOrigin>;
  /** Email and SMS wording and section choices. Absent = the defaults from `defaultChannels`. */
  channels?: ChannelConfig;
  /** Preferred translations of recurring terms, per target language. AI drafts and the translation check follow them. */
  glossary?: Record<Locale, GlossaryEntry[]>;
  /** The saved template version this project was started from (absent for built-in starters and older projects). */
  fromTemplate?: { templateId: string; version: number; title: string };
  /** Set when the project was brought in from a studio project file: what the file said it was. */
  importedFrom?: { projectId: string; title: string; modelVersion: number; importedAt: string };
}

/** One preferred term: the English `source` should be rendered as `target` in that language. */
export interface GlossaryEntry { source: string; target: string; note?: string }

export type TranslationOrigin = 'ai' | 'sample';

export interface StringTranslation {
  approved?: Record<Locale, string>;
  draft?: Record<Locale, string>;
  /** The English text each approved translation was made from; a difference means the English has changed since. */
  basedOn?: Record<Locale, string>;
}

export type EmailSectionId = 'keyFacts' | 'messages' | 'tables' | 'summaries' | 'actions';

/**
 * Wording and layout choices for the email and SMS versions of the document. Texts use the same safe markup and
 * `{{data.field}}` tokens as document text, plus `{{issuer.name}}`, `{{issuer.product}}`, `{{keyFacts}}` and `{{link}}`.
 */
export interface ChannelConfig {
  email: {
    subject: string;
    preheader: string;
    title: string;
    /** Optional opening paragraph shown after the greeting. */
    intro: string;
    /** Optional closing paragraph shown before the disclosures. */
    closing: string;
    keyFactsHeading: string;
    /** Which generated sections appear, in this order. */
    sections: Array<{ id: EmailSectionId; show: boolean }>;
  };
  sms: { text: string };
}

/** A named text style. Sizes in points; colours are CSS hex. */
export interface TextStyle {
  id: string;
  name: string;
  kind: 'paragraph' | 'character';
  fontSizePt?: number;
  fontWeight?: 400 | 600 | 700 | 800;
  italic?: boolean;
  color?: string;
  lineHeight?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  uppercase?: boolean;
}

/** Brand kit: colours, document font and an optional logo (data URI from the image library). */
export interface BrandKit {
  primary: string;
  accent: string;
  text?: string;
  fontFamily?: 'Arial' | 'Georgia' | 'Verdana' | 'Trebuchet MS';
  logoDataUri?: string;
  logoAlt?: string;
}

/** A pinned scenario and the outcome it must keep producing. */
export interface TestCase {
  id: string;
  name: string;
  recordId: string;
  overrides?: Record<string, unknown>;
  journeyCursor?: number | null;
  expect: {
    selectedVariants?: Record<string, string | null>;
    visibleNodeIds?: string[];
    hiddenNodeIds?: string[];
    approvedLocale?: string | null;
    noBlocking?: boolean;
  };
  createdAt?: string;
}

/* ---------------------------------------------------------- Synthetic data */

export interface CardTransaction {
  id: string;
  date: string;
  merchant: string;
  amountCents: number;
}

export interface SyntheticRecord {
  recordId: string;
  documentType: DocumentType;
  personaId?: string;
  customer: Record<string, unknown> & { givenName: string; familyName: string; locale: string };
  card?: Record<string, unknown> & { transactions: CardTransaction[] };
  member?: Record<string, unknown>;
  claims?: Array<Record<string, unknown>>;
  demonstrationOnly?: boolean;
  /** Set on records imported by a user (JSON/CSV) rather than seeded fixtures. */
  imported?: boolean;
  sourceId?: string | null;
  /** Set on records that belong to ONE project only (generated test customers, or data supplied for that project). */
  projectId?: string;
  /** Set on generated test customers: why this customer exists, in plain words. */
  generated?: { label: string };
  /** Values of the project's own data fields (`custom.<key>`). */
  custom?: Record<string, unknown>;
}

/** Every record id: a short upper-case prefix, a dash, 4 to 6 digits (CARD-0001, EOB-5003, CARD-60012). */
export const RECORD_ID_PATTERN = /^[A-Z]{2,6}-\d{4,6}$/;

export interface Persona {
  id: string;
  name: string;
  sampleOverrides: Record<string, unknown>;
}

/** Deep patch applied without mutating the source record. Arrays replace wholesale. */
export type Overrides = Record<string, unknown>;

export interface ComponentCatalogEntry {
  type: ComponentType;
  label: string;
  code: string;
  supportsLayoutProfiles: ProfileId[];
  supportsDataBinding: boolean;
  deep: boolean;
  description: string;
  canContainChildren: boolean;
}

/** One column of a list field: every row of the list carries a value under `key`. */
export interface CustomListColumn {
  key: string;
  label: string;
  type: 'string' | 'int' | 'cents' | 'date';
}

/** A user-defined data field. Records carry its value under `custom.<key>` (a list field: an array of rows). */
export interface CustomField {
  key: string;
  label: string;
  type: 'string' | 'int' | 'cents' | 'bool' | 'date' | 'enum' | 'list';
  enumValues?: string[];
  /** List fields only: the columns of each row (1 to 8). Rules can test the number of rows through `custom.<key>.count`. */
  itemFields?: CustomListColumn[];
  required?: boolean;
  example?: string;
  /** Offer as a Cube/Landscape filter dimension. */
  dimension?: boolean;
}
