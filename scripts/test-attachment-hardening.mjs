// Isolated server only. Registers a throwaway folder (with an empty .beads) in
// the server's config and serves a hostile SVG from it; no beads are touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { api } from '../lib/api-client.ts';

// Refs from bead text cannot steer the URL with dot segments.
assert.equal(api.attachments.urlFor('p', 'attachment://bd-1/shot.png'), '/api/p/p/attachments/bd-1/shot.png');
assert.equal(api.attachments.urlFor('p', 'attachment://../../config'), '/api/p/p/attachments/config');
assert.equal(api.attachments.urlFor('p', 'attachment://bd-1/./../x.png'), '/api/p/p/attachments/bd-1/x.png');
assert.equal(api.attachments.urlFor('p', 'attachment://bd-1/%2e%2e/x.png'), '/api/p/p/attachments/bd-1/%252e%252e/x.png');

const base = process.env.BEADSCOPE_TEST_URL;
assert.ok(base, 'Set BEADSCOPE_TEST_URL to an isolated app server');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beadscope-attach-'));
try {
  const files = path.join(dir, '.beads', 'attachments', 'bd-1');
  fs.mkdirSync(files, { recursive: true });
  fs.writeFileSync(path.join(files, 'evil.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>document.title="pwned";window.__pwned=1</script><rect width="10" height="10" fill="red"/></svg>');
  fs.writeFileSync(path.join(files, 'notes.txt'), '<html><script>window.__pwned=1</script></html>');

  const added = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) });
  const addedBody = await added.text();
  assert.equal(added.status, 201, addedBody);
  const { id } = JSON.parse(addedBody);
  const svgUrl = `${base}${api.attachments.urlFor(id, 'attachment://bd-1/evil.svg')}`;

  for (const file of ['evil.svg', 'notes.txt']) {
    const res = await fetch(`${base}/api/p/${id}/attachments/bd-1/${file}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') ?? '', /\bsandbox\b/, `${file}: CSP sandbox`);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${file}: nosniff`);
  }
  assert.equal((await fetch(`${base}/api/p/${id}/attachments/bd-1/notes.txt`)).headers.get('content-type'), 'application/octet-stream');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // Opened directly, as a review-link chip does: the script must not run.
    await page.goto(svgUrl);
    await page.waitForTimeout(300);
    assert.notEqual(await page.title(), 'pwned', 'SVG script ran on the app origin');
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    // Embedded as an image (the normal description path), it still renders.
    await page.goto(`${base}/p/demo`);
    const width = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      return img.naturalWidth;
    }, svgUrl);
    assert.equal(width, 10, 'attachment images still render inline');
  } finally {
    await browser.close();
  }
  await fetch(`${base}/api/projects/${id}`, { method: 'DELETE' });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('PASS attachment hardening: scripted SVGs sandboxed, nosniff set, dot segments dropped, inline images intact');
