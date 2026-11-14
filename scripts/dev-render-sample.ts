/**
 * Development aid (not part of the build): composes example documents for a few customers into PDFs, page images,
 * the web page, the email and the SMS, so their layout and wording can be looked at.
 *   npx tsx scripts/dev-render-sample.ts <northwind|meridian> <outDir> [recordId…] [--es] [--date=YYYY-MM-DD]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { resolve } from '@iss/resolver';
import { renderEmail, renderInteractiveHtml, renderPagedDocument, renderSms } from '@iss/renderers';
import { EXTRA_SAMPLES } from '@iss/model/samples/index';
import { Composer } from '../apps/api/src/composer';

const [which, outDir, ...rest] = process.argv.slice(2);
const sample = EXTRA_SAMPLES().find((s) => s.project.projectId.startsWith(which));
if (!sample) throw new Error(`No sample ${which}`);
const ids = rest.filter((a) => !a.startsWith('--'));
const date = rest.find((a) => a.startsWith('--date='))?.slice(7);
mkdirSync(outDir, { recursive: true });
const composer = new Composer();
const customers = ids.length ? sample.customers.filter((c) => ids.includes(c.recordId)) : sample.customers.slice(0, 3);
for (const record of customers) {
  const res = resolve({ project: sample.project, record, profileId: 'paged-pdf', ...(date ? { issueDate: date } : {}) });
  const base = path.join(outDir, `${which}-${record.recordId}${date ? `-${date}` : ''}`);
  const html = renderPagedDocument(res, sample.project, { profileId: 'paged-pdf', watermark: '' });
  const comp = await composer.composePaged(html, { pdf: true });
  writeFileSync(`${base}.pdf`, comp.pdf!);
  execFileSync('pdftoppm', ['-r', '72', '-png', `${base}.pdf`, base]);
  const web = renderInteractiveHtml(res, sample.project);
  writeFileSync(`${base}.html`, web);
  const email = renderEmail(res, sample.project);
  writeFileSync(`${base}.email.html`, typeof email === 'string' ? email : (email as any).html ?? JSON.stringify(email));
  const sms = renderSms(res, sample.project);
  const blocking = res.findings.filter((f) => f.severity === 'blocking').map((f) => `${f.code}: ${f.message}`);
  const warnings = res.findings.filter((f) => f.severity !== 'blocking').map((f) => `${f.code}: ${f.message}`);
  console.log(JSON.stringify({ recordId: record.recordId, locale: res.locale, pages: comp.metrics.pageCount, diagnostics: (comp.metrics as any).diagnostics?.map((d: any) => `${d.code} ${d.nodeId ?? ''} ${d.message ?? ''}`), subject: res.channelTexts.subject, sms: typeof sms === 'string' ? sms : (sms as any).text ?? sms, blocking, warnings: warnings.slice(0, 8) }, null, 1));
}
await composer.close();
