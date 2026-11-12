import { chromium, type Browser } from 'playwright';
import { EXTRACTOR_JS, type ExtractedManifest, type PageMetrics } from '@iss/renderers';

export interface PagedComposition {
  metrics: PageMetrics & { engine: string; durationMs: number; pdfPageCount?: number };
  extracted: ExtractedManifest;
  pdf?: Buffer;
  snapshot?: { css: string; pages: string[] };
}

/** Counts page objects in PDF bytes (independent of the composer's own page tree). */
export function countPdfPages(pdf: Buffer): number {
  const s = pdf.toString('latin1');
  return (s.match(/\/Type\s*\/Page(?!s)\b/g) ?? []).length;
}

export class Composer {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) this.launching = chromium.launch({ args: ['--font-render-hinting=none'] }).then((b) => { this.browser = b; this.launching = null; return b; });
    return this.launching;
  }

  /** Serialises jobs: deterministic, bounded resource use for the POC composition worker. */
  private run<T>(job: () => Promise<T>): Promise<T> {
    const p = this.queue.then(job, job);
    this.queue = p.catch(() => undefined);
    return p;
  }

  composePaged(html: string, opts: { pdf?: boolean; snapshot?: boolean } = {}): Promise<PagedComposition> {
    return this.run(async () => {
      const browser = await this.getBrowser();
      const context = await browser.newContext({ viewport: { width: 900, height: 1200 }, javaScriptEnabled: true, offline: true });
      try {
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
        await page.waitForFunction(() => document.documentElement.getAttribute('data-composed'), null, { timeout: 60000 });
        const metrics = await page.evaluate(() => (window as any).__ISS_COMPOSITION__);
        if (metrics?.error) throw new Error('Composer script failed: ' + metrics.error);
        const extracted = (await page.evaluate(EXTRACTOR_JS)) as ExtractedManifest;
        let snapshot: PagedComposition['snapshot'];
        if (opts.snapshot) snapshot = await page.evaluate(() => ({ css: Array.from(document.querySelectorAll('style')).map((s) => s.textContent).join('\n'), pages: Array.from(document.querySelectorAll('.page')).map((p) => p.outerHTML) }));
        let pdf: Buffer | undefined;
        if (opts.pdf) {
          await page.emulateMedia({ media: 'print' });
          pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true, outline: false });
          metrics.pdfPageCount = countPdfPages(pdf);
        }
        return { metrics, extracted, pdf, snapshot };
      } finally {
        await context.close();
      }
    });
  }

  /** Loads exported interactive HTML in a real browser to extract its manifest and smoke-test interactions. */
  inspectHtml(html: string): Promise<{ extracted: ExtractedManifest; interactive: { sortable: boolean; filterable: boolean; expandable: boolean; ready: boolean } }> {
    return this.run(async () => {
      const browser = await this.getBrowser();
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, offline: true });
      try {
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'load' });
        const ready = await page.waitForFunction(() => document.documentElement.getAttribute('data-interactive-ready') === '1', null, { timeout: 15000 }).then(() => true, () => false);
        const extracted = (await page.evaluate(EXTRACTOR_JS)) as ExtractedManifest;
        const interactive = await page.evaluate(() => ({ sortable: !!document.querySelector('button.iss-sort'), filterable: !!document.querySelector('[data-table-filter]'), expandable: !!document.querySelector('details.iss-expl') }));
        return { extracted, interactive: { ...interactive, ready } };
      } finally {
        await context.close();
      }
    });
  }

  async close() { await this.browser?.close(); this.browser = null; }
}
