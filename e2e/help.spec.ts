/**
 * Help for every screen: opens on the current screen's help (the ? key or Settings and help), a searchable list of all
 * screens grouped by the eight menu sections, the shortcuts and the studio's own words. Runs against the real local stack.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { open, resetAll } from './helpers';
import { GLOSSARY, SCREEN_HELP } from '../apps/web/src/help/content';

const SHELL = readFileSync(path.join(process.cwd(), 'apps/web/src/shell/Shell.tsx'), 'utf8');
/** The ids in `SCREENS` and `SECTIONS` of Shell.tsx, read from the source so a new screen cannot be forgotten. */
const screensBlock = SHELL.slice(SHELL.indexOf('export const SCREENS = ['), SHELL.indexOf('] as const;'));
const SCREEN_IDS = [...screensBlock.matchAll(/\{ id: '(S\d\d)'/g)].map((m) => m[1]);
const SECTION_COUNT = [...SHELL.slice(SHELL.indexOf('export const SECTIONS = [')).split('] as const;')[0].matchAll(/\{ id: '[a-z-]+', label:/g)].length;

test.describe('help content', () => {
  test('HP01 every screen in SCREENS has help, written to the brief, and every "where to go next" link is a real screen', () => {
    expect(SCREEN_IDS.length).toBe(26);
    expect(Object.keys(SCREEN_HELP).sort()).toEqual([...SCREEN_IDS].sort());
    for (const id of SCREEN_IDS) {
      const h = SCREEN_HELP[id];
      expect(h.purpose.length, `${id} purpose`).toBeGreaterThan(20);
      expect(h.actions.length, `${id} actions`).toBeGreaterThanOrEqual(3);
      expect(h.actions.length, `${id} actions`).toBeLessThanOrEqual(5);
      expect(h.next.length, `${id} next`).toBeGreaterThanOrEqual(1);
      expect(h.next.length, `${id} next`).toBeLessThanOrEqual(2);
      for (const n of h.next) {
        expect(SCREEN_IDS, `${id} links to ${n.screen}`).toContain(n.screen);
        expect(n.screen, `${id} must not link to itself`).not.toBe(id);
        expect(n.why.length).toBeGreaterThan(5);
      }
    }
    for (const id of ['S03', 'S04', 'S05', 'S06', 'S20']) expect(SCREEN_HELP[id].read?.length, `${id} says how to read it`).toBeGreaterThan(0);
    for (const g of GLOSSARY) { expect(g.means.length).toBeGreaterThan(30); if (g.screen) expect(SCREEN_IDS).toContain(g.screen); }
    expect(GLOSSARY.map((g) => g.term)).toEqual(['Blocker', 'Known data problem', 'Release', 'Test and Production', 'Proof record', 'Pinned test', 'Synthetic customer', 'Alternative (variant)', 'The document\'s date', 'Repeating section', 'Coverage']);
  });
});

test.describe('help sheet', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('HP02 the ? key opens help on the screen you are on', async ({ page }) => {
    const cases: Array<[string, string, string]> = [
      ['overview', 'S19', 'Overview'], ['design', 'S02', 'Design Studio'], ['rules-data', 'S07', 'Rules & Data'], ['blockers', 'S17', 'Blockers'],
      ['releases', 'S18', 'Releases'], ['compare', 'S20', 'Before & after'], ['data', 'S16', 'Data Explorer'], ['activity', 'S14', 'Activity'],
    ];
    for (const [view, id, title] of cases) {
      await open(page, 'aster-card-demo', view);
      await page.locator('#main h1').first().click({ position: { x: 2, y: 2 } }).catch(() => undefined);
      await page.keyboard.press('?');
      await expect(page.getByTestId('help-sheet')).toBeVisible();
      await expect(page.getByTestId('help-article')).toHaveAttribute('data-screen', id);
      await expect(page.getByTestId('help-article').locator('h2')).toHaveText(title);
      await expect(page.getByTestId('help-article')).not.toContainText('has not been written yet');
      for (const h of ['What this screen is for', 'What you can do here', 'Where to go next']) await expect(page.getByTestId('help-article').getByRole('heading', { name: h })).toBeVisible();
      await expect(page.getByTestId(`help-topic-${id}`)).toHaveAttribute('aria-current', 'true');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('help-sheet')).toHaveCount(0);
    }
  });

  test('HP03 the gallery has help too, and Settings and help opens it and gets focus back', async ({ page }) => {
    await page.goto('/projects');
    await expect(page.getByTestId('project-gallery')).toBeVisible();
    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('settings-menu')).toContainText('Help for this screen');
    await page.getByTestId('open-help').click();
    await expect(page.getByTestId('help-article')).toHaveAttribute('data-screen', 'S01');
    await expect(page.getByTestId('help-search')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('help-sheet')).toHaveCount(0);
    await expect(page.getByTestId('open-settings')).toBeFocused();
  });

  test('HP04 all screens are listed, grouped by the eight sections, and each opens its help', async ({ page }) => {
    await open(page, 'aster-card-demo', 'overview');
    await page.keyboard.press('?');
    await expect(page.getByTestId('help-list').locator('section[data-section] > h3')).toHaveCount(SECTION_COUNT);
    expect(SECTION_COUNT).toBe(8);
    for (const id of SCREEN_IDS) {
      const item = page.getByTestId(`help-topic-${id}`);
      await expect(item).toHaveAttribute('data-has-help', 'true');
      await item.click();
      await expect(page.getByTestId('help-article')).toHaveAttribute('data-screen', id);
      await expect(page.getByTestId('help-missing')).toHaveCount(0);
      await expect(page.getByTestId('help-article').locator('li').first()).toBeVisible();
    }
    // Proof and Blockers are built: their help describes them and nothing says "being built"
    await page.getByTestId('help-topic-S21').click();
    await expect(page.getByTestId('help-article')).toContainText('proof record');
    await expect(page.getByTestId('help-building')).toHaveCount(0);
    await page.getByTestId('help-topic-S17').click();
    await expect(page.getByTestId('help-article')).toContainText('known data problem');
    await expect(page.getByTestId('help-building')).toHaveCount(0);
  });

  test('HP05 search finds screens and words, and says so when nothing matches', async ({ page }) => {
    await open(page, 'aster-card-demo', 'overview');
    await page.keyboard.press('?');
    const search = page.getByTestId('help-search');
    await search.fill('release');
    await expect(page.getByTestId('help-topic-S18')).toBeVisible();
    await expect(page.getByTestId('help-topic-S01')).toHaveCount(0);
    await expect(page.getByTestId('help-word-release')).toBeVisible();
    await search.fill('translation');
    await expect(page.getByTestId('help-topic-S13')).toBeVisible();
    await search.fill('pinned');
    await expect(page.getByTestId('help-word-pinned-test')).toBeVisible();
    await page.getByTestId('help-word-pinned-test').click();
    await expect(page.getByTestId('help-term-pinned-test')).toBeFocused();
    await search.fill('zzzzqx');
    await expect(page.getByTestId('help-nothing')).toBeVisible();
    await search.fill('');
    await expect(page.getByTestId('help-topic-S01')).toBeVisible();
  });

  test('HP06 "where to go next" links open the screen and close the help', async ({ page }) => {
    await open(page, 'aster-card-demo', 'rules-data');
    await page.keyboard.press('?');
    await page.getByTestId('help-next-S16').click();
    await expect(page.getByTestId('help-sheet')).toHaveCount(0);
    await expect(page).toHaveURL(/\/data$/);
    await page.keyboard.press('?');
    await page.getByTestId('help-topic-S18').click();
    await page.getByTestId('help-open-screen').click();
    await expect(page).toHaveURL(/\/releases$/);
    await expect(page.locator('#main h1').first()).toHaveText('Releases');
  });

  test('HP07 the ? key does nothing while you are typing in a field', async ({ page }) => {
    await open(page, 'aster-card-demo', 'overview');
    await page.getByTestId('record-selector').click();
    const field = page.getByTestId('record-search');
    await field.fill('');
    await field.press('?');
    await expect(field).toHaveValue('?');
    await expect(page.getByTestId('help-sheet')).toHaveCount(0);
    await page.keyboard.press('Escape');
    // in the help's own search box it is just a character, and does not close the sheet
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('?');
    await expect(page.getByTestId('help-sheet')).toBeVisible();
    await page.getByTestId('help-search').press('?');
    await expect(page.getByTestId('help-search')).toHaveValue('?');
    await expect(page.getByTestId('help-sheet')).toBeVisible();
  });

  test('HP08 the glossary, the shortcuts and the tour button are in the sheet', async ({ page }) => {
    await open(page, 'aster-card-demo', 'overview');
    await page.keyboard.press('?');
    const gl = page.getByTestId('help-glossary');
    await gl.scrollIntoViewIfNeeded();
    for (const t of ['Blocker', 'Known data problem', 'Release', 'Test and Production', 'Proof record', 'Pinned test', 'Synthetic customer', 'Alternative (variant)', 'Coverage']) {
      await expect(gl.getByRole('term').filter({ hasText: new RegExp(`^${t.replace(/[()]/g, '\\$&')}$`) })).toHaveCount(1);
    }
    await page.getByTestId('help-jump-shortcuts').click();
    await expect(page.getByTestId('help-shortcuts')).toContainText('Open search / command palette');
    await expect(page.getByTestId('help-start-tour')).toBeVisible();
    // the guided demo is not help: it is still its own screen
    await page.getByTestId('help-topic-S11').click();
    await expect(page.getByTestId('help-article')).toContainText('demonstration, not help');
  });

  test('HP09 it fits at 1000 px wide and in the dark theme', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.addInitScript(() => { try { localStorage.setItem('iss.theme', 'dark'); } catch { /* */ } });
    await open(page, 'aster-card-demo', 'blockers');
    await page.keyboard.press('?');
    const box = (await page.getByTestId('help-sheet').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1000);
    expect(box.y + box.height).toBeLessThanOrEqual(700);
  });
});

test.describe('Overview links', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('HP10 "?assist=coverage" opens the coverage dialog, and Overview\'s coverage button uses it', async ({ page }) => {
    await open(page, 'aster-card-demo', 'rules-data?assist=coverage');
    await expect(page.getByTestId('coverage-panel')).toBeVisible();
    await expect(page).not.toHaveURL(/assist=/);
    await open(page, 'aster-card-demo', 'overview');
    await expect(page.getByTestId('overview-step-coverage')).not.toHaveAttribute('data-state', 'working', { timeout: 60_000 });
    await page.getByTestId('overview-step-action-coverage').click();
    await expect(page).toHaveURL(/\/rules-data/);
    await expect(page.getByTestId('coverage-panel')).toBeVisible();
    // the existing way in still works
    await open(page, 'aster-card-demo', 'rules-data');
    await expect(page.getByTestId('coverage-panel')).toHaveCount(0);
    await page.getByTestId('coverage-open').click();
    await expect(page.getByTestId('coverage-panel')).toBeVisible();
  });

  test('HP11 "See what customers will see differently" is on the review and release steps only once a release exists', async ({ page }) => {
    await open(page, 'aster-card-demo', 'overview');
    await expect(page.getByTestId('overview-step-release')).toBeVisible();
    await expect(page.getByTestId('overview-step-why-release')).toContainText('Nothing has been released yet');
    await expect(page.getByTestId('overview-step-compare-review')).toHaveCount(0);
    await expect(page.getByTestId('overview-step-compare-release')).toHaveCount(0);

    const at = '2026-11-01T10:00:00.000Z';
    await page.route('**/api/v1/projects/aster-card-demo/releases', (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const rel = { id: 'aster-card-demo-r1', documentId: 'aster-card-demo', number: 1, title: 'Aster Card', documentType: 'credit-statement', kind: 'Credit-card statement', modelVersion: 1, contentDigest: 'x', languages: ['en-US'], approvedBy: null, approvedAt: at, origin: 'approval', createdBy: null, createdAt: at, versions: {}, stages: { test: { status: 'current', since: at, by: null }, production: null }, standing: 'test' };
      return route.fulfill({ json: { documentId: 'aster-card-demo', documentExists: true, title: 'Aster Card', releases: [rel], production: null, test: rel.id, create: { allowed: false, reason: 'Not approved.' } } });
    });
    await page.reload();
    await expect(page.getByTestId('overview-step-compare-review')).toHaveText('See what customers will see differently');
    await expect(page.getByTestId('overview-step-compare-release')).toBeVisible();
    await expect(page.getByTestId('overview-step-action-review')).toBeVisible();
    await expect(page.getByTestId('overview-step-action-release')).toBeVisible();
    await page.getByTestId('overview-step-compare-release').click();
    await expect(page).toHaveURL(/\/aster-card-demo\/compare$/);
  });
});
