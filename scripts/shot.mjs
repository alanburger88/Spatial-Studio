import { chromium } from 'playwright';
const [,, url, out, w='1440', h='900'] = process.argv;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
await p.goto(url, { waitUntil: 'networkidle' }); await p.waitForTimeout(800);
await p.screenshot({ path: out }); console.log('errors:', JSON.stringify(errs).slice(0,800)); await b.close();
