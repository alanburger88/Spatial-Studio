import { describe, expect, it } from 'vitest';
import { CHECKS, EXAMPLES, failuresOf, fixtureFindings, registerExample, reportMarkdown, runAudit, settingsChecks, type AuditExample } from '../../../scripts/audit-examples';

/**
 * The accuracy check of the example documents (scripts/audit-examples.ts), as tests: every check over every registered
 * example, failing on any finding the example's notes do not list as intended. The checks that compose real PDFs and web
 * pages run once, for one customer of each outcome; release packages are built with a stub composer.
 */
describe('examples audit', () => {
  it('registers the example documents, each with notes for the check to read', () => {
    const ids = EXAMPLES.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(['northwind-energy-demo', 'meridian-wealth-demo']));
    for (const e of EXAMPLES) {
      expect(e.customers.length, e.id).toBeGreaterThanOrEqual(30);
      expect(e.customers.length, e.id).toBeLessThanOrEqual(40);
      expect(e.notes.intendedBlockers.length, e.id).toBeGreaterThanOrEqual(1);
      expect(Object.keys(e.notes.translations), e.id).toEqual(['es-US']);
    }
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
    expect(md).toContain('Intended exceptions');
    expect(md).not.toContain('**FAILED**');
  }, 240_000);

  it('outputs: real PDFs and web pages for one customer of each outcome — pages, slip, parity, accessibility, nothing unformatted', async () => {
    const report = await runAudit({ outputs: true, settings: false });
    expect(failuresOf(report)).toEqual([]);
    for (const e of report.examples) for (const id of ['outputs', 'pdf-accessibility']) expect(e.results.find((r) => r.check.id === id)?.outcome.status, `${e.id} ${id}`).toBe('pass');
  }, 600_000);

  it('settings: release and package without customer data, the runnable package verifies, a proof verifies as the same', async () => {
    const results = await settingsChecks();
    expect(results.map((r) => r.example).sort()).toEqual(['meridian-wealth-demo', 'northwind-energy-demo']);
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
});
