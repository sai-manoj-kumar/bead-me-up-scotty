// Tests for the `beadscope start | stop | status | logs | run` launcher.
//
// Needs no build and no node_modules: it copies bin/beadscope.mjs into a
// throwaway package root next to a tiny stand-in for `next`, and points the
// launcher's state dir at a temp XDG_CONFIG_HOME, so it never touches a real
// Beadscope install or a real server on port 3000.
//
//   node scripts/test-daemon.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "beadscope-daemon-test-"));
const pkg = path.join(tmp, "pkg");
const config = path.join(tmp, "config");
const stateFile = path.join(config, "beadscope", "server.json");

// --- fixture: package root + fake `next` -----------------------------------
fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
fs.mkdirSync(path.join(pkg, ".next"), { recursive: true });
fs.mkdirSync(path.join(pkg, "node_modules", "next", "dist", "bin"), { recursive: true });
fs.copyFileSync(
  path.join(repo, "bin", "beadscope.mjs"),
  path.join(pkg, "bin", "beadscope.mjs"),
);
fs.writeFileSync(path.join(pkg, ".next", "BUILD_ID"), "test");
fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "fake-beadscope" }));
fs.writeFileSync(
  path.join(pkg, "node_modules", "next", "package.json"),
  JSON.stringify({ name: "next", version: "0.0.0" }),
);
fs.writeFileSync(
  path.join(pkg, "node_modules", "next", "dist", "bin", "next"),
  `
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("-p") + 1]);
const host = args[args.indexOf("-H") + 1];
if (process.env.FAKE_NEXT_EXIT) { console.log("fake-next: boom"); process.exit(3); }
require("http").createServer((req, res) => res.end("ok")).listen(port, host, () =>
  console.log("fake-next listening on " + host + ":" + port));
if (process.env.FAKE_NEXT_STUBBORN) process.on("SIGTERM", () => {}); // like a stuck SSE drain
setInterval(() => {}, 1 << 30);
`,
);

const bin = path.join(pkg, "bin", "beadscope.mjs");
const baseEnv = { ...process.env, XDG_CONFIG_HOME: config };
delete baseEnv.PORT;
delete baseEnv.HOST;
delete baseEnv.BEADSCOPE_ALLOWED_HOSTS; // keep the developer's shell export out of the tests

/** Run the launcher to completion. Hangs (and times out) if `start` doesn't detach. */
function beadscope(args, { env = {}, cwd = os.tmpdir(), timeout = 30000 } = {}) {
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...baseEnv, ...env },
    encoding: "utf8",
    timeout,
  });
  assert.equal(r.error, undefined, `beadscope ${args.join(" ")} failed to run: ${r.error}`);
  return r;
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const get = async (url) => (await fetch(url)).text();
const refused = async (url) => {
  try {
    await fetch(url);
    return false;
  } catch {
    return true;
  }
};

const steps = [];
const step = (name) => steps.push(name);

try {
  const port = await freePort();
  const url = `http://localhost:${port}/`;

  // 1. Bare `beadscope` and --help show usage and exit 0 without starting anything.
  for (const args of [[], ["--help"], ["start", "--help"]]) {
    const r = beadscope(args);
    assert.equal(r.status, 0, `beadscope ${args.join(" ")} exits 0`);
    assert.match(r.stdout, /Commands:/);
    assert.match(r.stdout, /beadscope <command>/);
  }
  assert.ok(!fs.existsSync(stateFile), "usage must not start a server");
  step("bare beadscope / --help print usage and exit 0, starting nothing");

  // 2. Unknown subcommand: error + usage, non-zero.
  {
    const r = beadscope(["bogus"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown command: "bogus"/);
    assert.match(r.stderr, /Commands:/);
  }
  step("unknown subcommand exits 1 with usage");

  // 3. Nothing running: status exits 1, stop is a harmless no-op, logs explains.
  assert.equal(beadscope(["status"]).status, 1);
  {
    const r = beadscope(["stop"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /not running/);
  }
  assert.equal(beadscope(["logs"]).status, 1);
  step("status/stop/logs with nothing running");

  // 4. start: returns promptly (detached), server answers, state recorded.
  const t0 = Date.now();
  const started = beadscope(["start", "--no-open", "--port", String(port)]);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, new RegExp(`http://localhost:${port}/`));
  assert.match(started.stdout, /beadscope stop/);
  assert.ok(Date.now() - t0 < 15000, "start returns once the server is ready");
  assert.equal(await get(url), "ok");
  const state = readState();
  assert.equal(state.port, port);
  assert.ok(alive(state.pid), "recorded pid is alive after start returned");
  assert.equal(
    fs.statSync(stateFile).mode & 0o077,
    process.platform === "win32" ? fs.statSync(stateFile).mode & 0o077 : 0,
    "state file is private",
  );
  step("start detaches, returns, server is reachable, pid recorded");

  // 5. status (from another cwd) reports it.
  {
    const r = beadscope(["status"], { cwd: pkg });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /running/);
    assert.match(r.stdout, new RegExp(`PID:\\s+${state.pid}`));
    assert.match(r.stdout, new RegExp(url));
  }
  step("status reports URL and pid");

  // 6. A second start doesn't launch another server.
  {
    const r = beadscope(["start", "--no-open"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /already running/);
    assert.equal(readState().pid, state.pid, "same server, not a second one");
    const other = beadscope(["start", "--no-open", "--port", String(port + 1)]);
    assert.match(other.stdout, /ignoring --port/);
    assert.equal(readState().pid, state.pid);
  }
  step("second start reuses the running server");

  // 7. logs shows what the server printed.
  {
    const r = beadscope(["logs"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /fake-next listening/);
    assert.equal(beadscope(["logs", "-n", "1"]).status, 0);
    assert.notEqual(beadscope(["logs", "-n", "0"]).status, 0, "-n must be positive");
  }
  step("logs prints the server output");

  // 8. stop (from another cwd) kills it and cleans up.
  {
    const r = beadscope(["stop"], { cwd: pkg });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Stopped/);
    assert.ok(!alive(state.pid), "process is gone");
    assert.ok(await refused(url), "port is closed");
    assert.ok(!fs.existsSync(stateFile), "state file removed");
    assert.match(beadscope(["stop"]).stdout, /not running/);
    assert.equal(beadscope(["status"]).status, 1);
  }
  step("stop kills the server, closes the port, removes state; second stop is a no-op");

  // 9. Stale state (process died without `stop`) is cleaned up, not trusted.
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ pid: 2 ** 22 + 12345, port, host: "localhost", startedAt: Date.now() - 3600e3 }),
  );
  assert.equal(beadscope(["status"]).status, 1);
  assert.ok(!fs.existsSync(stateFile), "stale state removed");
  fs.writeFileSync(stateFile, "{not json");
  assert.match(beadscope(["stop"]).stdout, /not running/);
  assert.ok(!fs.existsSync(stateFile), "corrupt state removed");
  step("stale and corrupt state files are cleaned up");

  // 10. PID reuse: a live, unrelated pid with nothing on the recorded port must
  //     NOT be signalled. The pid used here is this test process itself.
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ pid: process.pid, port, host: "localhost", startedAt: Date.now() - 3600e3 }),
  );
  assert.match(beadscope(["stop"]).stdout, /not running/);
  assert.ok(alive(process.pid), "unrelated process was left alone");
  assert.ok(!fs.existsSync(stateFile));
  step("a recycled pid is never signalled");

  // 11. A server that ignores SIGTERM is escalated to SIGKILL.
  {
    const r = beadscope(["start", "--no-open", "--port", String(port)], { env: { FAKE_NEXT_STUBBORN: "1" } });
    assert.equal(r.status, 0, r.stderr);
    const { pid } = readState();
    const t = Date.now();
    const s = beadscope(["stop"]);
    assert.equal(s.status, 0, s.stderr);
    assert.ok(!alive(pid), "stubborn server was killed");
    assert.ok(Date.now() - t >= 3500, "waited out the SIGTERM grace period first");
    assert.ok(await refused(url));
  }
  step("stop escalates to SIGKILL when SIGTERM is ignored");

  // 12. A server that dies on boot: start fails loudly, shows the log, leaves no state.
  {
    const r = beadscope(["start", "--no-open", "--port", String(port)], { env: { FAKE_NEXT_EXIT: "1" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /failed to start/);
    assert.match(r.stderr, /fake-next: boom/);
    assert.ok(!fs.existsSync(stateFile), "no state left behind");
  }
  step("start reports a server that crashes on boot and leaves no state");

  // 13. `run` still works in the foreground and exits when told to.
  {
    const r = spawnSync(
      process.execPath,
      [bin, "run", "--no-open", "--port", String(port)],
      { env: baseEnv, encoding: "utf8", timeout: 4000, killSignal: "SIGINT" },
    );
    assert.match(r.stdout, /Ctrl\+C to stop/);
    assert.ok(!fs.existsSync(stateFile), "run does not use the background state file");
  }
  step("run stays a foreground command");

  // 14. Allowed hostnames are printed as extra URLs, and remembered for later commands.
  {
    const aliasUrl = `http://beadscope.local:${port}/`;
    const env = { BEADSCOPE_ALLOWED_HOSTS: "Beadscope.local, *, not a host!" };
    const r = beadscope(["start", "--no-open", "--port", String(port)], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Also → ${aliasUrl.replace(/\./g, "\\.")}`));
    assert.doesNotMatch(r.stdout, /not a host|\*/, "wildcards and junk are not printed as URLs");
    assert.deepEqual(readState().allowedHosts, ["beadscope.local"]);

    // A later shell without the variable still reports what the running server accepts.
    const again = beadscope(["start", "--no-open"]);
    assert.match(again.stdout, new RegExp(aliasUrl.replace(/\./g, "\\.")));
    const status = beadscope(["status"]);
    assert.match(status.stdout, new RegExp(`Also: ${aliasUrl.replace(/\./g, "\\.")}`));
    beadscope(["stop"]);

    // Without the variable nothing extra is printed.
    const plain = beadscope(["start", "--no-open", "--port", String(port)]);
    assert.doesNotMatch(plain.stdout, /Also/);
    assert.deepEqual(readState().allowedHosts, []);
    beadscope(["stop"]);
  }
  step("allowed hostnames are printed on start/status and remembered across shells");

  console.log(`PASS: ${steps.length} groups\n  - ${steps.join("\n  - ")}`);
} finally {
  try {
    beadscope(["stop"]);
  } catch {
    /* best effort */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
