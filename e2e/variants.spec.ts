import { expect, test, type Page } from '@playwright/test';
import { API, open } from './helpers';

/**
 * VR: variants by brand or region (wave 5, section 1), end to end: make a variant from the gallery, change its brand and
 * a wording, see the differences, try a locked change, change the base, see "Update available", preview and apply the
 * update, undo it, and detach. The base is a copy of the benefits sample, made for this run.
 */

const dispatch = (page: Page, cmd: unknown) => page.evaluate((c) => (window as any).__iss.store.getState().dispatch(c), cmd);
const saved = async (page: Page) => {
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved');
};

test.describe.configure({ mode: 'serial' });

test('VR01 make a variant, change it, see what differs, meet the lock, take an update from the base, undo it and detach', async ({ page, request }) => {
  test.setTimeout(180_000);
  const stamp = Date.now().toString(36);
  const base = (await (await request.post(`${API}/projects/harborcare-demo/duplicate`, { data: { title: `VR base ${stamp}` } })).json()).project;

  /* ---- make a variant from the gallery card's menu */
  await page.goto('/projects');
  await page.getByTestId(`card-menu-${base.projectId}`).click();
  await page.getByTestId(`new-variant-${base.projectId}`).click();
  await page.getByTestId('new-variant-title').fill(`VR Lakeshore ${stamp}`);
  await page.getByTestId('new-variant-purpose-region').check();
  await page.getByTestId('new-variant-label').fill('Lakeshore region');
  await page.getByTestId('new-variant-create').click();
  await expect(page).toHaveURL(/\/overview$/);
  const variantId = new URL(page.url()).pathname.split('/')[2];
  await page.waitForFunction(() => (window as any).__iss?.store.getState().projectStatus === 'ready');
  const panel = page.getByTestId('variant-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('variant-follows')).toContainText(`Follows version ${base.modelVersion}`);
  await expect(page.getByTestId('variant-no-differences')).toBeVisible();

  /* ---- change its brand and a wording: the differences appear, grouped, with the base's value beside */
  expect((await dispatch(page, { type: 'SET_BRAND', brand: { primary: '#0B4F7C', accent: '#0F766E' } })).ok).toBe(true);
  const address = await page.evaluate(() => (window as any).__iss.store.getState().project.nodes.find((n: any) => n.id === 'customer-address').content);
  expect((await dispatch(page, { type: 'UPDATE_NODE', nodeId: 'customer-address', patch: { content: { ...address, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Lakeshore member services' }] }] } } })).ok).toBe(true);
  const diffs = page.getByTestId('variant-differences');
  await expect(diffs.locator('[data-id="brand"]')).toBeVisible();
  await expect(diffs.locator('[data-id="nodes[customer-address].content"]')).toContainText('Lakeshore member services');
  await expect(page.getByTestId('variant-diff-group-brand')).toBeVisible();
  await expect(page.getByTestId('variant-diff-group-wording')).toBeVisible();
  // "Use the base's again" drops one difference, as one undoable step
  await diffs.locator('[data-id="nodes[customer-address].content"]').getByTestId('variant-use-base').click();
  await expect(diffs.locator('[data-id="nodes[customer-address].content"]')).toHaveCount(0);
  await page.getByTestId('undo').click();
  await expect(diffs.locator('[data-id="nodes[customer-address].content"]')).toBeVisible();
  await saved(page);

  /* ---- a locked change is refused, calmly, in the Inspector, with a way to the base */
  await page.goto(`/studio/${variantId}/design?node=statement-title`);
  await page.waitForFunction(() => (window as any).__iss?.store.getState().projectStatus === 'ready');
  await expect(page.getByTestId('component-inspector')).toContainText('From the base');
  const refused = await dispatch(page, { type: 'SET_LAYOUT', nodeId: 'statement-title', profile: 'paged', layout: { xPt: 60 } });
  expect(refused).toMatchObject({ ok: false, code: 'VARIANT_LOCKED' });
  await expect(page.getByTestId('variant-locked-message')).toContainText(`The position and size of`);
  await expect(page.getByTestId('variant-locked-message')).toContainText(`come from the base document “VR base ${stamp}”. Change them there, or detach this variant.`);
  await expect(page.getByTestId('variant-open-in-base')).toHaveAttribute('href', `/studio/${base.projectId}/design?node=statement-title`);
  await page.getByTestId('insp-tab-layout').click();
  await expect(page.getByTestId('variant-layout-locked')).toBeVisible();
  // the component whose wording differs carries a mark in the layers
  await page.evaluate(() => (window as any).__iss.store.getState().select('customer-address'));
  await expect(page.getByTestId('inspector-differs')).toBeVisible();

  /* ---- the base changes: "Update available" on the variant's Overview and its gallery card */
  const b = (await (await request.get(`${API}/projects/${base.projectId}`)).json()).project;
  const changed = { ...b, modelVersion: b.modelVersion + 1, brand: { primary: '#222222', accent: '#AA0000' }, nodes: b.nodes.map((n: any) => (n.id === 'not-a-bill-banner' ? { ...n, name: 'Not a bill (banner)' } : n)) };
  expect((await request.put(`${API}/projects/${base.projectId}`, { data: { project: changed }, headers: { 'If-Match': `"${b.modelVersion}"` } })).ok()).toBeTruthy();
  await page.goto('/projects');
  await expect(page.getByTestId(`variant-chip-${variantId}`)).toContainText(`Variant of VR base ${stamp}`);
  await expect(page.getByTestId(`variant-update-${variantId}`)).toBeVisible();
  await open(page, variantId, 'overview');
  await expect(page.getByTestId('variant-behind')).toBeVisible();
  const update = page.getByTestId('variant-update');
  await expect(update.getByTestId('variant-update-comes-in').locator('[data-id="nodes[not-a-bill-banner].name"]')).toBeVisible();
  await expect(update.getByTestId('variant-update-kept').locator('[data-id="brand"]')).toContainText('Base now');
  await expect(update.getByTestId('variant-update-needs-look-none')).toBeVisible();

  /* ---- see what customers will see differently: Before & after, the variant now against the variant with the update */
  await update.getByTestId('variant-update-see').click();
  await expect(page).toHaveURL(/\/compare\?before=working&after=update/);
  await expect(page.getByTestId('cmp-after')).toHaveAttribute('data-value', 'update');
  await expect(page.getByTestId('cmp-limits')).toBeVisible();
  await expect(page.getByTestId('cmp-no-update')).toHaveCount(0);

  /* ---- apply it (one step in the working version), undo it, apply again and save */
  await open(page, variantId, 'overview');
  await page.getByTestId('variant-update-apply').click();
  await expect(page.getByTestId('variant-behind')).toHaveCount(0);
  await expect(page.getByTestId('variant-follows')).toContainText(`Follows version ${changed.modelVersion}`);
  await expect(page.getByTestId('save-state')).toContainText('Unsaved');
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('variant-behind')).toBeVisible();
  await page.getByTestId('variant-update-apply').click();
  await saved(page);
  const after = (await (await request.get(`${API}/projects/${variantId}`)).json()).project;
  expect(after.variantOf.modelVersion).toBe(changed.modelVersion);
  expect(after.brand.accent).toBe('#0F766E'); // kept as yours
  expect(after.nodes.find((n: any) => n.id === 'not-a-bill-banner').name).toBe('Not a bill (banner)'); // came in

  /* ---- the base shows its family */
  await open(page, base.projectId, 'overview');
  await expect(page.getByTestId('variant-family').locator(`[data-project="${variantId}"]`)).toBeVisible();

  /* ---- detach, with a confirmation; saved, it is an ordinary document */
  await open(page, variantId, 'overview');
  await page.getByTestId('variant-detach').click();
  await page.getByTestId('variant-detach-confirm').click();
  await expect(page.getByTestId('variant-panel')).toHaveCount(0);
  await expect(page.getByTestId('new-variant')).toBeVisible();
  await saved(page);
  const detached = (await (await request.get(`${API}/projects/${variantId}`)).json()).project;
  expect(detached.variantOf).toBeUndefined();
  // the base can now be deleted (it has no variants left)
  expect((await request.delete(`${API}/projects/${base.projectId}`)).ok()).toBeTruthy();
  await request.delete(`${API}/projects/${variantId}`);
});

test('VR02 the seeded Lakeshore example: under Northwind in the gallery, an update with entries in each group, a family on Releases', async ({ page, request }) => {
  await request.post(`${API}/projects/northwind-energy-lakeshore/reset`, { data: { confirm: true } });
  await page.goto('/projects');
  const card = page.getByTestId('project-card-northwind-energy-lakeshore');
  await expect(card.getByTestId('variant-chip-northwind-energy-lakeshore')).toContainText('Variant of Northwind Energy bill');
  // it sits right after its base
  const ids = await page.locator('[data-testid^="project-card-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(ids.indexOf('project-card-northwind-energy-lakeshore')).toBe(ids.indexOf('project-card-northwind-energy-demo') + 1);
  await open(page, 'northwind-energy-lakeshore', 'overview');
  await expect(page.getByTestId('variant-update-in-count')).not.toHaveText('0');
  await expect(page.getByTestId('variant-update-kept-count')).not.toHaveText('0');
  await expect(page.getByTestId('variant-update-comes-in').locator('[data-id="rules[R02]"]')).toBeVisible();
  await expect(page.getByTestId('variant-update-kept').locator('[data-id="contentParts[pay-standard].approvedLocales.en-US"]')).toBeVisible();
  await expect(page.getByTestId('variant-differences').locator('[data-id="rules[R05]"]')).toBeVisible();
  await open(page, 'northwind-energy-demo', 'releases');
  await expect(page.getByTestId('variant-family').locator('[data-project="northwind-energy-lakeshore"]')).toContainText('Behind');
});
