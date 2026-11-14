import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base=process.env.BEADSCOPE_TEST_URL;
assert.ok(base,'Set BEADSCOPE_TEST_URL to an isolated development server');
const browser=await chromium.launch();
try {
 const page=await browser.newPage();
 const errors=[];
 // During load a second, hidden toggle can be mounted briefly; act on the visible one.
 const themeToggle=()=>page.getByRole('button',{name:/^Theme: /}).filter({visible:true});
 page.on('console',msg=>{if(msg.type()==='error') errors.push(msg.text());});
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  if(!localStorage.getItem('theme-test-seeded')) {
   localStorage.setItem('beadscope.theme.demo','dark');
   localStorage.setItem('theme-test-seeded','true');
  }
 });
 await page.goto(`${base}/p/demo?view=epics`);
 await themeToggle().waitFor();
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 await page.reload();
 await themeToggle().waitFor();
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 assert.deepEqual(errors,[], 'saved dark theme must hydrate without console errors');
 // Dark cycles to System first (headless Chromium reports a light OS), then to Light.
 await themeToggle().click();
 await page.waitForFunction(()=>localStorage.getItem('beadscope.theme.demo')==='system');
 await themeToggle().click();
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
 await page.reload();
 await themeToggle().waitFor();
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
 assert.equal(await page.evaluate(()=>localStorage.getItem('beadscope.theme.demo')),'light');
 assert.deepEqual(errors,[]);
 console.log('PASS: saved dark theme hydration, reload, toggle, and persistence');
} finally { await browser.close(); }
