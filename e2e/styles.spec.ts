import { test, expect } from '@playwright/test';
import { API } from './helpers';
import { gotoScreen } from './nav-helper';

test('A4: new project from the Blank letter template, text style applied on the canvas, brand reaches exported HTML', async ({ page, request }) => {
  await page.goto('/projects');
  await expect(page.getByTestId('project-gallery')).toBeVisible();
  await page.getByTestId('new-project').click();
  await page.getByTestId('template-blank-letter').click();
  await expect(page.getByTestId('template-credit-card-statement')).toBeVisible();
  await expect(page.getByTestId('template-explanation-of-benefits')).toBeVisible();
  await page.getByTestId('new-project-title').fill('Styles e2e letter');
  await page.getByTestId('create-project').click();

  await page.waitForURL(/\/studio\/[^/]+\/overview/);
  await gotoScreen(page, 'S02');
  const projectId = page.url().split('/studio/')[1].split('/')[0];
  try {
    await page.waitForFunction(() => (window as any).__iss?.store.getState().projectStatus === 'ready');
    const created = await page.evaluate(() => (window as any).__iss.store.getState().project);
    expect(created.modelVersion).toBe(1);
    expect(created.nodes.map((n: any) => n.id)).toContain('letter-body');

    // Create a style.
    await page.getByTestId('open-styles').click();
    await page.getByTestId('style-new').click();
    await page.getByTestId('style-name').fill('Lead paragraph');
    await page.getByTestId('style-size').fill('18');
    await page.getByTestId('style-weight').selectOption('700');
    await page.getByTestId('style-color').fill('#1D5941');
    await page.getByTestId('styles-apply').click();
    await expect(page.getByTestId('styles-message')).toContainText('Styles saved');
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    // Apply it to the body text and check the computed style in the design canvas.
    await page.getByTestId('design-canvas').getByTestId('node-letter-body').click();
    await page.getByTestId('text-style-select').selectOption({ label: 'Lead paragraph (paragraph)' });
    const rich = page.getByTestId('design-canvas').getByTestId('node-letter-body').locator('.iss-rich');
    await expect(rich).toHaveCSS('font-size', '24px');
    await expect(rich).toHaveCSS('font-weight', '700');
    await expect(rich).toHaveCSS('color', 'rgb(29, 89, 65)');

    // Deleting a style in use is blocked with the command's message.
    await page.getByTestId('open-styles').click();
    await page.getByTestId('style-delete').click();
    await expect(page.getByTestId('styles-message')).toContainText('still used');
    await expect(page.getByTestId('style-item-paragraph-style')).toBeVisible();

    // Brand kit.
    await page.getByTestId('sb-tab-brand').click();
    await page.getByTestId('brand-primary').fill('#123456');
    await page.getByTestId('brand-apply').click();
    await expect(page.getByTestId('brand-message')).toContainText('Brand kit applied');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByTestId('inspector-tab-comments')).toBeVisible();

    // The exported interactive HTML carries both.
    const project = await page.evaluate(() => (window as any).__iss.store.getState().project);
    const r = await request.post(`${API}/compose/html`, { data: { projectId, recordId: 'CARD-0001', project, allowDraft: true } });
    expect(r.ok()).toBeTruthy();
    const html = await r.text();
    expect(html).toContain('--iss-brand-primary:#123456');
    expect(html).toContain('iss-st-paragraph-style');
    expect(html).toContain("default-src 'none'");
  } finally {
    await request.delete(`${API}/projects/${projectId}`);
  }
});
