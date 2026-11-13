import type { Page } from '@playwright/test';

/**
 * Open a studio screen by its screen id (S09, S16, …) the way a person does: from the left menu open the section, then
 * click the screen's tab. Does nothing extra when the tab is already showing.
 */
const SECTION_OF: Record<string, string> = {
  S02: 'design', S13: 'design', S15: 'design',
  S07: 'rules-data', S16: 'rules-data', S08: 'rules-data',
  S03: 'explore', S04: 'explore', S05: 'explore', S06: 'explore',
  S17: 'check', S09: 'check', S10: 'check',
  S18: 'releases', S20: 'releases', S21: 'releases',
  S11: 'help', S12: 'help', S14: 'help',
};
export async function gotoScreen(page: Page, screenId: string) {
  const tab = page.getByTestId(`nav-${screenId}`);
  if (!(await tab.isVisible())) {
    const section = SECTION_OF[screenId];
    if (section) await page.getByTestId(`nav-section-${section}`).click();
  }
  if (await tab.getAttribute('aria-current') !== 'page') await tab.click();
}
