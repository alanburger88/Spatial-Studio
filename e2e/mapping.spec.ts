/**
 * Mapping (S26, under Releases): the data dictionary, a mapping created and filled in, a target field list imported with
 * exact / likely / guess matches, checks shown and cleared, downloads, and a release that carries the complete mapping
 * and leaves an incomplete one out, saying so. Run on an isolated stack (scripts/dev-isolated.mjs).
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { API, open, resetAll } from './helpers';
import { gotoScreen } from './nav-helper';

let pid = '';
test.beforeEach(async ({ request }) => {
  await resetAll(request);
  const r = await request.post(`${API}/projects/harborcare-demo/duplicate`, { data: { title: `Mapping E2E ${Date.now().toString(36)}` } });
  expect(r.ok()).toBeTruthy();
  pid = (await r.json()).project.projectId;
});
test.afterEach(async ({ request }) => { if (pid) await request.delete(`${API}/projects/${pid}`); });

const mappings = (page: Page) => page.evaluate(() => (window as any).__iss.store.getState().project.mappings ?? []);

async function addMapping(page: Page, system: string) {
  await page.getByTestId((await page.getByTestId('map-empty-add').count()) ? 'map-empty-add' : 'map-add').click();
  await page.getByTestId('map-system-input').fill(system);
  await page.getByTestId('map-details-save').click();
  await expect(page.getByTestId('map-name')).toHaveText(`Mapping for ${system}`);
}

/** Types a target name into every row that still needs a decision (the "Not mapped" view empties as it goes). */
async function mapTheRest(page: Page) {
  await page.getByTestId('map-filter-open').click();
  for (let i = 0; i < 60; i++) {
    const rows = page.getByTestId('map-row');
    if (!(await rows.count())) break;
    const row = rows.first();
    const path = await row.getAttribute('data-path');
    await row.getByTestId('map-target-input').fill(`TGT_${i}_${(path ?? '').replace(/\W+/g, '_').toUpperCase()}`.slice(0, 100));
    await row.getByTestId('map-target-input').press('Enter');
    await expect(page.locator(`[data-testid="map-row"][data-path="${path}"]`)).toHaveCount(0);
  }
  await page.getByTestId('map-filter-all').click();
}

async function approve(request: APIRequestContext) {
  expect((await request.post(`${API}/projects/${pid}/workflow`, { data: { action: 'submit' } })).ok()).toBeTruthy();
  const r = await request.post(`${API}/projects/${pid}/workflow`, { data: { action: 'approve' } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}

test('MP01 the data dictionary, a mapping with an imported target list, checks shown and cleared, and downloads', async ({ page }) => {
  await open(page, pid, 'overview');
  await gotoScreen(page, 'S26');
  await expect(page).toHaveURL(/\/mapping/);
  await expect(page.getByRole('heading', { level: 1, name: 'Mapping' })).toBeVisible();
  // the dictionary: every field the document reads, with a synthetic example and where it is used
  const dict = page.getByTestId('map-dictionary');
  await expect(dict).toBeVisible();
  const billed = dict.locator('[data-testid="map-dict-row"][data-path="claim.billedCents"]');
  await expect(billed).toContainText('Billed amount');
  await expect(billed).toContainText('Amount (cents)');
  await expect(dict.locator('[data-testid="map-dict-row"][data-path="claims.count"]')).toContainText('Calculated');
  await expect(page.getByTestId('map-empty')).toContainText('No system is built in');

  await addMapping(page, 'Core Claims');
  await expect(page).toHaveURL(/\?mapping=map-mapping-for-core-claims/);
  await expect(page.getByTestId('map-complete-map-mapping-for-core-claims')).toHaveText('Not complete');
  await expect(page.getByTestId('map-unmapped').locator('[data-testid="map-finding"][data-kind="unmapped"]').first()).toBeVisible();
  await expect(page.getByTestId('map-checks')).toContainText('“Claim count” is calculated');

  // import the target's field list: exact and likely are ticked, a guess is only offered
  await page.getByTestId('map-import-open').click();
  await page.locator('.mp-paste summary').click();
  await page.getByTestId('map-import-text').fill('Field Name,Data Type,Definition,Owner\nclaim.claimId,VARCHAR(20),Claim number,Ops\nBilled Amount,VARCHAR(12),What was billed,Ops\nNetwork stat,VARCHAR(20),,Ops\nMember Number,VARCHAR(20),,Ops\n');
  await expect(page.getByTestId('map-import-columns')).toContainText('names from “Field Name”, types from “Data Type”, descriptions from “Definition”');
  await expect(page.getByTestId('map-import-columns')).toContainText('Not used: “Owner”');
  const exact = page.locator('[data-testid="map-sugg-row"][data-confidence="exact"]');
  const likely = page.locator('[data-testid="map-sugg-row"][data-confidence="likely"]');
  const guess = page.locator('[data-testid="map-sugg-row"][data-confidence="guess"]');
  await expect(exact.getByTestId('map-sugg-use')).toBeChecked();
  await expect(likely.first().getByTestId('map-sugg-use')).toBeChecked();
  await expect(guess.first()).toContainText('A guess');
  await expect(guess.first().getByTestId('map-sugg-use')).not.toBeChecked();
  await page.getByTestId('map-import-apply').click();
  const m1 = (await mappings(page))[0];
  expect(m1.targetFields).toHaveLength(4);
  expect(m1.entries.map((e: any) => e.target)).not.toContain("Network stat"); // the guess was not applied
  expect(m1.entries.find((e: any) => e.path === 'claim.claimId')?.target).toBe('claim.claimId');

  // "Billed Amount" is text in the target: a type clash, shown with a link to the row; fixing the type clears it
  const clash = page.getByTestId('map-checks').locator('[data-testid="map-finding"][data-kind="type-clash"]');
  await expect(clash).toContainText('An amount in whole cents is mapped to a text field');
  await clash.getByTestId('map-goto').click();
  const billedRow = page.locator('[data-testid="map-row"][data-path="claim.billedCents"]');
  await expect(billedRow.getByTestId('map-target-input')).toBeFocused();
  await expect(billedRow.getByTestId('map-clash')).toBeVisible();
  await billedRow.getByTestId('map-type-input').fill('BIGINT');
  await billedRow.getByTestId('map-type-input').press('Enter');
  await expect(clash).toHaveCount(0);
  await expect(billedRow.getByTestId('map-type-read')).toContainText('read as whole number');

  // one field marked not needed, with a reason; the rest typed in: the mapping becomes complete
  const member = page.locator('[data-testid="map-row"][data-path="member.planName"]');
  await member.getByTestId('map-notneeded').check();
  await member.getByTestId('map-reason-input').fill('The target prints the plan from its own records');
  await member.getByTestId('map-reason-input').press('Enter');
  await expect(member.getByTestId('map-status')).toHaveText('Not needed');
  await mapTheRest(page);
  await expect(page.getByTestId('map-complete-map-mapping-for-core-claims')).toHaveText('Complete');
  await expect(page.getByTestId('map-checks')).toHaveAttribute('data-complete', 'yes');
  // undo takes one decision back
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('map-complete-map-mapping-for-core-claims')).toHaveText('Not complete');
  await page.keyboard.press('Control+y');
  await expect(page.getByTestId('map-complete-map-mapping-for-core-claims')).toHaveText('Complete');

  // downloads: JSON for an adapter, CSV for people
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('map-download-json').click()]);
  const file = JSON.parse(readFileSync((await dl.path())!, 'utf8'));
  expect(file).toMatchObject({ formatVersion: 1, complete: true, mapping: { system: 'Core Claims' } });
  expect(file.fields.find((f: any) => f.path === 'member.planName').notNeeded.reason).toBe('The target prints the plan from its own records');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByTestId('map-download-csv').click()]);
  expect(readFileSync((await dl2.path())!, 'utf8')).toContain('path,label,type,calculated,required,status,target');

  // the deep link opens the mapping (in-app navigation: the mapping is not saved yet)
  const goTo = (u: string) => page.evaluate((x) => { window.history.pushState({}, '', x); window.dispatchEvent(new PopStateEvent('popstate')); }, u);
  await goTo(`/studio/${pid}/mapping?mapping=dictionary`);
  await expect(page.getByTestId('map-dictionary')).toBeVisible();
  await goTo(`/studio/${pid}/mapping?mapping=map-mapping-for-core-claims`);
  await expect(page.getByTestId('map-detail')).toHaveAttribute('data-id', 'map-mapping-for-core-claims');
});

test('MP02 a release carries the complete mapping and leaves the incomplete one out, and says so', async ({ page, request }) => {
  await open(page, pid, 'mapping');
  await addMapping(page, 'Core Claims');
  await mapTheRest(page);
  await expect(page.getByTestId('map-complete-map-mapping-for-core-claims')).toHaveText('Complete');
  await addMapping(page, 'Print House');
  await expect(page.getByTestId('map-complete-map-mapping-for-print-house')).toHaveText('Not complete');
  await page.getByTestId('save-project').click();
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  const made = await approve(request);
  const n = made.release.release.number;

  await open(page, pid, 'releases');
  await page.getByTestId(`rel-row-${n}`).click();
  const section = page.getByTestId('rel-mappings');
  await expect(section.locator('[data-testid="rel-mapping"][data-complete="yes"]')).toContainText('Mapping for Core Claims');
  await expect(section.locator('[data-testid="rel-mapping"][data-complete="yes"]')).toContainText('In the package');
  await expect(section.locator('[data-testid="rel-mapping"][data-complete="no"]')).toContainText('Left out');

  const files = (await (await request.get(`${API}/releases/${pid}-r${n}/package?wait=1`)).body());
  expect(files.length).toBeGreaterThan(1000);
  const listed = (await (await request.get(`${API}/releases/${pid}-r${n}/package/files`)).json()).files.map((f: any) => f.path);
  expect(listed).toContain('data/mapping-mapping-for-core-claims.json');
  expect(listed).toContain('data/mapping-mapping-for-core-claims.csv');
  expect(listed.some((p: string) => p.includes('print-house'))).toBe(false);
  const readme = await (await request.get(`${API}/releases/${pid}-r${n}/package/files/README.html`)).text();
  expect(readme).toContain('Mappings to production systems');
  expect(readme).toContain('One mapping was not complete when the release was made, so it is not in this package.');
  const mapping = await (await request.get(`${API}/releases/${pid}-r${n}/package/files/data/mapping-mapping-for-core-claims.json`)).json();
  expect(mapping.complete).toBe(true);
});
