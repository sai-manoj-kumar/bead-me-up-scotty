import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.BEADSCOPE_TEST_URL;
assert.ok(base, 'Set BEADSCOPE_TEST_URL to an isolated demo server');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', e => errors.push(e.message));
  const sidebar = page.locator('aside').first();
  const handle = page.getByRole('separator', { name: 'Resize sidebar' });
  const width = async () => Math.round((await sidebar.boundingBox()).width);
  const drag = async dx => {
    const box = await handle.boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y);
    await page.mouse.move(x + dx, y);
    await page.mouse.up();
  };

  await page.goto(`${base}/p/demo`);
  await handle.waitFor();
  assert.equal(await width(), 228, 'default width');
  await drag(72);
  assert.equal(await width(), 300, 'drag right widens');
  assert.equal(await page.evaluate(() => localStorage.getItem('beadscope.width.sidebar')), '300');
  await drag(-1000);
  assert.equal(await width(), 180, 'clamped to minimum');
  await drag(1000);
  assert.equal(await width(), 400, 'clamped to maximum');
  await drag(-100);
  await page.reload();
  await handle.waitFor();
  await page.waitForFunction(() => Math.round(document.querySelector('aside').getBoundingClientRect().width) === 300);
  assert.deepEqual(errors, [], 'saved width must hydrate without console errors');
  console.log('PASS: default 228px, drag widens and persists, min/max clamps, saved width restored after reload without hydration errors');
} finally { await browser.close(); }
