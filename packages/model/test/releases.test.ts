import { describe, expect, it } from 'vitest';
import {
  RELEASE_STAGES, RELEASE_STAGE_LABEL, cleanReleaseNote, currentRelease, latestRelease, nextReleaseNumber, parseReleaseId, permissionsFor, promoteProblem, releaseCreationDecision,
  releaseId, releasePackageName, releaseRoleProblem, releaseStanding, roleCan, roleCanRelease, supersededByPromotion, withdrawProblem, ROLES,
  type ReleaseInfo, type ReleaseStageStatus,
} from '../src';

type R = Pick<ReleaseInfo, 'number' | 'stages'> & { contentDigest: string };
const at = '2026-11-13T10:00:00.000Z';
const stage = (status: ReleaseStageStatus) => ({ status, since: at, by: null });
const rel = (number: number, test: ReleaseStageStatus, production: ReleaseStageStatus | null = null, contentDigest = `digest-${number}`): R =>
  ({ number, contentDigest, stages: { test: stage(test), production: production ? stage(production) : null } });

describe('release numbering and names', () => {
  it('starts at 1 and never reuses a number, whatever happened to earlier releases', () => {
    expect(nextReleaseNumber([])).toBe(1);
    expect(nextReleaseNumber([1, 2, 3])).toBe(4);
    // a gap (nothing is ever deleted, but the rule must not depend on that) and an unordered list
    expect(nextReleaseNumber([5, 1, 3])).toBe(6);
    expect(nextReleaseNumber([2, Number.NaN, 1.5, -4])).toBe(3);
  });

  it('names a release and its package after the document and the number, and reads the id back', () => {
    expect(releaseId('aster-card-demo', 3)).toBe('aster-card-demo-r3');
    expect(releasePackageName('aster-card-demo', 3)).toBe('aster-card-demo-r3.zip');
    expect(parseReleaseId('aster-card-demo-r3')).toEqual({ documentId: 'aster-card-demo', number: 3 });
    // a document id may itself end in "-r2"
    expect(parseReleaseId('letter-r2-r10')).toEqual({ documentId: 'letter-r2', number: 10 });
    for (const bad of ['aster-card-demo', 'aster-card-demo-r0', 'aster-card-demo-r', 'Aster-r1', 'ab-r1', '../x-r1', 'aster-card-demo-r1.zip']) expect(parseReleaseId(bad)).toBeNull();
  });

  it('has two stages, Test then Production', () => {
    expect(RELEASE_STAGES).toEqual(['test', 'production']);
    expect(RELEASE_STAGE_LABEL).toEqual({ test: 'Test', production: 'Production' });
  });
});

describe('creating a release', () => {
  it('the first approval makes release 1; a changed approval makes the next and supersedes the one in Test', () => {
    expect(releaseCreationDecision([], 'a')).toEqual({ create: true, number: 1, supersedesAtTest: [] });
    expect(releaseCreationDecision([rel(1, 'current', null, 'a')], 'b')).toEqual({ create: true, number: 2, supersedesAtTest: [1] });
    expect(releaseCreationDecision([rel(1, 'superseded', 'current', 'a'), rel(2, 'current', null, 'b')], 'c')).toEqual({ create: true, number: 3, supersedesAtTest: [2] });
  });

  it('approving the same content as the latest release again does not make a duplicate', () => {
    expect(releaseCreationDecision([rel(1, 'current', null, 'a')], 'a')).toEqual({ create: false, reason: 'unchanged', number: 1 });
    // still the same release once it is in Production
    expect(releaseCreationDecision([rel(1, 'current', 'current', 'a')], 'a')).toEqual({ create: false, reason: 'unchanged', number: 1 });
    // only the latest release counts: going back to earlier content is a new release
    expect(releaseCreationDecision([rel(1, 'superseded', null, 'a'), rel(2, 'current', null, 'b')], 'a')).toEqual({ create: true, number: 3, supersedesAtTest: [2] });
  });

  it('approving the content of a withdrawn latest release again makes a new release', () => {
    expect(releaseCreationDecision([rel(1, 'withdrawn', null, 'a')], 'a')).toEqual({ create: true, number: 2, supersedesAtTest: [] });
    expect(releaseCreationDecision([rel(1, 'current', 'withdrawn', 'a')], 'a')).toEqual({ create: true, number: 2, supersedesAtTest: [1] });
  });

  it('finds the latest release and the current one at a stage', () => {
    const all = [rel(1, 'superseded', 'current'), rel(3, 'current'), rel(2, 'superseded', 'superseded')];
    expect(latestRelease(all)?.number).toBe(3);
    expect(latestRelease([])).toBeNull();
    expect(currentRelease(all, 'test')?.number).toBe(3);
    expect(currentRelease(all, 'production')?.number).toBe(1);
    expect(currentRelease([rel(1, 'withdrawn')], 'test')).toBeNull();
    expect(currentRelease([rel(1, 'current')], 'production')).toBeNull();
  });
});

describe('moving a release between stages', () => {
  it('a release in Test can go to Production, and takes the place of the one that was there', () => {
    const all = [rel(1, 'superseded', 'current'), rel(2, 'current')];
    expect(promoteProblem(all[1])).toBeNull();
    expect(supersededByPromotion(all, 2)).toEqual([1]);
    expect(supersededByPromotion([rel(1, 'current')], 1)).toEqual([]);
  });

  it('an earlier release can be put back: superseded at either stage is not a reason to refuse', () => {
    expect(promoteProblem(rel(1, 'superseded'))).toBeNull();
    expect(promoteProblem(rel(1, 'superseded', 'superseded'))).toBeNull();
    expect(supersededByPromotion([rel(1, 'superseded', 'superseded'), rel(2, 'current', 'current')], 1)).toEqual([2]);
  });

  it('refuses to promote the Production release again, or a withdrawn release', () => {
    expect(promoteProblem(rel(2, 'current', 'current'))).toMatch(/already the Production release/);
    expect(promoteProblem(rel(2, 'withdrawn'))).toMatch(/withdrawn from Test/);
    expect(promoteProblem(rel(2, 'current', 'withdrawn'))).toMatch(/withdrawn from Production/);
  });

  it('withdrawing: only from a stage the release is in, once, and not from Test while it is the Production release', () => {
    expect(withdrawProblem(rel(1, 'current'), 'test')).toBeNull();
    expect(withdrawProblem(rel(1, 'superseded'), 'test')).toBeNull();
    expect(withdrawProblem(rel(1, 'current'), 'production')).toMatch(/never been in Production/);
    expect(withdrawProblem(rel(1, 'withdrawn'), 'test')).toMatch(/already withdrawn from Test/);
    expect(withdrawProblem(rel(1, 'current', 'current'), 'test')).toMatch(/Withdraw it from Production first/);
    expect(withdrawProblem(rel(1, 'current', 'current'), 'production')).toBeNull();
    expect(withdrawProblem(rel(1, 'current', 'superseded'), 'production')).toBeNull();
    expect(withdrawProblem(rel(1, 'current', 'withdrawn'), 'production')).toMatch(/already withdrawn from Production/);
    // once it is out of Production it can be taken out of Test too
    expect(withdrawProblem(rel(1, 'current', 'withdrawn'), 'test')).toBeNull();
  });

  it('says where a release stands in one word', () => {
    expect(releaseStanding(rel(1, 'current'))).toBe('test');
    expect(releaseStanding(rel(1, 'current', 'current'))).toBe('production');
    expect(releaseStanding(rel(1, 'superseded', 'current'))).toBe('production');
    expect(releaseStanding(rel(1, 'superseded'))).toBe('superseded');
    expect(releaseStanding(rel(1, 'superseded', 'superseded'))).toBe('superseded');
    expect(releaseStanding(rel(1, 'withdrawn'))).toBe('withdrawn');
    expect(releaseStanding(rel(1, 'superseded', 'withdrawn'))).toBe('withdrawn');
    // withdrawn from Production but still the release in Test
    expect(releaseStanding(rel(1, 'current', 'withdrawn'))).toBe('test');
  });
});

describe('who may do what with a release', () => {
  it('approvers and admins create releases and keep the handover log; only admins move a release between stages', () => {
    const can = (action: Parameters<typeof roleCanRelease>[1]) => ROLES.filter((r) => roleCanRelease(r, action));
    expect(can('create')).toEqual(['approver', 'admin']);
    expect(can('handover')).toEqual(['approver', 'admin']);
    expect(can('promote')).toEqual(['admin']);
    expect(can('withdraw')).toEqual(['admin']);
    expect(roleCanRelease(null, 'create')).toBe(false);
    expect(roleCanRelease(undefined, 'promote')).toBe(false);
  });

  it('explains a refusal in plain words, and says nothing when the role may', () => {
    expect(releaseRoleProblem('approver', 'promote')).toBe('Only admins can move a release to Production.');
    expect(releaseRoleProblem('approver', 'withdraw')).toBe('Only admins can withdraw a release.');
    expect(releaseRoleProblem('author', 'create')).toBe('Only approvers and admins can create a release.');
    expect(releaseRoleProblem('reviewer', 'handover')).toBe('Only approvers and admins can add to the handover log.');
    expect(releaseRoleProblem('admin', 'promote')).toBeNull();
    expect(releaseRoleProblem('approver', 'create')).toBeNull();
  });

  it('the permission to move a release belongs to admins alone, and nobody lost a permission they had', () => {
    expect(ROLES.filter((r) => roleCan(r, 'promote_release'))).toEqual(['admin']);
    expect(permissionsFor('author')).toEqual(['edit', 'comment', 'submit', 'reopen']);
    expect(permissionsFor('reviewer')).toEqual(['comment', 'request_changes']);
    expect(permissionsFor('approver')).toEqual(['comment', 'request_changes', 'approve', 'publish', 'reopen']);
    expect(permissionsFor('admin')).toEqual(['edit', 'comment', 'submit', 'request_changes', 'approve', 'publish', 'reopen', 'manage_users', 'promote_release']);
  });
});

describe('notes and reasons', () => {
  it('are one paragraph of plain text', () => {
    expect(cleanReleaseNote('  Wrong  logo\r\n\tin the footer  ')).toBe('Wrong logo in the footer');
    expect(cleanReleaseNote('a\u0000b‮c﻿')).toBe('a b c');
    expect(cleanReleaseNote(undefined)).toBe('');
    expect(cleanReleaseNote(42)).toBe('');
    expect(cleanReleaseNote('   ')).toBe('');
  });
});
