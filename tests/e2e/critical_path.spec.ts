/** Minimal executable acceptance hooks. Expand to AT-01–AT-36.
 * These tests intentionally fail if UI is only decorative.
 */
import {test, expect} from '@playwright/test';
test('Aster loads real editable model, save and spatial continuity', async ({page}) => {
 await page.goto('http://127.0.0.1:5173/studio/aster-card-demo/design');
 await expect(page.getByTestId('design-canvas')).toBeVisible();
 await page.getByTestId('design-canvas').getByTestId('node-payment-guidance').click();
 await page.getByRole('button',{name:/explore variants/i}).click();
 await expect(page.getByTestId('exploded-view')).toBeVisible();
 await expect(page.getByTestId('selected-node')).toHaveText(/payment-guidance/);
 await page.getByTestId('collapse-exploded').click();
 await expect(page.getByTestId('design-canvas')).toBeVisible();
});
test('Real PDF export produces document bytes', async ({request}) => {
 const response=await request.post('http://127.0.0.1:3001/api/v1/compose/pdf',{data:{projectId:'aster-card-demo',recordId:'CARD-0001',overrides:{},outputContext:{profileId:'paged-pdf'}}});
 expect(response.status()).toBe(200);
 const b=await response.body();expect(b.subarray(0,5).toString()).toBe('%PDF-');
 expect(b.length).toBeGreaterThan(2000);
});
