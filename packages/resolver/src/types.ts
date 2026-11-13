import type { ComponentType, DocumentType, NodeLayout, Predicate, ProfileId, RuleAction, RuleMode, TableColumn } from '@iss/model';
import type { JourneyStep } from '@iss/model';

export type Severity = 'blocking' | 'error' | 'warning' | 'info';

/** Oracle-compatible core diagnostic (exact key set: code, severity, nodeId, and optional locale/ruleIds/ruleId). */
export interface CoreDiagnostic {
  code: string;
  severity: Severity;
  nodeId?: string;
  locale?: string;
  ruleIds?: string[];
  ruleId?: string;
}

/** Full finding used by Validate & Compare and the inspector. */
export interface Finding extends CoreDiagnostic {
  message: string;
  source: 'resolver' | 'domain' | 'binding' | 'composer' | 'parity' | 'accessibility' | 'rules-static' | 'translation';
  suggestion?: string;
  page?: number;
  details?: Record<string, unknown>;
}

export interface TraceEntry {
  ruleId: string;
  kind: 'rule' | 'inline-condition';
  version?: number;
  mode?: RuleMode | 'inline';
  priority?: number;
  enabled: boolean;
  matched: boolean;
  predicateInputs: Record<string, unknown>;
  expression: Predicate;
  action?: RuleAction;
  targetNodeId?: string;
  outcome: 'selected' | 'outranked' | 'tie' | 'applied' | 'required' | 'not-matched' | 'disabled' | 'out-of-scope';
  note?: string;
}

export interface RInline {
  kind: 'text' | 'token' | 'break';
  text: string;
  bold?: boolean;
  italic?: boolean;
  href?: string;
  path?: string;
  missing?: boolean;
  cents?: number;
}

export interface RBlock {
  kind: 'p' | 'h2' | 'h3' | 'h4' | 'ul' | 'ol';
  inlines?: RInline[];
  items?: RInline[][];
}

export interface RVariant {
  id: string;
  title: string;
  contentVersion: number | null;
  matched: boolean;
  selected: boolean;
  isFallback: boolean;
  ruleIds: string[];
  /** Rules whose actions target this variant (matched or not). */
  candidateRuleIds: string[];
  source: 'rule' | 'inline' | 'fallback' | 'section-rule' | null;
  text: RBlock[];
  locale: string;
  missingLocale?: boolean;
}

export interface RTableRow {
  id: string;
  cells: Record<string, { raw: unknown; display: string; cents?: number; guarded?: boolean }>;
}

export interface RNode {
  id: string;
  type: ComponentType;
  name: string;
  visible: boolean;
  visibleBecause: string[];
  hiddenReason?: string;
  ruleIds: string[];
  dataLineage: string[];
  contentVersion?: string;
  layout?: NodeLayout;
  decorative?: boolean;
  required?: boolean;
  materialized?: boolean;
  children: RNode[];
  text?: RBlock[];
  field?: { label: string; path: string; raw: unknown; display: string; missing: boolean; cents?: number; guarded?: boolean; importance?: string; formatter?: string };
  table?: { path: string; columns: TableColumn[]; rows: RTableRow[]; repeatHeader: boolean; continuation: boolean; caption: string; totalCents?: number; sortable: boolean; filterable: boolean };
  chart?: { kind: 'bar' | 'donut'; title: string; data: Array<{ label: string; value: number; display: string }>; summary: string };
  variants?: { policy: 'exclusive' | 'additive'; selected: string[]; fallbackVariantId?: string; items: RVariant[]; unresolved: boolean };
  disclosure?: { contentPartId: string; version: number; contentHash: string; title: string; jurisdiction: string[] };
  action?: { label: string; url: string; fallbackText: string; interactive: boolean };
  qr?: { url: string; caption: string };
  explanation?: { title: string; summary: string; details: string };
  image?: { src: string; alt: string; fit: string };
  shape?: { kind: 'line' | 'rect'; stroke?: string; fill?: string; strokeWidthPt?: number; radiusPt?: number };
  headerFooter?: { role: string; inlines: RInline[]; repeat: boolean };
}

export interface CoreResult {
  recordId: string;
  documentType: DocumentType;
  selectedVariants: Record<string, string | null>;
  matchedRuleIds: string[];
  additiveRuleIds: string[];
  requiredNodes: string[];
  diagnostics: CoreDiagnostic[];
  documentFacts: Record<string, unknown>;
  resultDigest?: string;
}

export interface SemanticManifest {
  schema: 'semantic-manifest/1';
  producer: string;
  projectId: string;
  modelVersion: number;
  recordId: string;
  documentType: DocumentType;
  locale: string;
  selectedVariants: Record<string, string | null>;
  requiredNodeIds: string[];
  visibleNodeIds: string[];
  money: Record<string, number>;
  guardedLiabilityNodeIds: string[];
  disclosures: Array<{ nodeId: string; contentPartId: string; version: number; contentHash: string }>;
  identity: Record<string, string>;
  tableRows: Record<string, number>;
  tableTotalsCents: Record<string, number>;
  actions: Array<{ nodeId: string; url: string }>;
  facts: Record<string, unknown>;
}

export interface ResolveInput {
  project: import('@iss/model').Project;
  record: import('@iss/model').SyntheticRecord;
  overrides?: Record<string, unknown>;
  journeyCursor?: number | null;
  claimIndex?: number;
  profileId?: ProfileId;
  /** Previews only: also show unapproved translation drafts (reported as a finding). Clean exports never set this. */
  includeDrafts?: boolean;
}

/** Email and SMS wording resolved for this customer and language. `{{keyFacts}}` and `{{link}}` are filled by the channel renderers. */
export interface ChannelTexts {
  subject: string; preheader: string; title: string; keyFactsHeading: string;
  intro: RBlock[]; closing: RBlock[]; sms: string;
  sections: Array<{ id: import('@iss/model').EmailSectionId; show: boolean }>;
}

export interface Resolution {
  runId: string;
  projectId: string;
  modelVersion: number;
  projectDigest: string;
  recordId: string;
  profileId: ProfileId;
  journeyCursor: number | null;
  rulesDigest: string;
  engineVersion: string;
  locale: string;
  hints: string[];
  result: CoreResult;
  trace: TraceEntry[];
  findings: Finding[];
  root: RNode;
  semanticManifest: SemanticManifest;
  contentDigest: string;
  journeySteps: JourneyStep[];
  /** Effective record after overrides and journey (synthetic). */
  effectiveRecord: import('@iss/model').SyntheticRecord;
  /** Email and SMS wording for this customer and language. */
  channelTexts: ChannelTexts;
  /** Translated fixed wording (system strings) for the document language; English defaults apply to missing keys. */
  systemStrings: Record<string, string>;
  /** Which texts of the document language are drafts or still English. */
  translation: { locale: string; draftsShown: string[]; missing: string[] };
}
