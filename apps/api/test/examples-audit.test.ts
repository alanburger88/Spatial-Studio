import { describe, expect, it } from 'vitest';
import { CHECKS, EXAMPLES, MISSING_DASH, failuresOf, fixtureFindings, registerExample, reportMarkdown, runAudit, settingsChecks, type AuditExample } from '../../../scripts/audit-examples';

/**
 * The accuracy check of the example documents (scripts/audit-examples.ts), as tests: every check over every registered
 * example, failing on any finding the example's notes do not list as intended. The checks that compose real PDFs and web
 * pages run once, for one customer of each outcome; release packages are built with a stub composer.
 */
describe('examples audit', () => {
  it('registers the example documents, each with notes for the check to read', () => {
    const ids = EXAMPLES.map((e) => e.id);
    expect([...ids].sort()).toEqual(['aster-card-demo', 'harborcare-demo', 'meridian-wealth-demo', 'northwind-energy-demo', 'northwind-energy-lakeshore']);
    for (const e of EXAMPLES) {
      expect(Object.keys(e.notes.translations), e.id).toEqual(['es-US']);
      expect(e.domain, e.id).toBeTypeOf('function');
      expect(e.recompute, e.id).toBeTypeOf('function');
      if (e.project.documentType !== 'custom') continue;
      expect(e.customers.length, e.id).toBeGreaterThanOrEqual(30);
      expect(e.customers.length, e.id).toBeLessThanOrEqual(40);
      // The Lakeshore variant (wave 5) follows Northwind's release 1, which was approvable: it has no demonstration blocker.
      if (e.id !== 'northwind-energy-lakeshore') expect(e.notes.intendedBlockers.length, e.id).toBeGreaterThanOrEqual(1);
    }
    // The two original examples: the enriched documents the studio stores, with every fixture customer of their kind.
    const card = EXAMPLES.find((e) => e.id === 'aster-card-demo')!;
    const eob = EXAMPLES.find((e) => e.id === 'harborcare-demo')!;
    expect([card.customers.length, eob.customers.length]).toEqual([70, 30]);
    expect(card.notes.intendedBlockers.map((b) => `${b.recordId} ${b.code}`)).toEqual(['CARD-0005', 'CARD-0017', 'CARD-0029', 'CARD-0041', 'CARD-0053', 'CARD-0065'].map((id) => `${id} REQUIRED_TRANSLATION_MISSING`));
    expect(eob.notes.intendedBlockers).toEqual([]);
    expect(card.project.accessiblePdfRequired ?? false).toBe(false);
    expect(card.notes.accessiblePdf?.knownFailures.map((k) => k.code)).toEqual(['PDF_A11Y_TABLE_NO_HEADERS']);
    expect(eob.project.accessiblePdfRequired).toBe(true);
    // A check is a named function over one example: another builder registers more examples the same way.
    expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length);
  });

  it('data, template and rules, and outcomes: no unintended finding', async () => {
    const report = await runAudit({ outputs: false, settings: false });
    expect(failuresOf(report)).toEqual([]);
    // Every check ran (only the composition checks are left for the next test), and the report says so.
    for (const e of report.examples) for (const r of e.results) if (r.check.needs !== 'outputs') expect(r.outcome.status, `${e.id} ${r.check.id}`).not.toBe('not-run');
    const md = reportMarkdown(report);
    expect(md).toContain('## Northwind Energy');
    expect(md).toContain('## Aster Card');
    expect(md).toContain('## HarborCare Health');
    expect(md).toContain('Does not apply');
    // The original examples: each check ran on them (nothing quietly skipped), and what does not apply says why.
    const of = (id: string, check: string) => report.examples.find((e) => e.id === id)!.results.find((r) => r.check.id === check)!.outcome;
    for (const id of ['aster-card-demo', 'harborcare-demo']) {
      expect(of(id, 'calculations').summary, id).toMatch(/[1-9]\d* values recomputed independently/);
      expect(of(id, 'domain').summary, id).toMatch(/oracle scenarios with overrides/);
      expect(of(id, 'released-version').status, id).toBe('not-applicable');
    }
    expect(of('aster-card-demo', 'blockers').intended).toHaveLength(6);
    expect(of('harborcare-demo', 'blockers').status).toBe('pass');
    expect(of('harborcare-demo', 'tests').notApplicable?.[0]).toMatch(/no date of its own/);
    expect(of('aster-card-demo', 'coverage').intended.join('\n')).toMatch(/rule R03: .*Reached by the oracle scenario “card-inconsistent-payment-state”/);
    expect(of('aster-card-demo', 'domain').intended.join('\n')).toMatch(/card-inconsistent-payment-state.*payment-state/);
    expect(of('harborcare-demo', 'domain').intended.join('\n')).toMatch(/eob-unconfirmed-liability.*allowed/);
    expect(md).toContain('Intended exceptions');
    expect(md).not.toContain('**FAILED**');
  }, 240_000);

  it('outputs: real PDFs and web pages for one customer of each outcome — pages, slip, parity, accessibility, nothing unformatted', async () => {
    const report = await runAudit({ outputs: true, settings: false });
    expect(failuresOf(report)).toEqual([]);
    for (const e of report.examples) for (const id of ['outputs', 'pdf-accessibility']) {
      // The card's accessible PDF is a known limitation (its continued transaction table has no header row): stated, not hidden.
      const want = e.id === 'aster-card-demo' && id === 'pdf-accessibility' ? 'intended' : 'pass';
      expect(e.results.find((r) => r.check.id === id)?.outcome.status, `${e.id} ${id}`).toBe(want);
    }
    const card = report.examples.find((e) => e.id === 'aster-card-demo')!;
    const a11y = card.results.find((r) => r.check.id === 'pdf-accessibility')!.outcome;
    expect(a11y.intended[0]).toMatch(/“Accessible PDF is required” is off\. Known limitation/);
    expect(a11y.intended.slice(1).every((i) => /PDF_A11Y_TABLE_NO_HEADERS/.test(i))).toBe(true);
    // The oracle's 250-row case stays at eight pages; the declared customers keep their page counts.
    expect(card.results.find((r) => r.check.id === 'outputs')!.outcome.summary).toMatch(/CARD-0001: 2, .*scenario card-250-rows: 8|scenario card-250-rows: 8/);
  }, 600_000);

  it('settings: release and package without customer data, the runnable package verifies, a proof verifies as the same', async () => {
    const results = await settingsChecks();
    expect(results.map((r) => r.example).sort()).toEqual(['aster-card-demo', 'harborcare-demo', 'meridian-wealth-demo', 'northwind-energy-demo', 'northwind-energy-lakeshore']);
    expect(results.flatMap((r) => r.checks.filter((c) => c.outcome.status === 'failed').map((c) => `${r.example}: ${c.title}: ${c.outcome.failures.join('; ')}`))).toEqual([]);
  }, 600_000);

  it('the approved fixtures are only read: every finding there is one of the oracle’s deliberate scenarios', () => {
    const f = fixtureFindings();
    expect(f.checked).toEqual({ card: 70, eob: 30 });
    expect(f.findings.filter((x) => !x.intended)).toEqual([]);
    expect(f.findings.length).toBeGreaterThanOrEqual(2);
  });

  it('catches what it is there to catch: a charge that does not add up and an undeclared blocker fail', async () => {
    const nw = EXAMPLES.find((e) => e.id === 'northwind-energy-demo')!;
    const broken = structuredClone(nw.customers) as AuditExample['customers'];
    const c = broken[0].custom as any;
    c.charges[0].amountCents += 1;
    delete c.billDate;
    registerExample({ ...nw, id: 'northwind-broken', customers: broken });
    try {
      const report = await runAudit({ outputs: false, settings: false, only: ['northwind-broken'] });
      const failures = failuresOf(report).join('\n');
      expect(failures).toMatch(/charge row 1/);
      expect(failures).toMatch(/DOCUMENT_DATE_MISSING|has no Bill date/);
    } finally {
      EXAMPLES.splice(EXAMPLES.findIndex((e) => e.id === 'northwind-broken'), 1);
    }
  }, 120_000);

  it('catches it on the original examples too: a transaction that does not add up, a missing value, an outcome declared reachable that is not', async () => {
    const card = EXAMPLES.find((e) => e.id === 'aster-card-demo')!;
    const broken = structuredClone(card.customers) as AuditExample['customers'];
    (broken[0] as any).card.transactions[0].amountCents += 1;
    const notes = structuredClone(card.notes);
    notes.unreached = notes.unreached!.map((u) => (u.id === 'rule R03' ? { ...u, via: { scenario: 'card-standard' } } : u));
    registerExample({ ...card, id: 'card-broken', customers: broken, notes });
    try {
      const report = await runAudit({ outputs: false, settings: false, only: ['card-broken'] });
      const failures = failuresOf(report).join('\n');
      expect(failures).toMatch(/CARD-0001 .*transactions-sum/);
      expect(failures).toMatch(/rule R03: declared as reached by the oracle scenario “card-standard” \(fixtures\/expected_scenarios.json\), which does not reach it/);
      // A value shown as “—” is found; a dash between two words (the approved subject and footer) is punctuation.
      for (const t of ['Amount due: —', 'Your balance is —.', 'Total: — USD', '—']) expect(MISSING_DASH.test(t), t).toBe(true);
      for (const t of ['Your statement is ready — this is not a bill', 'Synthetic demonstration data — not a real statement', 'Pay $45.00 — by Nov 25']) expect(MISSING_DASH.test(t), t).toBe(false);
    } finally {
      EXAMPLES.splice(EXAMPLES.findIndex((e) => e.id === 'card-broken'), 1);
    }
  }, 120_000);
});
