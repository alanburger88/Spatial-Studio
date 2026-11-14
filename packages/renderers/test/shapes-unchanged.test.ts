import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { examplesFingerprint } from './helpers/examplesFingerprint';

/**
 * Richer data shapes (wave 5, section 2): a document without groups, lists inside lists or repeating sections gives
 * byte-identical output to before. The baseline was captured on the commit before the feature (CAPTURE=1 rewrites it,
 * which is only ever right on that commit).
 */
const FILE = new URL('./fixtures/shapes-baseline.json', import.meta.url);

describe('documents without the new data shapes are unchanged', () => {
  it('the seed projects, the two samples and the two examples give the same resolution, pages, web page, email, SMS, dictionary, contract and test customers', () => {
    const now = examplesFingerprint();
    if (process.env.CAPTURE === '1') writeFileSync(FILE, JSON.stringify(now, null, 1) + '\n');
    const before = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, string>;
    expect(Object.keys(before).length).toBeGreaterThan(150);
    // Only documents that existed before the feature are compared; an example added later (the Lakeshore variant) has
    // no "before". Every baseline entry must still be produced, and must be identical.
    const compared = Object.fromEntries(Object.keys(before).map((k) => [k, now[k]]));
    expect(compared).toEqual(before);
  }, 300000);
});
