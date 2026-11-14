/**
 * What is deliberate about an example document. The accuracy check (`scripts/audit-examples.ts`) reads these notes:
 * a finding listed here is an intended exception (with its reason); anything else it finds is a failure.
 */
export interface SampleNotes {
  /** The issuer as the gallery names it. */
  title: string;
  /** What kind of document it is, in a few words. */
  kind: string;
  /** One sentence for the gallery card. */
  description: string;
  /** Demonstration blockers: each stops exactly one customer, on purpose. */
  intendedBlockers: Array<{ recordId: string; code: string; path?: string; nodeId?: string; reason: string }>;
  /** Customer-data blockers set aside for one customer, as the studio seeds them (a known data problem with its reason). */
  knownDataProblems: Array<{ recordId: string; code: string; nodeId?: string; path?: string; reason: string }>;
  /** Wording rule findings that are there on purpose ("should" rules only; a "must" finding is never intended). */
  intendedShould: Array<{ ruleId: string; reason: string }>;
  /** Data fields (or list columns, as `custom.list[].column`) that nothing in the document shows or reads, and why. */
  unusedFields: Array<{ path: string; reason: string }>;
  /** Calculations that have no value for a customer, on purpose. */
  missingCalcs: Array<{ recordId: string; key: string; reason: string }>;
  /** Translation counts per target language: approved, draft-only and missing texts (content parts and strings together). */
  translations: Record<string, { approved: number; draft: number; missing: number }>;
  /** Whether each mapping is meant to be complete. */
  mappings: Record<string, 'complete' | 'incomplete'>;
  /** Pages of the PDF for customers whose page count is part of the design (others: 1 or 2). */
  pages: Record<string, number>;
  /**
   * Outcomes (rules, alternatives, sections, languages) that no customer reaches on purpose, with the reason. `via`
   * names one way the outcome IS reached (a pinned test, an oracle scenario, or a customer with overrides); the check
   * resolves it and fails if it does not reach the outcome.
   */
  unreached?: Array<{ id: string; reason: string; via?: OutcomeWitness }>;
  /**
   * When "Accessible PDF is required" is deliberately off: why, and the studio's PDF check findings that are a known
   * limitation (by code). Any other finding still fails.
   */
  accessiblePdf?: { required: false; reason: string; knownFailures: Array<{ code: string; reason: string }> };
  /** Page counts of oracle scenarios (`fixtures/expected_scenarios.json`, read only) that are part of the design. */
  scenarioPages?: Array<{ scenario: string; pages: number; reason: string }>;
}

/** One way to reach an outcome no customer reaches as issued. Exactly one of `testId`, `scenario` or `recordId`. */
export interface OutcomeWitness {
  /** A pinned test of the document (its customer, overrides and "as issued on" date). */
  testId?: string;
  /** An oracle scenario of `fixtures/expected_scenarios.json` (its customer, overrides and rule patches). */
  scenario?: string;
  /** A customer with overrides, for an outcome no test or scenario shows. */
  recordId?: string;
  overrides?: Record<string, unknown>;
  issueDate?: string;
}
