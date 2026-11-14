import type { ProofChannel } from '@iss/resolver';
import type { ProofReleaseDto } from './api';

export const CHANNEL_LABEL: Record<ProofChannel, string> = { pdf: 'PDF', html: 'web page', email: 'email', sms: 'text message' };
export const CHANNEL_ORDER: readonly ProofChannel[] = ['pdf', 'html', 'email', 'sms'];
export const PRODUCER_LABEL = { studio: 'the studio', runtime: 'the runnable package' } as const;
export const PRODUCER_CHIP = { studio: 'Studio', runtime: 'Runnable package' } as const;
export const STANDING_WORD: Record<NonNullable<ProofReleaseDto['info']>['standing'], string> = { production: 'Production', test: 'Test', superseded: 'Superseded', withdrawn: 'Withdrawn' };

/** "web page, email and text message" */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
export const channelsWords = (channels: ProofChannel[]) => listWords([...channels].sort((a, b) => CHANNEL_ORDER.indexOf(a) - CHANNEL_ORDER.indexOf(b)).map((c) => CHANNEL_LABEL[c]));
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
export const short = (s: string, n = 12) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The limits from the design, stated on the screen. */
export const PROOF_LIMIT_LINES = [
  'A proof record shows what was produced, not that it was delivered.',
  'It is not an archive: a document can be re-created only when the data is supplied again and the release still exists here.',
  'Retention rules and legal holds are not part of it.',
  'It keeps fingerprints and decisions only: no customer data and no produced files.',
];
