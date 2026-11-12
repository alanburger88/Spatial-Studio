// Screenshot one URL of the running app. Usage: node scripts/shot.mjs <url> <out.png> [w] [h]
// Env: THEME=light|dark, VIEW=business|technical, RESET=1 (restore both demo projects first)
import { chromium } from 'playwright';
const [,, url, out, w = '1440', h = '900'] = process.argv;
if (process.env.RESET) for (const id of ['aster-card-demo', 'harborcare-demo']) await fetch(`http://127.0.0.1:3001/api/v1/projects/${id}/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"confirm":true}' });
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await p.addInitScript(([t, v]) => { try { if (t) localStorage.setItem('iss.theme', t); if (v) localStorage.setItem('iss.viewMode', v); } catch {} }, [process.env.THEME ?? '', process.env.VIEW ?? '']);
await p.goto(url, { waitUntil: 'networkidle' }); await p.waitForTimeout(900);
await p.screenshot({ path: out }); console.log('errors:', JSON.stringify(errs).slice(0, 800)); await b.close();
