/**
 * The left menu can be collapsed to a strip of icons to give the work area more room, and expanded again.
 * The choice is remembered on the device and applies on every screen.
 */
import { test, expect, type Page } from '@playwright/test';
import { open } from './helpers';

const navWidth = (page: Page) => page.locator('#studio-nav').evaluate((el) => Math.round(el.getBoundingClientRect().width));
const mainWidth = (page: Page) => page.locator('#main').evaluate((el) => Math.round(el.getBoundingClientRect().width));

test('N01 the left menu collapses to icons and expands again; the choice is remembered and the work area gets the room', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await open(page, 'aster-card-demo', 'design');
  const toggle = page.getByTestId('nav-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toContainText('Collapse menu');
  await expect(page.getByTestId('nav-S02').locator('span')).toBeVisible();
  const wideNav = await navWidth(page);
  const wideMain = await mainWidth(page);
  expect(wideNav).toBeGreaterThan(180);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('nav-S02').locator('span')).toBeHidden();
  await expect.poll(() => navWidth(page)).toBe(64);
  expect(await mainWidth(page)).toBe(wideMain + (wideNav - 64));
  // every item keeps its name for hover and for screen readers, and still navigates
  await expect(page.getByTestId('nav-S09')).toHaveAttribute('title', /Validate & Compare/);
  await page.getByTestId('nav-S09').click();
  await expect(page).toHaveURL(/\/validate/);
  await expect.poll(() => navWidth(page)).toBe(64);

  // remembered after a reload, and on the gallery too
  await page.reload();
  await expect(page.getByTestId('nav-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.goto('/projects');
  await expect.poll(() => navWidth(page)).toBe(64);

  // keyboard: the toggle is a real button
  await page.getByTestId('nav-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('nav-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => navWidth(page)).toBe(wideNav);
});

test('N02 in a narrow window the menu is already an icon strip, so no toggle is offered', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page, 'aster-card-demo', 'design');
  await expect.poll(() => navWidth(page)).toBe(64);
  await expect(page.getByTestId('nav-toggle')).toBeHidden();
});
