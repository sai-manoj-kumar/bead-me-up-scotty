// Captures the three README screenshots (board, detail drawer, dependency graph)
// from demo mode, at 1920x1080.
//
// Run it only against an isolated demo server, ideally with a throwaway
// XDG_CONFIG_HOME whose config.json sets a neutral humanActor, because the sidebar
// shows the actor name:
//
//   XDG_CONFIG_HOME=$(mktemp -d) BEADS_DEMO=1 beadscope start --no-open --port 3450
//   BEADSCOPE_TEST_URL=http://localhost:3450 node scripts/capture-screenshots.mjs
//
// PLAYWRIGHT_CHROMIUM_PATH points at a specific Chromium/headless-shell binary if
// Playwright's own download is not the build it expects. SCREENSHOT_DIR overrides
// the output directory (default .github/screens).
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.env.BEADSCOPE_TEST_URL;
assert.ok(base, 'Set BEADSCOPE_TEST_URL to an isolated demo server');
assert.equal((await (await fetch(`${base}/api/telemetry`)).json()).configured, false, 'telemetry must be unconfigured');
const dir = process.env.SCREENSHOT_DIR ?? '.github/screens';
const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH;

const browser = await chromium.launch(exe ? { executablePath: exe } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: 'light' });
  const shot = (name) => page.screenshot({ path: path.join(dir, name) });
  const settle = () => page.waitForTimeout(900);

  await page.goto(`${base}/p/demo`);
  await page.getByText('Backlog', { exact: true }).first().waitFor();
  await settle();
  await shot('board.png');

  await page.goto(`${base}/p/demo?bead=bd-1a09.1`);
  await page.getByText('Keyboard nav (n, /, j, k, e)').first().waitFor();
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur()); // no stray focus ring
  await settle();
  await shot('detail.png');

  await page.goto(`${base}/p/demo?view=graph`);
  await page.locator('.react-flow__node').first().waitFor();
  // Frame a readable subgraph: one epic, not all ~46 beads at fit-to-view.
  await page.locator('select').first().selectOption(process.env.GRAPH_EPIC ?? 'bd-c552');
  await page.waitForTimeout(1500);
  await shot('graph.png');
  console.log('captured board.png, detail.png, graph.png in', dir);
} finally {
  await browser.close();
}
