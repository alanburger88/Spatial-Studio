// Screenshot one URL of the running app. Usage: node scripts/shot.mjs <url> <out.png> [w] [h] [actions...]
// Env: THEME=light|dark, VIEW=business|technical, RESET=1 (restore both demo projects first)
// Actions run in order after load: click:<testid>  key:<key>  wait:<ms>
import { chromium } from 'playwright';
const [,, url, out, w = '1440', h = '900', ...acts] = process.argv;
if (process.env.RESET) for (const id of ['aster-card-demo', 'harborcare-demo']) await fetch(`${process.env.E2E_API ?? 'http://127.0.0.1:3001'}/api/v1/projects/${id}/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"confirm":true}' });
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await p.addInitScript(([t, v]) => { try { if (t) localStorage.setItem('iss.theme', t); if (v) localStorage.setItem('iss.viewMode', v); } catch {} }, [process.env.THEME ?? '', process.env.VIEW ?? '']);
await p.goto(url, { waitUntil: 'networkidle' }); await p.waitForTimeout(900);
for (const a of acts) {
  const [k, ...r] = a.split(':'); const v = r.join(':');
  if (k === 'click') await p.getByTestId(v).first().click(); else if (k === 'key') await p.keyboard.press(v); else if (k === 'wait') await p.waitForTimeout(+v);
  await p.waitForTimeout(250);
}
await p.screenshot({ path: out }); console.log('errors:', JSON.stringify(errs).slice(0, 800)); await b.close();
