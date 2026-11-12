/** Run only after app exists: pnpm exec playwright test tests/e2e/screen_routes.spec.ts
 * Do not count static UX Atlas as product implementation.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
const routes=JSON.parse(fs.readFileSync(path.join(process.cwd(),'contracts/SCREEN_CONTRACT.json'),'utf8')).screens;
for (const screen of routes) {
  test(`screen ${screen.id}: ${screen.title}`, async ({page}) => {
    const url = screen.route.replace(':project','aster-card-demo').replace(':nodeId','payment-guidance');
    await page.goto(`http://127.0.0.1:5173${url}`);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByTestId(screen.requiredTestIds[0])).toBeVisible();
    await expect(page.getByRole('heading',{name:screen.title,exact:false})).toBeVisible();
  });
}
