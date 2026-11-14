import type { Command, Project, Rule, SyntheticRecord, TestCase } from '@iss/model';
import type { Finding } from '@iss/resolver';

/**
 * Shared contracts of the assistant's built-in engines. Every engine here is PURE and deterministic: it reads the
 * project, the synthetic records and the resolver's own output, and returns PROPOSALS. Nothing is ever applied by an
 * engine. The studio shows a proposal with its effect, a person approves it, and it is applied as one undoable step.
 *
 * `source` says who produced a proposal: 'builtin' (computed here, works without an AI key) or 'ai' (a model produced
 * it on the server; always labelled, always re-validated).
 */
export type AssistSource = 'builtin' | 'ai';

/** Where a proposal sends the user when it cannot be applied as a change (for example "write the missing translation"). */
export interface AssistLink { view: 'design' | 'rules-data' | 'content' | 'channels' | 'validate' | 'outputs' | 'exploded'; nodeId?: string; ruleId?: string; textId?: string; locale?: string; label: string }

/* ------------------------------------------------------------------ fixes for findings */

export interface FixProposal {
  /** Stable for the same project state and finding: used as React key and for "applied" tracking. */
  id: string;
  findingCode: string;
  /** Imperative, plain words: "Raise the priority of “Customer asked for payment assistance”". */
  title: string;
  /** Why this resolves the issue and what it changes, in one or two plain sentences. */
  explanation: string;
  /** 'change' = model commands; 'scenario' = only the previewed what-if data is wrong (not the document); 'link' = a person must do it there. */
  kind: 'change' | 'scenario' | 'link';
  /** For kind 'change': applied in order as ONE undoable step (wrap in a BATCH command). */
  commands?: Command[];
  link?: AssistLink;
  /** 'safe' = cannot change what any currently unaffected customer receives and is trivially reversible; everything else is 'review'. */
  risk: 'safe' | 'review';
  riskReason?: string;
  source: AssistSource;
}

export interface FixImpact {
  /** Does the finding disappear for the customers that had it? */
  resolves: boolean;
  /** Record ids that had a blocking finding before and have none after. */
  unblocked: string[];
  /** Record ids that had no blocking finding before and have one after (a fix must normally leave this empty). */
  newlyBlocked: string[];
  /** Customers whose chosen messages, sections or findings differ in any way. */
  changedCustomers: number;
  totalCustomers: number;
  /** One plain sentence for the confirmation dialog. */
  summary: string;
}

export interface FindingGroup { key: string; finding: Finding; recordIds: string[] }

/* ------------------------------------------------------------------ blockers (one root cause across all customers) */

/** The kind of fix a blocker needs: which screen it is resolved in. */
export type BlockerKind = 'wording' | 'rules' | 'layout' | 'data-fields' | 'customer-data';

/** Where a blocker is fixed by hand. `data` (Data Explorer) is only used for a blocker whose cause is a customer's data. */
export type BlockerLink = Omit<AssistLink, 'view'> & { view: AssistLink['view'] | 'data'; /** `data` links: the customer to open. */ recordId?: string };

/** What a blocker is about: ids for linking and names for showing. Only the parts that apply are present. */
export interface BlockerAbout {
  component?: { id: string; name: string };
  rules?: Array<{ id: string; name: string }>;
  /** A content part (message) or a version of one. */
  message?: { id: string; name: string };
  field?: { path: string; name: string };
  language?: { code: string; name: string };
}

/**
 * ONE ROOT CAUSE that stops a document being issued, across every customer it stops.
 * `id` is stable: it is made of the kind of problem, what it is about and the language, so the same cause keeps the same
 * id across saves, re-checks and the fixing of other blockers.
 */
export interface Blocker {
  id: string;
  kind: BlockerKind;
  /** Technical code of the resolver, rule check or page composer, for the Technical view only. */
  code: string;
  /** Plain words, names not ids. */
  title: string;
  explanation: string;
  about: BlockerAbout;
  /** Customers this stops, sorted. Empty when the cause is in the document but no sample customer reaches it. */
  recordIds: string[];
  customerCount: number;
  /** `fast` = worked out by the engine for every customer just now; `full-check` = came from a composed-page check passed in. */
  speed: 'fast' | 'full-check';
  /** All sensible alternatives, best first (from `proposeFixes`). */
  fixes: FixProposal[];
  /** Where it is fixed by hand. */
  link: BlockerLink | null;
  /** The finding the fixes were worked out from (one customer's, or the full check's). */
  finding: Finding;
}

export interface DocumentBlockers {
  /** Customers of the document's kind that were checked. */
  checked: number;
  /** Customers no blocker stops. */
  issuable: number;
  /** Customers at least one blocker stops. */
  stopped: number;
  /** Most customers stopped first, then by kind. */
  blockers: Blocker[];
}

/* ------------------------------------------------------------------ rules */

export interface RuleDraft {
  /** A complete, valid rule ready for UPSERT_RULE (new id), or null when the sentence could not be understood. */
  rule: Rule | null;
  /** The rule restated in plain words, so the person can confirm it was understood. */
  restatement: string;
  /** Parts of the sentence that were not understood or were guessed; empty when confident. */
  uncertain: string[];
  source: AssistSource;
}

export interface RuleObservation {
  id: string;
  kind: 'tie' | 'overlap' | 'unreachable' | 'no-fallback' | 'shadowed' | 'gap' | 'disabled';
  severity: 'blocking' | 'warning' | 'info';
  ruleIds: string[];
  title: string;
  detail: string;
  /** Optional concrete change, same shape as a fix. */
  proposal?: FixProposal;
}

/* ------------------------------------------------------------------ coverage */

export interface CoverageGap {
  id: string;
  kind: 'rule' | 'variant' | 'section';
  /** Rule id, content-part (variant) id or node id. */
  targetId: string;
  title: string;
  /** A what-if that reaches the target, or null when none was found within the search bound. */
  scenario: { recordId: string; overrides: Record<string, unknown>; journeyCursor: number | null; explanation: string } | null;
  /** A ready-to-pin test for that scenario (UPSERT_TEST_CASE), when a scenario was found. */
  testCase?: TestCase;
  /** Why nothing reaches it, when no scenario was found (for example contradictory conditions). */
  reason?: string;
}

/* ------------------------------------------------------------------ test customers */

export interface TestDataOptions {
  /** one customer for every rule, message version, optional section (shown and hidden) and document language */
  outcomes: boolean;
  /** just below / exactly on / just above each threshold, each referenced enum value and yes/no, and an empty value for each optional field a rule reads */
  edges: boolean;
  /** hard cap on customers, default 200 */
  max?: number;
  /** "As issued on": the document's date to plan for (documents that use dates). Dated targets also try each boundary day. */
  issueDate?: string | null;
}

export type TestDataTargetKind = 'rule' | 'variant' | 'section-shown' | 'section-hidden' | 'language' | 'edge' | 'empty';

export interface TestDataTarget {
  id: string;
  kind: TestDataTargetKind;
  /** rule id, content-part id, node id, locale, or field path */
  targetId: string;
  /** plain words, names not ids, e.g. `Rule “Two or more missed payments — offer support” applies`, `New balance exactly $500.00` */
  title: string;
  /** index into `customers`, or null when nothing reaches it */
  customer: number | null;
  /** why nothing reaches it (contradictory conditions, depends on a calculated field, only reached at a journey step, …) */
  reason?: string;
  /** edge/empty targets: what the document did for that value, e.g. `Gets “Payment reminder”` */
  observed?: string;
}

export interface GeneratedCustomer {
  /** a complete record except its id */
  record: Omit<SyntheticRecord, 'recordId'>;
  /** short reason shown in the customer picker, e.g. `Reaches “Payment support”` or `New balance just above $500.00` */
  label: string;
  /** ids of the targets this customer covers */
  targets: string[];
  /** The document's date this customer reaches its targets on, when the document's date is given for the run (or "as issued on" was asked for). */
  issueDate?: string;
}

export interface TestDataPlan {
  customers: GeneratedCustomer[];
  targets: TestDataTarget[];
  summary: { outcomes: { total: number; reached: number }; edges: { total: number; reached: number }; unreachable: number; capped: boolean };
}

/* ------------------------------------------------------------------ change summary */

export interface ChangeSummary {
  /** Headline: "3 wording changes, 1 rule change, 12 translations approved". */
  headline: string;
  sections: Array<{ area: 'wording' | 'rules' | 'layout' | 'translations' | 'channels' | 'settings' | 'tests'; title: string; items: string[] }>;
  impact: { changedCustomers: number; totalCustomers: number; newlyBlocked: number; unblocked: number; examples: Array<{ recordId: string; name: string; what: string }> };
  /** What an approver should look at first, most important first. */
  attention: string[];
  source: AssistSource;
}

/* ------------------------------------------------------------------ translation check */

export interface TranslationFlag {
  /** Content-part id or string id (the `partId` of a translation row). */
  textId: string;
  kind: 'length' | 'glossary' | 'inconsistent-term' | 'untranslated' | 'number-mismatch' | 'sms-encoding' | 'punctuation' | 'meaning';
  severity: 'warning' | 'info';
  message: string;
  source: AssistSource;
}

/* ------------------------------------------------------------------ small helpers */

export interface ColumnMatch { column: string; path: string | null; confidence: 'exact' | 'likely' | 'guess' | 'none'; reason: string; sampleProblem?: string }
export interface ActivityQuery { user?: string; action?: string; since?: string; until?: string; text?: string; projectId?: string; understood: string[]; ignored: string[] }
export interface Explanation { headline: string; steps: string[]; ruleIds: string[]; variantId: string | null; nodeId: string }

export interface EngineContext { project: Project; records: SyntheticRecord[] }
