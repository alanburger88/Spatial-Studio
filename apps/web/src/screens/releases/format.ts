import type { ReleaseActor, ReleaseInfo, ReleasePackageState, ReleaseStanding } from '@iss/model';

/** How a release stands, as a word and a chip style (the word always carries the meaning, colour only helps). */
export const STANDING_CHIP: Record<ReleaseStanding, { label: string; cls: string }> = {
  production: { label: 'Production', cls: 'accent' },
  test: { label: 'Test', cls: 'info' },
  superseded: { label: 'Superseded', cls: '' },
  withdrawn: { label: 'Withdrawn', cls: 'warning' },
};

export const PACKAGE_CHIP: Record<ReleasePackageState, { label: string; cls: string }> = {
  'not-built': { label: 'Package not built', cls: '' },
  building: { label: 'Package being built', cls: 'info' },
  ready: { label: 'Package ready', cls: 'accent' },
  failed: { label: 'Package failed', cls: 'error' },
};

export const personName = (a: ReleaseActor | null | undefined): string => a?.name ?? 'an unknown person';

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The release's own name in a sentence. */
export const releaseName = (r: Pick<ReleaseInfo, 'number'>) => `Release ${r.number}`;

/** A readable name for a path inside a package (never shown instead of the path in Technical view). */
export function fileLabel(path: string): string {
  if (path === 'README.html') return 'Guide for the receiving team (README)';
  if (path === 'manifest.json') return 'Manifest';
  if (path === 'template.json') return 'Approved template';
  return path;
}
