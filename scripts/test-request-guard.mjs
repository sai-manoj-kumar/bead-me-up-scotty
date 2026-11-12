// Isolated server only. Every request that the guard lets through carries an
// invalid body, so nothing is ever written even if a route is reached.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { checkRequest, isAllowedHost, hostnameOf } from '../lib/request-guard.ts';

// ── Pure decision table ─────────────────────────────────────────────────────
for (const h of ['localhost:3000', 'LOCALHOST', 'app.localhost:1', '127.0.0.1:19847', '[::1]:3000', '192.168.1.20:3000', 'localhost.:3000']) {
  assert.equal(isAllowedHost(h), true, `${h} should be allowed`);
}
for (const h of ['evil.example:3000', 'localhost.evil.example', '127.0.0.1.nip.io', 'mybox.local:3000', '999.1.1.1']) {
  assert.equal(isAllowedHost(h), false, `${h} should be refused`);
}
assert.equal(isAllowedHost('mybox.local:3000', 'mybox.local, other'), true);
assert.equal(isAllowedHost('anything.example', '*'), true);
assert.equal(hostnameOf('[::1]:3000'), '::1');
const base = { host: 'localhost:3000', secFetchSite: null };
assert.equal(checkRequest({ ...base, method: 'POST', origin: 'http://localhost:3000' }).ok, true);
assert.equal(checkRequest({ ...base, method: 'POST', origin: null }).ok, true, 'non-browser clients send no Origin');
assert.equal(checkRequest({ ...base, method: 'POST', origin: 'http://evil.example' }).ok, false);
assert.equal(checkRequest({ ...base, method: 'POST', origin: 'http://localhost:5173' }).ok, false, 'another local port is another site');
assert.equal(checkRequest({ ...base, method: 'POST', origin: 'null' }).ok, false);
assert.equal(checkRequest({ ...base, method: 'DELETE', origin: null, secFetchSite: 'cross-site' }).ok, false);
assert.equal(checkRequest({ ...base, method: 'GET', origin: 'http://evil.example' }).ok, true, 'reads are protected by CORS, not refused');
assert.equal(checkRequest({ host: '127.0.0.1:3000', method: 'POST', origin: 'https://tracker.example', secFetchSite: null, allowedHosts: 'tracker.example' }).ok, true, 'allowed proxy origin');
// "*" accepts any hostname but never re-enables cross-site writes.
assert.equal(checkRequest({ host: 'anything.example', method: 'GET', origin: null, secFetchSite: null, allowedHosts: '*' }).ok, true);
assert.equal(checkRequest({ host: 'anything.example', method: 'POST', origin: 'http://anything.example', secFetchSite: null, allowedHosts: '*' }).ok, true);
assert.equal(checkRequest({ host: 'localhost:3000', method: 'POST', origin: 'http://evil.example', secFetchSite: null, allowedHosts: '*' }).ok, false);
// Every refusal names the setting that would allow it.
const hostRefusal = checkRequest({ host: 'mybox.local:3000', method: 'GET', origin: null, secFetchSite: null });
assert.match(hostRefusal.error, /BEADSCOPE_ALLOWED_HOSTS=mybox\.local\b/);
assert.match(hostRefusal.error, /BEADSCOPE_ALLOWED_HOSTS=\*/);
const originRefusal = checkRequest({ ...base, method: 'POST', origin: 'https://tracker.example' });
assert.match(originRefusal.error, /tracker\.example/);
assert.match(originRefusal.error, /BEADSCOPE_ALLOWED_HOSTS=tracker\.example/);

// ── Against the running server ──────────────────────────────────────────────
const target = process.env.BEADSCOPE_TEST_URL;
assert.ok(target, 'Set BEADSCOPE_TEST_URL to an isolated app server');
const { hostname, port } = new URL(target);

function send(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: hostname, port, method, path, headers, setHost: false }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const own = `localhost:${port}`;
const json = { 'Content-Type': 'application/json' };
const code = (r) => { try { return JSON.parse(r.body).code; } catch { return undefined; } };

// CSRF: a page on another site posting a "simple" text/plain body.
let r = await send('POST', '/api/p/demo/beads', { Host: own, Origin: 'http://evil.example', 'Content-Type': 'text/plain' }, '{}');
assert.equal(r.status, 403); assert.equal(code(r), 'cross_origin');
r = await send('POST', '/api/update/run', { Host: own, Origin: 'http://evil.example', 'Content-Type': 'text/plain' }, '{}');
assert.equal(r.status, 403, 'self-update must not be triggerable cross-site');
r = await send('POST', '/api/projects', { Host: own, 'Sec-Fetch-Site': 'cross-site', ...json }, '{}');
assert.equal(r.status, 403, 'Sec-Fetch-Site cross-site without Origin');
r = await send('PUT', '/api/config', { Host: own, Origin: 'null', ...json }, '{}');
assert.equal(r.status, 403, 'opaque origin');

// Same-origin browser writes and Origin-less tools reach the route (and fail validation).
r = await send('POST', '/api/projects', { Host: own, Origin: `http://${own}`, ...json }, '{}');
assert.equal(r.status, 400, `same-origin write reaches the route: ${r.body}`);
r = await send('POST', '/api/projects', { Host: own, ...json }, '{}');
assert.equal(r.status, 400, 'launcher-style request without Origin reaches the route');

// DNS rebinding: a forged hostname is refused for reads, pages and the event stream.
for (const path of ['/api/projects', '/api/config', '/', '/p/demo', '/api/p/demo/beads/stream']) {
  r = await send('GET', path, { Host: `rebind.evil.example:${port}` });
  assert.equal(r.status, 403, `${path} with a rebound Host`);
}
assert.equal(code(await send('GET', '/api/projects', { Host: `rebind.evil.example:${port}` })), 'host_not_allowed');
for (const host of [own, `127.0.0.1:${port}`, `10.0.0.5:${port}`]) {
  r = await send('GET', '/api/projects', { Host: host });
  assert.equal(r.status, 200, `${host} is a loopback name or IP literal`);
}
r = await send('GET', '/favicon.ico', { Host: `rebind.evil.example:${port}` });
assert.notEqual(r.status, 403, 'static assets stay outside the guard');

// The real UI still loads and its own writes still carry a matching Origin.
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${target}/p/demo`);
  // Any rendered bead proves the page and its API reads got through (both modes).
  await page.locator('[data-keyboard-bead-id]').first().waitFor();
  const status = await page.evaluate(async () => (await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
  assert.equal(status, 400, 'browser same-origin write is not refused');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
console.log('PASS request guard: CSRF and DNS-rebinding requests refused; same-origin UI, tools and IP hosts allowed');
