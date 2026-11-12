// Tests the one-time copy of per-user state from the pre-rename config dir
// (~/.config/bead-me-up-scotty) into the new one (~/.config/beadscope).
// Loads lib/config.ts in child processes with throwaway XDG_CONFIG_HOME dirs;
// never touches the real ~/.config.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configModule = fileURLToPath(new URL('../lib/config.ts', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'beadscope-migrate-'));
let n = 0;

function setup(legacyFiles = {}, newFiles = {}) {
  const xdg = path.join(scratch, `xdg-${n++}`);
  const write = (dir, files) => {
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(xdg, dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
  };
  fs.mkdirSync(xdg, { recursive: true });
  write('bead-me-up-scotty', legacyFiles);
  write('beadscope', newFiles);
  return xdg;
}

/** Load the config module (which triggers the migration) and read the project count. */
function run(xdg) {
  const script = `
    const { getConfig } = await import(${JSON.stringify(configModule)});
    console.log(JSON.stringify({ projects: getConfig().projects.length }));`;
  const out = execFileSync(process.execPath, ['--conditions=react-server', '--no-warnings', '--input-type=module', '-e', script], {
    cwd: scratch, env: { ...process.env, XDG_CONFIG_HOME: xdg }, encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}
const exists = (xdg, rel) => fs.existsSync(path.join(xdg, rel));
const read = (xdg, rel) => fs.readFileSync(path.join(xdg, rel), 'utf8');

try {
  // 1. Existing install: config, telemetry id and history are copied; transient server files are not.
  const legacyConfig = JSON.stringify({ humanActor: 'me', humanAllowlist: ['me'], humanActorChosen: true, projects: [{ id: 'a', name: 'A', path: '/tmp/a' }, { id: 'b', name: 'B', path: '/tmp/b' }] });
  let xdg = setup({
    'config.json': legacyConfig,
    'telemetry.json.id': 'abc-123',
    'telemetry.json.days/2026-11-01': 'x',
    'server.json': '{"pid":1}',
    'server.log': 'old log',
  });
  assert.equal(run(xdg).projects, 2, 'the project registry survives the rename');
  assert.equal(read(xdg, 'beadscope/config.json').includes('"id":"a"'), true, 'config.json copied');
  assert.equal(read(xdg, 'beadscope/telemetry.json.id'), 'abc-123', 'telemetry id copied');
  assert.equal(read(xdg, 'beadscope/telemetry.json.days/2026-11-01'), 'x', 'nested telemetry history copied');
  assert.equal(exists(xdg, 'beadscope/server.json'), false, 'server.json is not carried over');
  assert.equal(exists(xdg, 'beadscope/server.log'), false, 'server.log is not carried over');
  assert.equal(read(xdg, 'bead-me-up-scotty/config.json'), legacyConfig, 'the old directory is left untouched');
  assert.equal(exists(xdg, 'bead-me-up-scotty/server.json'), true, 'old server.json still there');
  console.log('ok: legacy state is copied, transient files skipped, old dir untouched');

  // 2. Never overwrite what the new directory already has; still fill in what is missing.
  xdg = setup(
    { 'config.json': legacyConfig, 'telemetry.json.id': 'old-id' },
    { 'config.json': JSON.stringify({ humanActor: 'new', humanAllowlist: ['new'], projects: [] }) },
  );
  assert.equal(run(xdg).projects, 0, 'existing new config wins');
  assert.equal(read(xdg, 'beadscope/telemetry.json.id'), 'old-id', 'missing files are still filled in');
  console.log('ok: existing files in the new dir are never overwritten');

  // 3. Fresh install: nothing to migrate, and no legacy dir is invented.
  xdg = setup();
  fs.rmSync(path.join(xdg, 'bead-me-up-scotty'), { recursive: true, force: true });
  fs.rmSync(path.join(xdg, 'beadscope'), { recursive: true, force: true });
  assert.equal(run(xdg).projects, 0);
  assert.equal(exists(xdg, 'bead-me-up-scotty'), false, 'no legacy dir is created');
  console.log('ok: fresh install is unaffected');

  // 4. Running again is a no-op (idempotent).
  xdg = setup({ 'config.json': legacyConfig });
  run(xdg);
  fs.writeFileSync(path.join(xdg, 'beadscope/config.json'), JSON.stringify({ projects: [], humanActor: 'edited', humanAllowlist: ['edited'] }));
  run(xdg);
  assert.equal(read(xdg, 'beadscope/config.json').includes('edited'), true, 'a second start does not re-copy over edits');
  console.log('ok: migration is idempotent');

  console.log('PASS: state migration');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
