import type { SetupSpec } from '../../src';

/**
 * A document setup used by the tests of every package: a gym membership renewal notice with a fee table and a
 * message that differs for members whose payment failed. It uses every kind of field and every kind of section.
 */
export function gymSetup(): SetupSpec {
  return {
    title: 'Membership renewal',
    issuerName: 'Northside Gym',
    accent: '#1f4e79',
    summary: 'Tells a member that their membership renews and what it will cost.',
    fields: [
      { label: 'Plan name', type: 'text', example: 'Flex', required: true },
      { label: 'Monthly fee', type: 'amount', example: '49.00', required: true },
      { label: 'Renewal date', type: 'date', example: '2026-12-01', required: true },
      { label: 'Payment status', type: 'choice', choices: ['paid', 'failed', 'pending'], example: 'paid' },
      { label: 'Renews automatically', type: 'yesNo', example: 'yes' },
      { label: 'Visits this month', type: 'number', example: '9' },
      { label: 'Fees', type: 'list', columns: [{ label: 'Description', type: 'text' }, { label: 'Charged on', type: 'date' }, { label: 'Amount', type: 'amount' }, { label: 'Quantity', type: 'number' }] },
    ],
    sections: [
      { type: 'heading', text: 'Your {Plan name} membership renews soon' },
      { type: 'paragraph', text: 'Hello {First name} {Last name},\nyour **{Plan name}** plan renews on {Renewal date} for {Monthly fee} a month.' },
      { type: 'keyFigures', fields: ['Monthly fee', 'Renewal date', 'Visits this month', 'Renews automatically'] },
      { type: 'table', list: 'Fees', columns: ['Description', 'Charged on', 'Amount'], totalColumn: 'Amount' },
      {
        type: 'messages', name: 'Payment note',
        versions: [
          { title: 'Payment failed', text: 'Your last payment of {Monthly fee} did not go through, {First name}. Please update your card before {Renewal date}.', when: { field: 'Payment status', test: 'is', value: 'failed' } },
          { title: 'Premium member', text: 'Thank you for being one of our premium members.', when: { field: 'Monthly fee', test: 'atLeast', value: 100 } },
          { title: 'Frequent visitor', text: 'You came in {Visits this month} times this month. Keep it up!', when: { field: 'Visits this month', test: 'moreThan', value: 12 } },
          { title: 'Nothing to do', text: 'There is nothing you need to do.', fallback: true },
        ],
      },
      { type: 'divider' },
      { type: 'notice', text: 'Fees are charged monthly in advance. You can cancel at any time before {Renewal date}.' },
      { type: 'action', label: 'Manage your membership', url: 'https://example.com/membership' },
    ],
    email: { subject: 'Your {Plan name} membership renews on {Renewal date}', intro: 'Hello {First name}, here is what your renewal looks like.' },
    sms: 'Your {Plan name} membership renews on {Renewal date}. Details: {Link}',
  };
}
