import { createHash } from 'node:crypto';
import { mappablePaths, projectFields, type Project, type SyntheticRecord } from '@iss/model';
import { RECORDS, sampleProjects, seedProjects } from '../../../model/src/fixtures';
import { EXTRA_SAMPLES } from '@iss/model/samples/index';
import { resolve } from '@iss/resolver';
import { baselineCustomer, dataDictionary, planTestData } from '@iss/scenarios';
import { inputSchemaFromDictionary } from '@iss/runtime';
import { renderEmail, renderInteractiveHtml, renderPagedDocument, renderSms } from '../../src';

/**
 * Fingerprints of everything the four examples (and the seed projects) produce: the resolution, the paged page source,
 * the web page, the email, the SMS, the data dictionary, the runnable package's input contract, the mapping paths and
 * the generated test customers. Captured before the richer data shapes were added (`fixtures/shapes-baseline.json`)
 * and compared after: a document without the new shapes must give byte-identical output.
 */
const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 24);

function documents(): Array<{ key: string; project: Project; records: SyntheticRecord[] }> {
  const card = RECORDS.filter((r) => r.documentType === 'credit-statement').slice(0, 6);
  const eob = RECORDS.filter((r) => r.documentType === 'eob').slice(0, 6);
  const pick = (p: Project) => (p.documentType === 'eob' ? eob : card);
  return [
    ...seedProjects().map((p) => ({ key: `seed:${p.projectId}`, project: p, records: pick(p) })),
    ...sampleProjects().map((p) => ({ key: `sample:${p.projectId}`, project: p, records: pick(p) })),
    ...EXTRA_SAMPLES().map((s) => ({ key: `example:${s.project.projectId}`, project: s.project, records: s.customers.slice(0, 6) as SyntheticRecord[] })),
  ];
}

export function examplesFingerprint(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, project, records } of documents()) {
    out[`${key}|fields`] = sha(projectFields(project));
    out[`${key}|mapping`] = sha([...mappablePaths(project)]);
    const dict = dataDictionary(project);
    out[`${key}|dictionary`] = sha(dict);
    out[`${key}|contract`] = sha(inputSchemaFromDictionary(dict as never, { releaseId: 'r1', title: project.title, languages: ['en-US'] }));
    if (project.documentType === 'custom') out[`${key}|baseline`] = sha(baselineCustomer(project));
    out[`${key}|plan`] = sha(planTestData(project, records, { max: 6 } as never).customers.map((c) => [c.label, c.record]));
    for (const record of records) {
      const res = resolve({ project, record });
      const k = `${key}|${record.recordId}`;
      out[`${k}|resolution`] = sha({ ...res, trace: res.trace, root: res.root });
      out[`${k}|paged`] = sha(renderPagedDocument(res, project));
      out[`${k}|html`] = sha(renderInteractiveHtml(res, project));
      out[`${k}|email`] = sha(renderEmail(res, project));
      out[`${k}|sms`] = sha(renderSms(res, project));
    }
  }
  return out;
}
