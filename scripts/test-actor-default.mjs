// Loads lib/config.ts in child processes with throwaway config dirs, git config
// and launch directories. Never touches the real ~/.config or git settings.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configModule = fileURLToPath(new URL('../lib/config.ts', import.meta.url));
const osUser = os.userInfo().username;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scotty-actor-'));
const gitRepo = path.join(scratch, 'repo');
const noGit = path.join(scratch, 'plain');
fs.mkdirSync(gitRepo);
fs.mkdirSync(noGit);
const isolatedGit = { GIT_CONFIG_GLOBAL: path.join(scratch, 'no-global'), GIT_CONFIG_NOSYSTEM: '1' };
execFileSync('git', ['init', '-q'], { cwd: gitRepo, env: { ...process.env, ...isolatedGit } });
execFileSync('git', ['config', 'user.name', 'Scotty Test Actor'], { cwd: gitRepo, env: { ...process.env, ...isolatedGit } });

let n = 0;
/** Run getConfig() (and optionally saveConfig) in a fresh process. */
function load({ cwd = gitRepo, env = {}, onDisk, save } = {}) {
  const xdg = path.join(scratch, `xdg-${n++}`);
  fs.mkdirSync(path.join(xdg, 'beadscope'), { recursive: true });
  if (onDisk) fs.writeFileSync(path.join(xdg, 'beadscope', 'config.json'), JSON.stringify(onDisk));
  const script = `
    const { getConfig, saveConfig } = await import(${JSON.stringify(configModule)});
    ${save ? `saveConfig(${JSON.stringify(save)});` : ''}
    const c = getConfig();
    console.log(JSON.stringify({ humanActor: c.humanActor, humanAllowlist: c.humanAllowlist, humanActorChosen: c.humanActorChosen }));`;
  const childEnv = { ...process.env, ...isolatedGit, XDG_CONFIG_HOME: xdg, ...env };
  if (!('BEADS_ACTOR' in env)) delete childEnv.BEADS_ACTOR;
  const out = execFileSync(process.execPath, ['--conditions=react-server', '--no-warnings', '--input-type=module', '-e', script], { cwd, env: childEnv, encoding: 'utf8' });
  return { ...JSON.parse(out.trim().split('\n').pop()), xdg };
}

try {
  // Fresh install: follow bd's order.
  let c = load();
  assert.equal(c.humanActor, 'Scotty Test Actor', 'git user.name comes before the OS user');
  assert.deepEqual(c.humanAllowlist, ['Scotty Test Actor']);
  assert.equal(load({ env: { BEADS_ACTOR: 'env-actor' } }).humanActor, 'env-actor', 'BEADS_ACTOR wins');
  assert.equal(load({ cwd: noGit }).humanActor, osUser, 'without a git name, the OS user');

  // Upgrade: the old computed default on disk is replaced, keeping the allowlist.
  c = load({ onDisk: { humanActor: osUser, humanAllowlist: [osUser, 'pal'], projects: [] } });
  assert.equal(c.humanActor, 'Scotty Test Actor', 'stale OS-user default is replaced');
  assert.deepEqual(c.humanAllowlist, [osUser, 'pal', 'Scotty Test Actor'], 'new actor joins the allowlist');
  c = load({ cwd: noGit, onDisk: { humanActor: osUser, humanAllowlist: [osUser], projects: [] } });
  assert.equal(c.humanActor, osUser, 'no git name: nothing changes');
  assert.deepEqual(c.humanAllowlist, [osUser]);

  // Explicit choices stick.
  c = load({ onDisk: { humanActor: osUser, humanAllowlist: [osUser], humanActorChosen: true, projects: [] } });
  assert.equal(c.humanActor, osUser, 'an actor saved from Settings is kept');
  assert.equal(load({ onDisk: { humanActor: 'Someone Else', humanAllowlist: ['Someone Else'], projects: [] } }).humanActor, 'Someone Else', 'a non-default name is kept');
  c = load({ save: { humanActor: osUser } });
  assert.equal(c.humanActorChosen, true);
  const saved = JSON.parse(fs.readFileSync(path.join(c.xdg, 'beadscope', 'config.json'), 'utf8'));
  assert.equal(saved.humanActor, osUser);
  assert.equal(saved.humanActorChosen, true, 'saving from Settings records the choice');
  assert.equal(load({ onDisk: saved }).humanActor, osUser, 'the saved choice survives a restart');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log("PASS actor default: BEADS_ACTOR > git user.name > OS user; stale defaults upgraded; Settings choices kept");
