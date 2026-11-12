// Search box typing regression; reads the built-in demo project only.
// The input is URL-backed. Fast typing must keep every keystroke, even when
// useSearchParams reflects each history update a render late, and Back/Forward
// and Clear all must still replace what the box shows.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.BEADSCOPE_TEST_URL;
assert.ok(base, 'Set BEADSCOPE_TEST_URL to an isolated demo server');
const browser = await chromium.launch();
try {
 const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
 page.setDefaultTimeout(8000);
 const errors = [];
 page.on('pageerror', e => errors.push(e.message));
 const input = page.locator('input[data-search]');
 const query = () => new URL(page.url()).searchParams.get('q');
 for (const view of ['board', 'list']) {
  await page.goto(`${base}/p/demo?view=${view}`);
  await page.locator('main [data-keyboard-bead-id]').first().waitFor();
  for (let round = 0; round < 3; round++) {
   await input.fill(''); await input.click();
   await page.keyboard.type('hello world');
   assert.equal(await input.inputValue(), 'hello world', `${view}: fast typing keeps every keystroke (round ${round + 1})`);
   await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'hello world');
  }
  await input.fill(''); await page.waitForFunction(() => !new URL(location.href).searchParams.get('q'));
  // The focused box widens over the facet buttons, so leave it first.
  await input.blur();
  await page.getByRole('button', { name: /^Status/ }).click();
  await page.getByRole('menuitemcheckbox').first().click();
  await page.keyboard.press('Escape');
  await input.click(); await page.keyboard.type('abc');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'abc');
  await page.goBack();
  await page.waitForFunction(() => !new URL(location.href).searchParams.get('q'));
  assert.equal(await input.inputValue(), '', `${view}: Back clears the typed search`);
  await page.goForward();
  await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'abc');
  assert.equal(await input.inputValue(), 'abc', `${view}: Forward restores it`);
  await page.getByTitle('Clear all filters', { exact: true }).click();
  await page.waitForFunction(() => !new URL(location.href).searchParams.get('q'));
  assert.equal(await input.inputValue(), '', `${view}: Clear all empties the box`);
  assert.equal(query(), null);
 }
 assert.deepEqual(errors, []);
 console.log('PASS: fast search typing keeps every keystroke on Board and List; Back, Forward and Clear all still drive the box');
} finally { await browser.close(); }
