import { expect, test } from '@playwright/test';
import { API, open } from './helpers';
import { gotoScreen } from './nav-helper';

/**
 * Collaboration features with auth OFF (the default local mode): version history + restore, review workflow,
 * comments and the Activity log. Each test works on its own duplicate of the HarborCare sample so other suites
 * resetting the demo projects cannot interfere; the copy is deleted afterwards.
 */

let pid = '';
test.beforeEach(async ({ request }) => {
  const r = await request.post(`${API}/projects/harborcare-demo/duplicate`, { data: { title: `Collab E2E ${Date.now().toString(36)}` } });
  expect(r.ok()).toBeTruthy();
  pid = (await r.json()).project.projectId;
});
test.afterEach(async ({ request }) => { if (pid) await request.delete(`${API}/projects/${pid}`); });

const store = (page: import('@playwright/test').Page, js: string) => page.evaluate(js);

test('history: a saved edit appears as a new version, the diff says what changed, restore brings it back', async ({ page }) => {
  await open(page, pid, 'design');
  await expect(page.getByTestId('current-user')).toHaveCount(0); // auth off: no sign-in UI
  const nodeId = await store(page, `window.__iss.store.getState().project.nodes.find((n) => n.type === 'variant-set').id`) as string;
  const original = await store(page, `window.__iss.store.getState().project.nodes.find((n) => n.id === '${nodeId}').name`) as string;
  const v0 = await store(page, 'window.__iss.store.getState().serverVersion') as number;
  const r = await store(page, `window.__iss.store.getState().dispatch({ type: 'UPDATE_NODE', nodeId: '${nodeId}', patch: { name: 'Renamed by collab test' } })`) as { ok: boolean };
  expect(r.ok).toBe(true);
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  const v1 = await store(page, 'window.__iss.store.getState().serverVersion') as number;
  expect(v1).toBeGreaterThan(v0);

  await page.getByTestId('open-history').click();
  const panel = page.getByTestId('history-panel');
  await expect(panel).toBeVisible();
  const items = panel.getByTestId('history-version');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toHaveAttribute('data-version', String(v1));
  await expect(items.first()).toContainText('Current');
  await expect(items.first()).toContainText('Local admin');
  await expect(items.nth(1)).toContainText('Duplicated from');

  // Selecting the older version shows the readable change list against the current version.
  await items.nth(1).click();
  const diff = panel.getByTestId('history-diff');
  await expect(diff).toContainText('renamed');
  await expect(diff).toContainText(original);
  await expect(diff).toContainText('Renamed by collab test');

  await panel.getByTestId('history-restore').click();
  await panel.getByTestId('history-restore-confirm').click();
  await expect(page.getByTestId('save-state')).toContainText(`v${v1 + 1}`);
  expect(await store(page, `window.__iss.store.getState().project.nodes.find((n) => n.id === '${nodeId}').name`)).toBe(original);
  await expect(items).toHaveCount(3);
  await expect(items.first()).toContainText(`Restored v${v0}`);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('history: restore is disabled while there are unsaved changes, and the palette opens history', async ({ page }) => {
  await open(page, pid, 'design');
  const nodeId = await store(page, `window.__iss.store.getState().project.nodes.find((n) => n.type === 'variant-set').id`) as string;
  await store(page, `window.__iss.store.getState().dispatch({ type: 'UPDATE_NODE', nodeId: '${nodeId}', patch: { name: 'Saved name' } })`);
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  await store(page, `window.__iss.store.getState().dispatch({ type: 'UPDATE_NODE', nodeId: '${nodeId}', patch: { name: 'Unsaved name' } })`);
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').fill('version history');
  await page.keyboard.press('Enter');
  const panel = page.getByTestId('history-panel');
  await panel.getByTestId('history-version').nth(1).click();
  await expect(panel.getByTestId('history-restore')).toBeDisabled();
  await panel.getByTestId('history-discard').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  await expect(panel.getByTestId('history-restore')).toBeEnabled();
});

test('review: submit → approve → publish on a clean project, comments add/resolve, Activity lists the save', async ({ page }) => {
  await open(page, pid, 'design');
  const chip = page.getByTestId('workflow-status');
  await expect(chip).toHaveAttribute('data-state', 'draft');
  await chip.click();
  const panel = page.getByTestId('review-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('review-readiness')).toContainText('No blocking issues for any of the');
  await panel.getByTestId('workflow-action-submit').click();
  await expect(chip).toHaveAttribute('data-state', 'in_review');
  await expect(panel.getByTestId('review-state')).toContainText('In review');
  await expect(panel.getByTestId('workflow-action-approve')).toBeEnabled();
  await panel.getByTestId('workflow-action-approve').click();
  await expect(chip).toHaveAttribute('data-state', 'approved');
  await panel.getByTestId('workflow-action-publish').click();
  await expect(chip).toHaveAttribute('data-state', 'published');
  await expect(panel.getByTestId('workflow-history')).toContainText('Local admin published');

  // Comment on a component, then resolve it.
  const nodeId = await store(page, `window.__iss.store.getState().project.nodes.find((n) => n.type === 'variant-set').id`) as string;
  await panel.getByText('Comment on a component…').click();
  await panel.getByTestId('review-comment-node').selectOption(nodeId);
  await panel.getByTestId('comment-input').fill('Please double-check this wording.');
  await panel.getByTestId('comment-submit').click();
  const item = panel.getByTestId('comment-item').filter({ hasText: 'Please double-check this wording.' });
  await expect(item).toBeVisible();
  await expect(panel.getByTestId('review-comment-group')).toHaveAttribute('data-node', nodeId);
  await panel.getByTestId('comment-resolve').first().click();
  await expect(panel.getByTestId('review-comment-group')).toHaveCount(0);
  await expect(panel.getByText('Show 1 resolved')).toBeVisible();

  // Saving a change after publishing returns the document to draft.
  await page.keyboard.press('Escape');
  await store(page, `window.__iss.store.getState().dispatch({ type: 'UPDATE_NODE', nodeId: '${nodeId}', patch: { name: 'Changed after publish' } })`);
  await page.getByTestId('save-project').click();
  await expect(chip).toHaveAttribute('data-state', 'draft');

  await gotoScreen(page, 'S14');
  await expect(page.getByTestId('activity-screen')).toBeVisible();
  const saveRow = page.getByTestId('activity-row').and(page.locator('[data-action="project.save"]')).first();
  await expect(saveRow).toContainText('Saved v');
  await expect(saveRow).toContainText('Local admin');
  await expect(page.locator('[data-testid="activity-row"][data-action="workflow.publish"]')).toContainText('Published');
  await expect(page.locator('[data-testid="activity-row"][data-action="comment.create"]')).toContainText('Commented on');
  await page.getByTestId('activity-filter-action').selectOption('workflow.');
  await expect(page.getByTestId('activity-row').first()).toHaveAttribute('data-action', /^workflow\./);
  await expect(page.locator('[data-testid="activity-row"][data-action="project.save"]')).toHaveCount(0);
});

test('approval is blocked with plain reasons when the model has blocking issues', async ({ page, request }) => {
  // The Aster sample has records whose required Spanish wording is missing: approval must be refused.
  const dup = await request.post(`${API}/projects/aster-card-demo/duplicate`, { data: { title: `Collab E2E aster ${Date.now().toString(36)}` } });
  const asterCopy = (await dup.json()).project.projectId;
  try {
    await open(page, asterCopy, 'design');
    await page.getByTestId('workflow-status').click();
    const panel = page.getByTestId('review-panel');
    await expect(panel.getByTestId('readiness-blocking').first()).toContainText('synthetic records');
    await panel.getByTestId('workflow-action-submit').click();
    await expect(panel.getByTestId('workflow-action-approve')).toBeDisabled();
    await panel.getByTestId('readiness-blocking').first().getByText('Open in Validate').click();
    await expect(page).toHaveURL(new RegExp(`/studio/${asterCopy}/validate`));
  } finally {
    await request.delete(`${API}/projects/${asterCopy}`);
  }
});

test('global Activity is reachable from the gallery header', async ({ page }) => {
  await page.goto('/projects');
  await page.getByTestId('open-activity').click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(page.getByTestId('activity-screen')).toBeVisible();
  await expect(page.getByTestId('activity-row').first()).toBeVisible();
});
