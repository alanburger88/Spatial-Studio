/**
 * Resolution speed: the two samples, and (when the engine has calculated fields) a test document with 20 calculations
 * and a 1,000-row lookup table. Run with `npx tsx packages/resolver/test/helpers/bench.ts`. Prints microseconds per
 * customer (median of 5 rounds). Not part of the test suite: timings depend on the machine.
 */
import { resolve } from '../../src';
import { RECORDS, seedProjects } from '../../../model/src/fixtures';

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
export function bench(label: string, run: () => void, n: number): void {
  for (let i = 0; i < Math.min(200, n); i++) run(); // warm up
  const rounds: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) run();
    rounds.push(Number(process.hrtime.bigint() - t0) / 1e3 / n);
  }
  process.stdout.write(`${label}: ${median(rounds).toFixed(1)} µs per customer\n`);
}

const [card, eob] = seedProjects();
const cards = RECORDS.filter((r) => r.documentType === 'credit-statement');
const eobs = RECORDS.filter((r) => r.documentType === 'eob');
let i = 0;
bench('Card sample (70 customers, round robin)', () => { resolve({ project: card, record: cards[i++ % cards.length] }); }, 2000);
bench('EOB sample (30 customers, round robin)', () => { resolve({ project: eob, record: eobs[i++ % eobs.length] }); }, 2000);

if (process.argv.includes('--depth')) {
  const { depthBenchProject, depthBenchMembers } = await import('./benchDepth');
  const p = depthBenchProject();
  const members = depthBenchMembers();
  bench('Depth document (20 calculations, 1,000-row table, dated rules)', () => { resolve({ project: p, record: members[i++ % members.length], issueDate: '2026-11-25' }); }, 2000);
}
