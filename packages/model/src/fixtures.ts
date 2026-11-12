/**
 * Fixture bundle loader (server / tests). The web client receives records through the API.
 * Fixture JSON is consumed as data; the Python oracle is never imported.
 */
import customers from '../../../fixtures/customers_100.json';
import personas from '../../../fixtures/personas.json';
import projects from '../../../fixtures/projects.json';
import rules from '../../../fixtures/rules_20.json';
import contentParts from '../../../fixtures/content_parts_30.json';
import journeys from '../../../fixtures/journeys.json';
import expected from '../../../fixtures/expected_scenarios.json';
import catalog from '../../../fixtures/component_catalog_15.json';
import { buildSeedProjects } from './seed';
import type { ContentPart, Persona, Project, Rule, SyntheticRecord } from './types';

export const FIXTURE_SEED = (customers as any).seed as string;
export const RECORDS: SyntheticRecord[] = [...(customers as any).creditCard, ...(customers as any).healthcareEob];
export const PERSONAS: Persona[] = personas as Persona[];
export const RULES: Rule[] = rules as Rule[];
export const CONTENT_PARTS: ContentPart[] = contentParts as ContentPart[];
export const FIXTURE_PROJECTS = projects as any[];
export const EXPECTED_SCENARIOS = (expected as any).cases as Record<string, { recordId: string; overrides: Record<string, unknown>; rulePatches?: Array<Partial<Rule> & { id: string }>; expected: any }>;
export const FIXTURE_CATALOG = catalog as Array<{ type: string; label: string }>;

export function seedProjects(): Project[] {
  return buildSeedProjects({ projects: FIXTURE_PROJECTS, rules: RULES, contentParts: CONTENT_PARTS, journeys: journeys as any });
}

export function recordById(id: string): SyntheticRecord | undefined {
  return RECORDS.find((r) => r.recordId === id);
}
