import type { Project } from '../types';
import { NORTHWIND_ID, NORTHWIND_NOTES, buildNorthwind, northwindCustomers } from './northwind';
import { MERIDIAN_ID, MERIDIAN_NOTES, buildMeridian, meridianCustomers } from './meridian';
import type { SampleCustomer } from './kit';
import type { SampleNotes } from './notes';

/**
 * The built-in example documents beyond the two fixture-based samples (Aster Card and HarborCare): each is a document
 * with its own data ("custom" kind), built by pure code through the command bus, with its own customers (stable ids)
 * and notes saying what is deliberate about it.
 *
 * The server consumes this registry (seeding, listing and restoring samples, the house library, the accuracy check);
 * the web bundle never imports it. Import it as `@iss/model/samples/index`, never from `@iss/model`.
 */
export interface ExtraSample {
  project: Project;
  customers: SampleCustomer[];
  notes: SampleNotes;
  /** An earlier version released to Production when the sample is first seeded (Northwind only). */
  release?: { project: Project; label: string };
}

let cache: ExtraSample[] | null = null;

/** The extra samples, built once per process (the builders are deterministic, so every call gives the same documents). */
export function EXTRA_SAMPLES(): ExtraSample[] {
  if (cache) return cache;
  const northwind = buildNorthwind('working');
  const meridian = buildMeridian();
  cache = [
    { project: northwind, customers: northwindCustomers(), notes: NORTHWIND_NOTES, release: { project: buildNorthwind('release1'), label: 'Release 1 (approved, in Production)' } },
    { project: meridian, customers: meridianCustomers(), notes: MERIDIAN_NOTES },
  ];
  return cache;
}

export const EXTRA_SAMPLE_IDS: readonly string[] = [NORTHWIND_ID, MERIDIAN_ID];

/** One sample's customer ids carry its own prefix (`NWE-6xxxx`, `MWS-6xxxx`), so they never collide with the studio's `REC-6xxxx`. */
export const SAMPLE_RECORD_PREFIXES: Record<string, string> = { [NORTHWIND_ID]: 'NWE', [MERIDIAN_ID]: 'MWS' };

export { HOUSE, houseContent, HOUSE_WORDING_RULES, RATE_BANDS } from './houseLibrary';
export type { HouseItem, HouseItemId, HouseLinkPlan } from './houseLibrary';
export type { SampleNotes } from './notes';
export type { SampleCustomer } from './kit';
export { NORTHWIND_ID, MERIDIAN_ID };
// Richer data shapes (wave 5): the household statement is for tests only, NOT one of the seeded samples above.
export { HOUSEHOLD_ID, buildHousehold, householdCustomers, ANY_OVERDRAWN, EVERY_ACTIVE } from './household';
