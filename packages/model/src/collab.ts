import type { TestCase } from './types';

/**
 * Collaboration rules shared by the API (enforcement) and the studio (role-aware UI):
 * roles and permissions, the review/approval workflow state machine and the pure test-case checker.
 */

export type Role = 'author' | 'reviewer' | 'approver' | 'admin';
export const ROLES: readonly Role[] = ['author', 'reviewer', 'approver', 'admin'];
export const ROLE_LABEL: Record<Role, string> = { author: 'Author', reviewer: 'Reviewer', approver: 'Approver', admin: 'Admin' };
export const ROLE_SUMMARY: Record<Role, string> = {
  author: 'Edits, saves and submits documents for review',
  reviewer: 'Comments and requests changes',
  approver: 'Approves and publishes, plus reviewer rights',
  admin: 'Everything, including managing users',
};

export type Permission = 'edit' | 'comment' | 'submit' | 'request_changes' | 'approve' | 'publish' | 'reopen' | 'manage_users';
const PERMISSIONS: Record<Role, Permission[]> = {
  author: ['edit', 'comment', 'submit', 'reopen'],
  reviewer: ['comment', 'request_changes'],
  approver: ['comment', 'request_changes', 'approve', 'publish', 'reopen'],
  admin: ['edit', 'comment', 'submit', 'request_changes', 'approve', 'publish', 'reopen', 'manage_users'],
};
export function permissionsFor(role: Role | null | undefined): Permission[] { return role ? [...PERMISSIONS[role]] : []; }
export function roleCan(role: Role | null | undefined, p: Permission): boolean { return !!role && PERMISSIONS[role].includes(p); }

/* ------------------------------------------------------------------ workflow */

export type WorkflowState = 'draft' | 'in_review' | 'changes_requested' | 'approved' | 'published';
export type WorkflowAction = 'submit' | 'request_changes' | 'approve' | 'publish' | 'reopen';
export const WORKFLOW_STATES: readonly WorkflowState[] = ['draft', 'in_review', 'changes_requested', 'approved', 'published'];
export const WORKFLOW_ACTIONS: readonly WorkflowAction[] = ['submit', 'request_changes', 'approve', 'publish', 'reopen'];
export const WORKFLOW_LABEL: Record<WorkflowState, string> = { draft: 'Draft', in_review: 'In review', changes_requested: 'Changes requested', approved: 'Approved', published: 'Published' };
export const ACTION_LABEL: Record<WorkflowAction, string> = { submit: 'Submit for review', request_changes: 'Request changes', approve: 'Approve', publish: 'Publish', reopen: 'Back to draft' };

/** draft → in_review → approved → published; in_review → changes_requested → draft; reopen returns any later state to draft. */
export const WORKFLOW_TRANSITIONS: Record<WorkflowAction, { from: WorkflowState[]; to: WorkflowState; permission: Permission }> = {
  submit: { from: ['draft'], to: 'in_review', permission: 'submit' },
  request_changes: { from: ['in_review'], to: 'changes_requested', permission: 'request_changes' },
  approve: { from: ['in_review'], to: 'approved', permission: 'approve' },
  publish: { from: ['approved'], to: 'published', permission: 'publish' },
  reopen: { from: ['in_review', 'changes_requested', 'approved', 'published'], to: 'draft', permission: 'reopen' },
};

/** Why an action is not available from a state (null when the state allows it; role is checked separately). */
export function transitionProblem(state: WorkflowState, action: WorkflowAction): string | null {
  const t = WORKFLOW_TRANSITIONS[action];
  if (!t) return `Unknown action ${action}.`;
  if (t.from.includes(state)) return null;
  return `“${ACTION_LABEL[action]}” is only possible when the document is ${t.from.map((s) => WORKFLOW_LABEL[s].toLowerCase()).join(' or ')} (it is ${WORKFLOW_LABEL[state].toLowerCase()}).`;
}

/** States in which saving a changed model sends the document back to draft. */
export const DEMOTE_ON_SAVE: readonly WorkflowState[] = ['approved', 'published', 'changes_requested'];

/* ---------------------------------------------------------------- test cases */

/** The observable outcome of resolving one scenario, as compared by a pinned test case. */
export interface TestOutcome {
  selectedVariants: Record<string, string | null>;
  visibleNodeIds: string[];
  /** Locale the resolver used for approved wording. */
  locale: string | null;
  blockingCount: number;
}

export interface TestFailure { kind: 'selectedVariant' | 'visible' | 'hidden' | 'approvedLocale' | 'noBlocking'; nodeId?: string; expected: string | null; actual: string | null }
export interface TestCaseResult { id: string; name: string; recordId: string; passed: boolean; failures: TestFailure[] }

/** Pure check of one test case's expectations against an actual outcome. */
export function checkTestCase(tc: TestCase, outcome: TestOutcome): TestCaseResult {
  const failures: TestFailure[] = [];
  const e = tc.expect ?? {};
  for (const [nodeId, want] of Object.entries(e.selectedVariants ?? {})) {
    const got = outcome.selectedVariants[nodeId] ?? null;
    if ((want ?? null) !== got) failures.push({ kind: 'selectedVariant', nodeId, expected: want ?? null, actual: got });
  }
  const visible = new Set(outcome.visibleNodeIds);
  for (const id of e.visibleNodeIds ?? []) if (!visible.has(id)) failures.push({ kind: 'visible', nodeId: id, expected: 'visible', actual: 'hidden' });
  for (const id of e.hiddenNodeIds ?? []) if (visible.has(id)) failures.push({ kind: 'hidden', nodeId: id, expected: 'hidden', actual: 'visible' });
  if (e.approvedLocale !== undefined && (e.approvedLocale ?? null) !== (outcome.locale ?? null)) failures.push({ kind: 'approvedLocale', expected: e.approvedLocale ?? null, actual: outcome.locale ?? null });
  if (e.noBlocking && outcome.blockingCount > 0) failures.push({ kind: 'noBlocking', expected: '0 blocking issues', actual: `${outcome.blockingCount} blocking` });
  return { id: tc.id, name: tc.name, recordId: tc.recordId, passed: failures.length === 0, failures };
}

/** Plain sentence for one failure: "Payment guidance shows “Payment due” instead of “Payment support”". */
export function testFailureSentence(f: TestFailure, title: (id: string | null) => string = (id) => id ?? 'nothing'): string {
  switch (f.kind) {
    case 'selectedVariant': return `${title(f.nodeId ?? null)} shows ${f.actual ? `“${title(f.actual)}”` : 'nothing'} instead of ${f.expected ? `“${title(f.expected)}”` : 'nothing'}`;
    case 'visible': return `${title(f.nodeId ?? null)} should be shown but is hidden`;
    case 'hidden': return `${title(f.nodeId ?? null)} should be hidden but is shown`;
    case 'approvedLocale': return `wording language is ${f.actual ?? 'not set'} instead of ${f.expected ?? 'not set'}`;
    case 'noBlocking': return `expected no blocking issues but found ${f.actual}`;
  }
}

/* ------------------------------------------------------------------ comments */

export const COMMENT_MAX = 2000;
/** Plain-text sanitising: drop control and bidi-override characters, normalise newlines, trim. Never HTML. */
export function sanitizeCommentBody(input: unknown): string {
  const s = typeof input === 'string' ? input : '';
  return s.replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
