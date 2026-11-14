import { blankProject } from '../templates';
import type { Project } from '../types';
import type { SampleCustomer } from './kit';
import type { SampleNotes } from './notes';

export const MERIDIAN_ID = 'meridian-wealth-demo';
export function buildMeridian(): Project {
  return blankProject({ projectId: MERIDIAN_ID, title: 'Meridian Wealth quarterly statement', issuerName: 'Meridian Wealth', accent: '#1F2A44' });
}
export function meridianCustomers(): SampleCustomer[] { return []; }
export const MERIDIAN_NOTES_BASE: Omit<SampleNotes, 'translations'> = {
  title: 'Meridian Wealth', kind: 'Quarterly portfolio statement', description: '', intendedBlockers: [], knownDataProblems: [], intendedShould: [], unusedFields: [], missingCalcs: [], mappings: {}, pages: {},
};
