import { currentRelease, projectContentDigest, type Project, type ReleaseInfo } from '@iss/model';
import { COMPARISON_OUTCOMES, type ComparisonOutcome, type CustomerComparison, type VisibleChange, type VisibleChangeKind } from '@iss/scenarios';
import { fmtAbs } from '../../ui/time';
import { STANDING_CHIP } from '../releases/format';

/** A side of the comparison as it appears in the URL: `working` or `r<release number>`. */
export type SideId = string;
export const WORKING: SideId = 'working';
export const releaseSide = (number: number): SideId => `r${number}`;
export const releaseNumberOf = (side: SideId): number | null => { const m = /^r(\d{1,6})$/.exec(side); return m ? Number(m[1]) : null; };
/** Wave 4 (a newer version was saved first): a saved version as a side, `v<model version>`, read from the version history. */
export const savedSide = (version: number): SideId => `v${version}`;
export const savedNumberOf = (side: SideId | null): number | null => { const m = /^v(\d{1,6})$/.exec(side ?? ''); return m && Number(m[1]) > 0 ? Number(m[1]) : null; };

export const OUTPUTS = ['pdf', 'web', 'email', 'sms'] as const;
export type Output = (typeof OUTPUTS)[number];
export const OUTPUT_LABEL: Record<Output, string> = { pdf: 'PDF pages', web: 'Web page', email: 'Email', sms: 'Text message' };
export const isOutput = (s: string | null): s is Output => !!s && (OUTPUTS as readonly string[]).includes(s);

const byNumberDesc = (releases: ReleaseInfo[]) => [...releases].sort((a, b) => b.number - a.number);

/** A side named in the URL that this document can actually show. */
export function validSide(raw: string | null, releases: ReleaseInfo[]): SideId | null {
  if (raw === WORKING) return WORKING;
  if (savedNumberOf(raw) !== null) return raw; // a saved version: the screen loads it and says so if it does not exist
  const n = raw ? releaseNumberOf(raw) : null;
  return n !== null && releases.some((r) => r.number === n) ? releaseSide(n) : null;
}

/** Whether the working version holds anything the latest release does not. */
export function workingDiffersFromLatest(releases: ReleaseInfo[], working: Project): boolean {
  const latest = byNumberDesc(releases)[0];
  return !latest || projectContentDigest(working) !== latest.contentDigest;
}

/**
 * The pair the screen opens on. Before: the release in Production, else the latest release. After: the working
 * version when it differs from the latest release, else the latest release. No release yet: nothing to compare.
 */
export function defaultPair(releases: ReleaseInfo[], working: Project): { before: SideId; after: SideId } | null {
  const sorted = byNumberDesc(releases);
  if (!sorted.length) return null;
  const production = currentRelease(sorted, 'production');
  const before = releaseSide((production ?? sorted[0]).number);
  const after = workingDiffersFromLatest(sorted, working) ? WORKING : releaseSide(sorted[0].number);
  return { before, after };
}

/** The other side to offer when only one is named ("Compare with…" on a release). */
export function otherSideFor(side: SideId, releases: ReleaseInfo[], working: Project): SideId {
  const n = releaseNumberOf(side);
  const rel = n === null ? null : releases.find((r) => r.number === n);
  if (side === WORKING) return releaseSide(byNumberDesc(releases)[0]?.number ?? 0);
  if (savedNumberOf(side) !== null) return WORKING;
  if (rel && projectContentDigest(working) !== rel.contentDigest) return WORKING;
  const other = byNumberDesc(releases).find((r) => r.number !== n);
  return other ? releaseSide(other.number) : WORKING;
}

export function sideLabel(side: SideId, releases: ReleaseInfo[], dirty = false): string {
  if (side === WORKING) return dirty ? 'Working version (not released, with unsaved changes)' : 'Working version (not released)';
  if (savedNumberOf(side) !== null) return `Saved version ${savedNumberOf(side)} (not released)`;
  const r = releases.find((x) => x.number === releaseNumberOf(side));
  return r ? `Release ${r.number} · ${STANDING_CHIP[r.standing].label} · ${fmtAbs(r.approvedAt)}` : side;
}
export const sideShort = (side: SideId): string => (side === WORKING ? 'Working version' : savedNumberOf(side) !== null ? `Saved version ${savedNumberOf(side)}` : `Release ${releaseNumberOf(side)}`);

/** The customers of one outcome, in the engine's order. */
export function customersOf(customers: CustomerComparison[], outcome: ComparisonOutcome): CustomerComparison[] {
  return customers.filter((c) => c.outcome === outcome);
}

/** The customer to open on: the first with a visible difference, in the engine's order of importance; else the one the studio has open; else the first. */
export function defaultCustomer(customers: CustomerComparison[], studioRecordId: string): string | null {
  for (const o of COMPARISON_OUTCOMES) { if (o === 'same') continue; const c = customers.find((x) => x.outcome === o); if (c) return c.recordId; }
  return customers.find((c) => c.recordId === studioRecordId)?.recordId ?? customers[0]?.recordId ?? null;
}

export const CHANGE_LABEL: Record<VisibleChangeKind, string> = {
  message: 'Different message', wording: 'Wording', appears: 'Now shown', disappears: 'No longer shown', layout: 'Layout',
  'email-sms': 'Email or text', language: 'Language', stopped: 'Now stopped', unstopped: 'No longer stopped',
};

/** Where on the pages a change can be outlined. Nothing for the document as a whole, nor for email and text wording. */
export const isPartChange = (c: VisibleChange): boolean => !!c.nodeId && !c.nodeId.startsWith('@');
export const sidesOutlined = (c: VisibleChange): { before: boolean; after: boolean } =>
  !isPartChange(c) ? { before: false, after: false } : { before: c.kind !== 'appears', after: c.kind !== 'disappears' };
/** The output that shows an email or text change. */
export const outputOfChannelChange = (c: VisibleChange): Output | null => (c.nodeId === '@sms' ? 'sms' : c.nodeId.startsWith('@email') ? 'email' : null);
