// Prints every translatable text of the two sample projects as JSON: { projectId: [{ id, source }] }.
// Used when authoring the bundled sample translations. Run: pnpm exec tsx scripts/list-strings.mts
import { translationStatus } from '../packages/model/src';
import { seedProjects } from '../packages/model/src/fixtures';

const out: Record<string, Array<{ id: string; source: string }>> = {};
for (const p of seedProjects()) out[p.projectId] = translationStatus(p, 'es-US').rows.map((r) => ({ id: r.partId, source: r.sourceText }));
console.log(JSON.stringify(out, null, 1));
