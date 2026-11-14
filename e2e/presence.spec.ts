import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API, open } from './helpers';

/**
 * Who else is editing (wave 4, item 4). Two browser windows on one document: each sees the other in the top bar, the
 * Inspector warns when both are on the same component, a hidden or departed window drops out, and when both save the
 * second is told who saved first and when, with the choice to load their version or keep editing and compare. With
 * sign-in off both windows are the local admin, shown as "another window". The top bar keeps every control apart at
 * 1000 and 1280 px, alone and with another window present.
 *
 * With sign-in on (a stack started with AUTH=on, ADMIN_EMAIL and ADMIN_PASSWORD; E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD if
 * they differ from the defaults below) two people are named.
 */

const ADMIN = { email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.test', password: process.env.E2E_ADMIN_PASSWORD ?? 'correct horse battery' };
let authOn = false;
test.beforeAll(async ({ request }) => { authOn = !!(await (await request.get(`${API}/session`)).json()).authEnabled; });

/** A presence report comes at once on opening, then every 15 seconds or 1.2 s after a change: allow one full interval. */
const SOON = { timeout: 25_000 };
const select = (page: Page, nodeId: string | null) => page.evaluate((id) => (window as any).__iss.store.getState().select(id), nodeId);
const edit = (page: Page, name: string) => page.evaluate((n) => (window as any).__iss.store.getState().dispatch({ type: 'UPDATE_NODE', nodeId: 'payment-guidance', patch: { name: n } }), name);

/** No two top-bar controls' boxes may intersect, and none may run off the window. */
async function topBarProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sel = ['.brand', '.badge-synthetic', '.crumb-select', '.presence-btn', '[data-testid=record-selector]', '[data-testid=select-language]', '[data-testid=select-profile]', '[data-testid=undo]', '[data-testid=redo]', '[data-testid=save-project]', '[data-testid=open-history]', '.wf-chip', '[data-testid=read-only]', '[data-testid=open-palette]', '[data-testid=bell]', '[data-testid=open-settings]', '.user-avatar-btn'];
    const boxes: Array<{ s: string; r: DOMRect }> = [];
    for (const s of sel) for (const el of document.querySelectorAll(`.topbar ${s}`)) { const r = el.getBoundingClientRect(); if (r.width && r.height) boxes.push({ s, r }); }
    const out: string[] = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r, b = boxes[j].r;
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) out.push(`${boxes[i].s} overlaps ${boxes[j].s}`);
    }
    const vw = document.documentElement.clientWidth;
    for (const b of boxes) if (b.r.right > vw + 0.5 || b.r.left < -0.5) out.push(`${b.s} runs off the window`);
    return out;
  });
}

async function twoWindows(browser: Browser, pid: string, login?: { email: string; password: string }[]): Promise<{ a: Page; b: Page; contexts: BrowserContext[] }> {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  for (let i = 0; i < 2; i++) {
    const c = await browser.newContext();
    if (login) expect((await c.request.post(`${API}/auth/login`, { data: login[i] })).ok()).toBeTruthy();
    contexts.push(c);
    const p = await c.newPage();
    await open(p, pid, 'design');
    pages.push(p);
  }
  return { a: pages[0], b: pages[1], contexts };
}

test.describe('sign-in off: two windows of the local admin', () => {
  let pid = '';
  test.beforeEach(async ({ request }) => {
    test.skip(authOn, 'this stack has sign-in on');
    const r = await request.post(`${API}/projects/aster-card-demo/duplicate`, { data: { title: `Presence E2E ${Date.now().toString(36)}` } });
    pid = (await r.json()).project.projectId;
  });
  test.afterEach(async ({ request }) => { if (pid && !authOn) await request.delete(`${API}/projects/${pid}`); });

  test('PR01 each window sees the other as another window, the Inspector warns on the same component, and a hidden or departed window drops out', async ({ browser }) => {
    const { a, b, contexts } = await twoWindows(browser, pid);
    try {
      await select(a, 'payment-guidance');
      await select(b, 'payment-guidance');
      for (const p of [a, b]) {
        await expect(p.getByTestId('presence')).toHaveAttribute('data-count', '1', SOON);
        await expect(p.getByTestId('presence-open')).toHaveAttribute('aria-label', /^Also on this document: Another window, on Design Studio/);
        await expect(p.getByTestId('inspector-also-here')).toContainText('Another window is also on this component.', SOON);
      }
      // the list names the other window and its screen
      await a.getByTestId('presence-open').click();
      await expect(a.getByTestId('presence-row')).toContainText('Another window');
      await expect(a.getByTestId('presence-row')).toContainText('On Design Studio');
      const axe = await new AxeBuilder({ page: a }).include('[data-testid="presence"]').include('[data-testid="inspector-also-here"]').analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} ${n.failureSummary}`).join(' | ')}`)).toEqual([]);
      await a.keyboard.press('Escape');
      // b moves to another component: the warning goes, the top bar stays
      await select(b, 'billing-summary');
      await expect(a.getByTestId('inspector-also-here')).toHaveCount(0, SOON);
      await expect(a.getByTestId('presence')).toHaveAttribute('data-count', '1');
      // b's tab is hidden: it leaves at once, and is listed again when it is visible
      await b.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
      await select(a, 'billing-summary'); // a reports soon after a change
      await expect(a.getByTestId('presence')).toHaveCount(0, SOON);
      // (the stand-in is removed, so the real state is read again: visible, and hidden while the page unloads below)
      await b.evaluate(() => { delete (document as any).visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
      await select(a, 'payment-guidance');
      await expect(a.getByTestId('presence')).toHaveAttribute('data-count', '1', SOON);
      // b leaves the document
      await b.goto('/projects');
      await select(a, 'billing-summary');
      await expect(a.getByTestId('presence')).toHaveCount(0, SOON);
    } finally { for (const c of contexts) await c.close(); }
  });

  test('PR02 when both save, the second is told who saved first and when, and chooses: compare, or load their version', async ({ browser, request }) => {
    const { a, b, contexts } = await twoWindows(browser, pid);
    try {
      await edit(a, 'Payment help (A)');
      await a.getByTestId('save-project').click();
      await expect(a.getByTestId('save-state')).toContainText('Saved');
      const theirs = (await (await request.get(`${API}/projects/${pid}`)).json()).project.modelVersion;
      await edit(b, 'Payment help (B)');
      await b.getByTestId('save-project').click();
      const dialog = b.getByTestId('save-conflict');
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('data-theirs', String(theirs));
      await expect(b.getByTestId('save-conflict-who')).toContainText(`Another window saved version ${theirs}`);
      await expect(b.getByTestId('save-conflict-who')).toContainText('just now');
      await expect(dialog).toContainText('Your unsaved edits here are lost.');
      // (the shared Dialog's header and footer landmarks are left out: reported to the integrator)
      const axe = await new AxeBuilder({ page: b }).include('.dialog').disableRules(['landmark-no-duplicate-banner', 'landmark-no-duplicate-contentinfo']).analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} ${n.failureSummary}`).join(' | ')}`)).toEqual([]);
      // keep editing and compare: Before & after opens on their saved version and this working version
      await b.getByTestId('save-conflict-compare').click();
      await expect(b).toHaveURL(new RegExp(`/studio/${pid}/compare\\?before=v${theirs}&after=working`));
      await expect(b.getByTestId('cmp-before')).toHaveAttribute('data-value', `v${theirs}`);
      await expect(b.getByTestId('cmp-after')).toHaveAttribute('data-value', 'working');
      await expect(b.getByTestId('save-state')).toContainText('Unsaved');
      // saving again is still refused; this time load their version
      await b.getByTestId('save-project').click();
      await expect(dialog).toBeVisible();
      await b.getByTestId('save-conflict-load').click();
      await expect(dialog).toHaveCount(0);
      await expect(b.getByTestId('save-state')).toContainText('Saved');
      expect(await b.evaluate(() => (window as any).__iss.store.getState().project.nodes.find((n: any) => n.id === 'payment-guidance').name)).toBe('Payment help (A)');
    } finally { for (const c of contexts) await c.close(); }
  });

  test('PR03 the top bar keeps every control apart at 1000 and 1280 px, alone and with another window', async ({ browser }) => {
    const c1 = await browser.newContext();
    const c2 = await browser.newContext();
    try {
      const a = await c1.newPage();
      for (const width of [1000, 1280]) {
        await a.setViewportSize({ width, height: 700 });
        await open(a, pid, 'design');
        expect(await topBarProblems(a), `alone at ${width}`).toEqual([]);
      }
      const b = await c2.newPage();
      await open(b, pid, 'overview');
      for (const width of [1000, 1280]) {
        await a.setViewportSize({ width, height: 700 });
        await open(a, pid, 'design');
        await expect(a.getByTestId('presence')).toBeVisible(SOON);
        expect(await topBarProblems(a), `with another window at ${width}`).toEqual([]);
      }
    } finally { await c1.close(); await c2.close(); }
  });
});

test.describe('sign-in on: two people', () => {
  test.skip(() => !authOn, 'needs a stack started with AUTH=on');

  test('PR04 two people are named, with the screen each is on; the Inspector names the other person', async ({ browser }) => {
    const admin = await browser.newContext();
    expect((await admin.request.post(`${API}/auth/login`, { data: ADMIN })).ok()).toBeTruthy();
    const tag = Date.now().toString(36);
    const dana = { email: `dana-${tag}@example.test`, password: 'a long enough password' };
    expect((await admin.request.post(`${API}/users`, { data: { ...dana, name: `Dana Author ${tag}`, role: 'author' } })).ok()).toBeTruthy();
    const pid = (await (await admin.request.post(`${API}/projects/aster-card-demo/duplicate`, { data: { title: `Presence people ${tag}` } })).json()).project.projectId as string;
    const { a, b, contexts } = await twoWindows(browser, pid, [ADMIN, dana]);
    try {
      await select(a, 'payment-guidance');
      await select(b, 'payment-guidance');
      await expect(a.getByTestId('inspector-also-here')).toContainText(`Dana Author ${tag} is also on this component.`, SOON);
      await expect(b.getByTestId('inspector-also-here')).toContainText('Administrator is also on this component.', SOON);
      await expect(a.getByTestId('presence-open')).toHaveAttribute('aria-label', new RegExp(`Dana Author ${tag}, on Design Studio`));
      for (const width of [1000, 1280]) {
        await a.setViewportSize({ width, height: 700 });
        await expect(a.getByTestId('presence')).toBeVisible();
        expect(await topBarProblems(a), `signed in, with another person, at ${width}`).toEqual([]);
      }
    } finally {
      for (const c of contexts) await c.close();
      await admin.request.delete(`${API}/projects/${pid}`);
      await admin.close();
    }
  });
});
