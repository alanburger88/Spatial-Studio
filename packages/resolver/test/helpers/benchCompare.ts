/** The depth document against the same document without its calculations and dates (`npx tsx …/benchCompare.ts`). */
import { buildContext, evaluateCalculations } from '../../../model/src';
import { gymProject } from '../../../model/test/helpers/customProject';
import { resolve } from '../../src';
import { bench } from './bench';
import { depthBenchMembers, depthBenchProject } from './benchDepth';

const members = depthBenchMembers();
const plain = gymProject();
const depth = depthBenchProject();
let i = 0;
bench('Gym notice without calculations or dates', () => { resolve({ project: plain, record: members[i++ % members.length] }); }, 3000);
bench('Same notice with 20 calculations, a 1,000-row table and dated rules', () => { resolve({ project: depth, record: members[i++ % members.length], issueDate: '2026-11-25' }); }, 3000);
bench('The 20 calculations alone (evaluateCalculations)', () => { evaluateCalculations(depth, buildContext(members[i++ % members.length]) as Record<string, unknown>, '2026-11-25'); }, 20000);
