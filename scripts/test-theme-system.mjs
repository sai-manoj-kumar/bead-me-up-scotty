import assert from 'node:assert/strict';
import { chromium } from 'playwright';
// System theme mode (bui-6am): default follows the OS live; the quick switch cycles
// System -> Light -> Dark -> System; the choice is stored per project and picked up before paint.
const base = process.env.BEADSCOPE_TEST_URL;
assert.ok(base, 'Set BEADSCOPE_TEST_URL to an isolated development server');
const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme);
const hasDark = (page) => page.evaluate(() => document.documentElement.classList.contains('dark'));
try {
  const ctx = await browser.newContext({ colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  const toggle = () => page.getByRole('button', { name: /^Theme: / }).filter({ visible: true });

  // 1. Nothing stored + dark OS => dark, with no choice persisted.
  await page.goto(`${base}/p/demo?view=epics`);
  await toggle().waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await page.evaluate(() => localStorage.getItem('beadscope.theme.demo')), null);

  // 2. The OS flips while the page is open => the page follows, no reload.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await hasDark(page), false);

  // 3. The quick switch cycles System -> Light -> Dark -> System, saving each choice.
  const stored = () => page.evaluate(() => localStorage.getItem('beadscope.theme.demo'));
  assert.equal(await toggle().getAttribute('title'), 'Theme: System — click for Light');
  await toggle().click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await stored(), 'light');
  assert.equal(await toggle().getAttribute('title'), 'Theme: Light — click for Dark');
  await toggle().click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await stored(), 'dark');
  assert.equal(await toggle().getAttribute('title'), 'Theme: Dark — click for System');

  // 4. An explicit choice no longer follows the OS (the OS is light, Dark stays).
  await page.waitForTimeout(300);
  assert.equal(await theme(page), 'dark');
  // Back to System: it follows the OS again, live.
  await toggle().click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await stored(), 'system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await toggle().getAttribute('title'), 'Theme: System — click for Light');

  // 5. Choosing System again in the store resumes following the OS, and the
  //    inline head script applies it before React hydrates (no flash).
  await page.evaluate(() => localStorage.setItem('beadscope.theme.demo', 'system'));
  await ctx.close();
  const ctx2 = await browser.newContext({ colorScheme: 'dark' });
  const p2 = await ctx2.newPage();
  await p2.addInitScript(() => localStorage.setItem('beadscope.theme.demo', 'system'));
  await p2.route('**/*.js', (r) => r.abort()); // no hydration: only the inline script runs
  await p2.goto(`${base}/p/demo?view=epics`, { waitUntil: 'domcontentloaded' });
  assert.equal(await theme(p2), 'dark', 'inline script must theme the page before hydration');
  assert.equal(await hasDark(p2), true);

  // 6. A stored named palette is untouched by the OS setting.
  await p2.evaluate(() => localStorage.setItem('beadscope.theme.other', 'nord'));
  await p2.goto(`${base}/p/other`, { waitUntil: 'domcontentloaded' });
  assert.equal(await theme(p2), 'nord');

  // 7. A palette outside the cycle moves on to System.
  const p3 = await ctx2.newPage();
  await p3.addInitScript(() => localStorage.setItem('beadscope.theme.other', 'nord'));
  await p3.goto(`${base}/p/other?view=epics`);
  const nordButton = p3.getByRole('button', { name: /^Theme: / }).filter({ visible: true });
  assert.equal(await nordButton.getAttribute('title'), 'Theme: Nord — click for System');
  await nordButton.click();
  assert.equal(await p3.evaluate(() => localStorage.getItem('beadscope.theme.other')), 'system');

  assert.deepEqual(errors, []);
  console.log('PASS: system theme follows OS live, cycles System/Light/Dark, themes before paint');
} finally { await browser.close(); }
