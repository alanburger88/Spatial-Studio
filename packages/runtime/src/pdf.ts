import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * PDF composition for the runnable package: the same headless-browser steps as the studio's composer
 * (apps/api/src/composer.ts), loaded only when a PDF is asked for. Everything else in the package runs on Node alone.
 *
 * The page composer (playwright-core) is looked for next to the engine first (the package carries a pinned copy),
 * then from the working folder. The browser is CHROMIUM_PATH when set, otherwise the one the Playwright install
 * provides. Pages are opened offline: a document never loads anything from the network.
 */

export class RuntimeProblem extends Error {
  constructor(message: string, readonly code: 'NO_COMPOSER' | 'NO_BROWSER' | 'COMPOSITION_FAILED') { super(message); }
}

const BROWSER_HELP = 'PDF needs a headless Chromium. Either set CHROMIUM_PATH to a Chromium or Chrome executable, or install the browser this package was built with: node engine/node_modules/playwright-core/cli.js install chromium (this downloads it once, from the internet). Or use the container definition in image/. Email, SMS and interactive HTML do not need a browser.';

interface PwPage {
  setContent(html: string, o: object): Promise<void>;
  waitForFunction(fn: () => unknown, arg: unknown, o: object): Promise<unknown>;
  evaluate<T>(fn: ((arg: any) => T) | string, arg?: unknown): Promise<T>;
  emulateMedia(o: object): Promise<void>;
  pdf(o: object): Promise<Buffer>;
}
interface PwContext { newPage(): Promise<PwPage>; close(): Promise<void> }
interface PwBrowser { newContext(o: object): Promise<PwContext>; close(): Promise<void>; isConnected(): boolean; version(): string }
interface PwChromium { launch(o: object): Promise<PwBrowser>; executablePath(): string }

/** Finds playwright-core (or playwright) without importing it until a PDF is needed. */
export function loadComposer(engineDir: string): { chromium: PwChromium; version: string; from: string } {
  const places = [path.join(engineDir, 'x.js'), path.join(process.cwd(), 'x.js')];
  for (const place of places) {
    const req = createRequire(place);
    for (const name of ['playwright-core', 'playwright']) {
      try {
        const mod = req(name) as { chromium: PwChromium };
        let version = 'unknown';
        try { version = (req(`${name}/package.json`) as { version: string }).version; } catch { /* not exported */ }
        return { chromium: mod.chromium, version, from: name };
      } catch { /* try the next place */ }
    }
  }
  throw new RuntimeProblem(`The page composer (playwright-core) was not found next to the engine or in the working folder. ${BROWSER_HELP}`, 'NO_COMPOSER');
}

export interface ComposedPdf { pdf: Buffer; pages: number }

/** A headless browser composing PDFs, several pages at a time. */
export class PdfComposer {
  private active = 0;
  private waiting: Array<() => void> = [];
  private constructor(private browser: PwBrowser, readonly parallel: number, readonly composerVersion: string, readonly browserVersion: string) {}

  static async open(engineDir: string, parallel: number): Promise<PdfComposer> {
    const { chromium, version } = loadComposer(engineDir);
    const exe = process.env.CHROMIUM_PATH?.trim();
    if (exe && !existsSync(exe)) throw new RuntimeProblem(`CHROMIUM_PATH is set, but there is no browser at that path. ${BROWSER_HELP}`, 'NO_BROWSER');
    let browser: PwBrowser;
    try {
      browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--font-render-hinting=none'] });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/Executable doesn't exist|executable.*not found|ENOENT|install/i.test(msg)) throw new RuntimeProblem(`No headless browser was found. ${BROWSER_HELP}`, 'NO_BROWSER');
      throw new RuntimeProblem(`The headless browser could not be started (${msg.split('\n')[0].slice(0, 200)}). ${BROWSER_HELP}`, 'NO_BROWSER');
    }
    return new PdfComposer(browser, Math.max(1, Math.floor(parallel)), version, browser.version());
  }

  private async slot<T>(job: () => Promise<T>): Promise<T> {
    while (this.active >= this.parallel) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try { return await job(); } finally { this.active--; this.waiting.shift()?.(); }
  }

  /** The studio's steps: load the page offline, wait for the page script to lay it out, print it. */
  compose(html: string): Promise<ComposedPdf> {
    return this.slot(async () => {
      const context = await this.browser.newContext({ viewport: { width: 900, height: 1200 }, javaScriptEnabled: true, offline: true });
      try {
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
        await page.waitForFunction(() => document.documentElement.getAttribute('data-composed'), null, { timeout: 60000 });
        const metrics = await page.evaluate(() => (window as unknown as { __ISS_COMPOSITION__?: { error?: string; pageCount: number } }).__ISS_COMPOSITION__);
        if (!metrics || metrics.error) throw new RuntimeProblem(`The page script could not lay out the document${metrics?.error ? `: ${String(metrics.error).slice(0, 200)}` : '.'}`, 'COMPOSITION_FAILED');
        await page.emulateMedia({ media: 'print' });
        const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true, outline: false });
        return { pdf: Buffer.from(pdf), pages: metrics.pageCount };
      } finally {
        await context.close();
      }
    });
  }

  /**
   * Which of these font families the browser cannot find. A family is present when text set in it measures
   * differently from at least one of the generic fallbacks (a missing family falls back to each of them exactly).
   */
  async missingFonts(families: string[]): Promise<string[]> {
    if (!families.length) return [];
    return this.slot(async () => {
      const context = await this.browser.newContext({ offline: true });
      try {
        const page = await context.newPage();
        await page.setContent('<!doctype html><html><body></body></html>', { waitUntil: 'load' });
        return await page.evaluate((names: string[]) => {
          const probe = 'mmmmmmmmmmlli1WWW@#0OQ';
          const width = (family: string) => {
            const s = document.createElement('span');
            s.style.cssText = `font-size:72px;position:absolute;white-space:nowrap;font-family:${family}`;
            s.textContent = probe;
            document.body.appendChild(s);
            const w = s.getBoundingClientRect().width;
            s.remove();
            return w;
          };
          const generics = ['monospace', 'serif', 'sans-serif'];
          const base = generics.map(width);
          return names.filter((n) => generics.every((g, i) => width(`"${n.replace(/"/g, '')}", ${g}`) === base[i]));
        }, families);
      } finally {
        await context.close();
      }
    });
  }

  async close(): Promise<void> { await this.browser.close().catch(() => undefined); }
}

/** "LiberationSans-Bold" → "Liberation Sans"; "ArialMT" → "Arial". The family a PDF's embedded font name belongs to. */
export function familyOfPdfFont(name: string): string {
  const base = name.replace(/^[A-Z]{6}\+/, '').split('-')[0].replace(/(PS)?MT$/, '');
  return base.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

/** The families named in a CSS font stack, without the generic ones. */
export function stackFamilies(stack: string): string[] {
  const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);
  return stack.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter((s) => s && !generic.has(s.toLowerCase()));
}

/**
 * The fonts PDF composition needs. When the studio's reference PDFs show which family of the stack it actually used,
 * that family is required (the PDF then comes out as it did in the studio); otherwise any one family of the stack is.
 */
export function requiredPdfFonts(fonts: { fonts?: Array<{ use: string; stack: string }>; referencePdfFonts?: string[] } | null): { allOf: string[]; oneOf: string[] } {
  const stack = fonts?.fonts?.find((f) => /pdf/i.test(f.use))?.stack ?? '';
  const named = stackFamilies(stack);
  const used = [...new Set((fonts?.referencePdfFonts ?? []).map(familyOfPdfFont))].filter((f) => named.some((n) => n.toLowerCase() === f.toLowerCase()));
  return used.length ? { allOf: used, oneOf: [] } : { allOf: [], oneOf: named };
}
