// Isolated server only. Uses a throwaway bd repo; skips when bd is not installed.
// Closing a bead the user claimed under the pre-0.3.1 default (the OS user)
// must still work after the actor moved to git user.name; a teammate's claim
// must keep bd's protection.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.BEADSCOPE_TEST_URL;
assert.ok(base, 'Set BEADSCOPE_TEST_URL to an isolated app server');
try { execFileSync('bd', ['--version'], { stdio: 'ignore' }); } catch {
  console.log('SKIP close actor: bd is not installed');
  process.exit(0);
}

const osUser = os.userInfo().username;
const newActor = 'Scotty Close Test Actor';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scotty-close-'));
const json = { 'Content-Type': 'application/json' };
const before = await (await fetch(`${base}/api/config`)).json();
let projectId;
try {
  const bd = (args, actor) => execFileSync('bd', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, BEADS_ACTOR: actor } });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  bd(['init', '--prefix', 'ct'], osUser);
  const claimed = (assignee) => {
    const id = JSON.parse(bd(['create', `claimed by ${assignee}`, '--json'], osUser)).id;
    bd(['update', id, '--assignee', assignee, '-s', 'in_progress'], osUser);
    return id;
  };
  const mine = claimed(osUser), mineToArchive = claimed(osUser), teammate = claimed('a-teammate');

  const added = await fetch(`${base}/api/projects`, { method: 'POST', headers: json, body: JSON.stringify({ path: dir }) });
  assert.equal(added.status, 201);
  projectId = (await added.json()).id;
  // The actor is now someone other than the OS user, as after the #61 fix.
  assert.equal((await fetch(`${base}/api/config`, { method: 'PUT', headers: json, body: JSON.stringify({ humanActor: newActor }) })).status, 200);

  const status = (id) => {
    const shown = JSON.parse(bd(['show', id, '--json'], osUser));
    return (Array.isArray(shown) ? shown[0] : shown).status;
  };
  let r = await fetch(`${base}/api/p/${projectId}/beads/${mine}/status`, { method: 'POST', headers: json, body: JSON.stringify({ status: 'closed', reason: 'done' }) });
  assert.equal(r.status, 200, `closing my own old-name claim: ${await r.text()}`);
  assert.equal(status(mine), 'closed');
  r = await fetch(`${base}/api/p/${projectId}/beads/${mineToArchive}/archive`, { method: 'POST' });
  assert.equal(r.status, 200, `archiving my own old-name claim: ${await r.text()}`);
  assert.equal(status(mineToArchive), 'closed');
  r = await fetch(`${base}/api/p/${projectId}/beads/${teammate}/status`, { method: 'POST', headers: json, body: JSON.stringify({ status: 'closed' }) });
  assert.notEqual(r.status, 200, "a teammate's claim stays protected");
  assert.equal(status(teammate), 'in_progress');
} finally {
  await fetch(`${base}/api/config`, { method: 'PUT', headers: json, body: JSON.stringify({ humanActor: before.humanActor }) });
  if (projectId) await fetch(`${base}/api/projects/${projectId}`, { method: 'DELETE' });
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("PASS close actor: old OS-user claims close and archive; a teammate's claim stays protected");
