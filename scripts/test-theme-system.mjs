import assert from 'node:assert/strict';
import { chromium } from 'playwright';
// System theme mode (bui-6am): default follows the OS live; toggle flips to an
// explicit opposite; the choice is stored per project and picked up before paint.
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
  const toggle = () => page.getByTitle('Toggle theme', { exact: true }).filter({ visible: true });

  // 1. Nothing stored + dark OS => dark, with no choice persisted.
  await page.goto(`${base}/p/demo?view=epics`);
  await toggle().waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await page.evaluate(() => localStorage.getItem('beadscope.theme.demo')), null);

  // 2. The OS flips while the page is open => the page follows, no reload.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await hasDark(page), false);

  // 3. Toggle from System saves the opposite of what is showing (dark), explicitly.
  await toggle().click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await page.evaluate(() => localStorage.getItem('beadscope.theme.demo')), 'dark');

  // 4. An explicit choice no longer follows the OS.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(300);
  assert.equal(await theme(page), 'dark');

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

  assert.deepEqual(errors, []);
  console.log('PASS: system theme follows OS live, toggles to explicit, themes before paint');
} finally { await browser.close(); }
