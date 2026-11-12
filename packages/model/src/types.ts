/**
 * Canonical InfoSlips Spatial Studio model types.
 * One serialized project model is the source of truth for every view, output and projection.
 * Monetary values are always integer cents; dates are ISO-8601 strings.
 */

export const SCHEMA_VERSION = '1.0.0' as const;

export type DocumentType = 'credit-statement' | 'eob';
export type ProfileId = 'paged-pdf' | 'paged-afp-sim' | 'html-responsive';
export type Locale = 'en-US' | 'es-US';

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
}

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

/** A user-defined data field. Records carry its value under `custom.<key>`. */
export interface CustomField {
  key: string;
  label: string;
  type: 'string' | 'int' | 'cents' | 'bool' | 'date' | 'enum';
  enumValues?: string[];
  required?: boolean;
  example?: string;
  /** Offer as a Cube/Landscape filter dimension. */
  dimension?: boolean;
}
