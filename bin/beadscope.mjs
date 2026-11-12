#!/usr/bin/env node
/**
 * Global launcher for Beadscope.
 *
 * Installed as `beadscope`.
 *
 *   beadscope start    start the Next.js production server in the background
 *   beadscope stop     stop it again, from any terminal
 *   beadscope status   show whether it is running, and where
 *   beadscope logs     show (or follow) the server output
 *   beadscope run      run the server in the foreground (Ctrl+C to stop)
 *
 * The server is this package's own prebuilt .next, on a free port. Once it is
 * ready we open the browser; if the command was run from a directory that
 * contains a `.beads` repo, it opens straight to that project's board.
 *
 * A background server is tracked by a small state file (pid, port, host) in the
 * per-user config dir, next to the usage-statistics settings, so `stop` and
 * `status` can find it from any terminal. Its output goes to `server.log`
 * beside it.
 *
 * Zero dependencies — Node stdlib only. Works regardless of the directory it's
 * launched from (resolves the package root from this file's location, not cwd).
 */
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// The directory the user ran the command from (used for cwd auto-open).
const invocationCwd = process.cwd();

// This package's root — the dir holding package.json, .next and node_modules.
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

const require = createRequire(import.meta.url);

/** How long `stop` waits after SIGTERM before it escalates to SIGKILL. */
const STOP_GRACE_MS = 4000;
/** A server started this recently is trusted on its PID alone (still booting). */
const STARTUP_GRACE_MS = 60000;

const COMMANDS = ["start", "stop", "status", "logs", "run"];

function printHelp(stream = process.stdout) {
  stream.write(`
Beadscope — local web UI for the beads (bd) tracker.

Usage:
  beadscope <command> [options]

Commands:
  start     Start the server in the background and open your browser.
            Run it from a folder that has a .beads repo to jump straight to
            that project; otherwise you get the picker. If Beadscope is already
            running it just opens the browser again.
  stop      Stop the background server (works from any terminal).
  status    Show whether the server is running, with its URL and PID.
            Exits 1 when it is not running.
  logs      Print the end of the server log.
              -f, --follow    Keep printing new output (Ctrl+C to quit).
              -n, --lines <n> How many lines to show (default 50).
  run       Run the server in the foreground; Ctrl+C stops it.

Options (start, run):
  -p, --port <n>   Port to use (default 3000, or $PORT). Auto-picks a free
                   port if the default is busy; with an explicit --port it
                   fails instead of moving.
      --host <h>   Host to bind (default from Next; or $HOST).
      --no-open    Don't open a browser, just print the URL.
  -h, --help       Show this help.

The background server's PID and log live in
\${XDG_CONFIG_HOME:-~/.config}/beadscope/.
`);
}

function parseArgs(argv) {
  const opts = { open: true, help: false, follow: false, lines: 50 };
  let portExplicit = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--no-open") opts.open = false;
    else if (a === "-f" || a === "--follow") opts.follow = true;
    else if (a === "-n" || a === "--lines") opts.lines = Number(argv[++i]);
    else if (a.startsWith("--lines=")) opts.lines = Number(a.slice("--lines=".length));
    else if (a === "-p" || a === "--port") {
      opts.port = Number(argv[++i]);
      portExplicit = true;
    } else if (a.startsWith("--port=")) {
      opts.port = Number(a.slice("--port=".length));
      portExplicit = true;
    } else if (a === "--host") {
      opts.host = argv[++i];
    } else if (a.startsWith("--host=")) {
      opts.host = a.slice("--host=".length);
    } else if (!a.startsWith("-") && opts.command === undefined) {
      opts.command = a; // first bare word is the subcommand
    }
  }
  opts.portExplicit = portExplicit;
  if (opts.port === undefined) {
    const env = Number(process.env.PORT);
    opts.port = Number.isInteger(env) && env > 0 ? env : 3000;
  }
  opts.host = opts.host || process.env.HOST || "localhost";
  // The host ends up in a spawn() command line (browser open) and a URL;
  // restrict it to hostname/IP characters so it can't carry shell metacharacters.
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(opts.host)) {
    console.error(`Invalid host: ${JSON.stringify(opts.host)}`);
    process.exit(1);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    console.error(`Invalid port: ${String(opts.port)} (expected 1-65535)`);
    process.exit(1);
  }
  if (!Number.isInteger(opts.lines) || opts.lines < 1) {
    console.error(`Invalid line count (expected a positive integer)`);
    process.exit(1);
  }
  return opts;
}

/** Resolve true if `port` can be bound on 0.0.0.0, else false. */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen({ port, host: "0.0.0.0" });
  });
}

/** Resolve true if something accepts TCP connections at host:port. */
function portInUse(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    sock.setTimeout(1000);
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("error", () => resolve(false));
  });
}

/** Find a free port at/after `start`. If `explicit`, only check `start`. */
async function pickPort(start, explicit) {
  if (await portFree(start)) return start;
  if (explicit) {
    console.error(`Port ${start} is already in use. Pick another with --port.`);
    process.exit(1);
  }
  for (let p = start + 1; p <= start + 50; p++) {
    if (await portFree(p)) return p;
  }
  console.error(`Could not find a free port near ${start}.`);
  process.exit(1);
}

/** Resolve the local `next` CLI entrypoint from this package's deps. */
function resolveNextBin() {
  try {
    const pkg = require.resolve("next/package.json");
    return path.join(path.dirname(pkg), "dist", "bin", "next");
  } catch {
    console.error(
      "Could not find the 'next' package. Run `npm install` in the project first.",
    );
    process.exit(1);
  }
}

/** A production build must already exist — we never build at runtime (the
 *  global install dir may not be writable, and a build needs devDependencies). */
function ensureBuild() {
  if (!fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    console.error(
      "No production build found.\n" +
        "Run `npm run build` in the project directory, then reinstall " +
        "(`npm link` or `npm install -g .`).",
    );
    process.exit(1);
  }
}

/**
 * Poll the server until it responds, then resolve. `failed()` lets the caller
 * bail out early (e.g. the server process already exited) instead of waiting
 * out the whole timeout.
 */
function waitForReady(host, port, timeoutMs = 30000, failed = () => false) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host, port, path: "/", timeout: 2000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (failed()) reject(new Error("Server exited before it was ready"));
      else if (Date.now() > deadline) reject(new Error("Server did not become ready in time"));
      else setTimeout(tick, 250);
    };
    tick();
  });
}

/** Best-effort cross-platform browser open. Never throws. */
function openBrowser(url) {
  try {
    let cmd, args;
    if (process.platform === "darwin") {
      cmd = "open";
      args = [url];
    } else if (process.platform === "win32") {
      cmd = "cmd";
      // cmd.exe re-parses its command line, so caret-escape metacharacters —
      // otherwise a hostile URL could break out of the `start` argument.
      args = ["/c", "start", '""', url.replace(/[&|^<>]/g, "^$&")];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* headless / no browser — the URL is printed regardless */
  }
}

/** If invoked from a .beads project, register it and return its board path. */
async function targetPath(host, port) {
  try {
    if (!fs.existsSync(path.join(invocationCwd, ".beads"))) return "/";
    const body = JSON.stringify({ path: invocationCwd });
    const entry = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host,
          port,
          path: "/api/projects",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(e);
              }
            } else {
              reject(new Error(`add project failed (${res.statusCode})`));
            }
          });
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
    return entry && entry.id ? `/p/${encodeURIComponent(entry.id)}` : "/";
  } catch {
    return "/"; // fall back to the picker
  }
}

/** Canonical board URL, plus opening the browser if asked. */
async function showAndOpen(host, port, open) {
  const target = open ? await targetPath(host, port) : "/";
  // Canonicalize through the URL parser — throws on anything that isn't a
  // well-formed http origin, so no raw user input reaches openBrowser().
  const fullUrl = new URL(target, `http://${host}:${port}`).href;
  return { fullUrl, open: () => open && openBrowser(fullUrl) };
}

/* ------------------------------------------------------------------ */
/* Background server bookkeeping                                      */
/* ------------------------------------------------------------------ */

/** Same per-user dir the usage-statistics settings use. */
function stateDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "beadscope");
}
const stateFile = () => path.join(stateDir(), "server.json");
const logFile = () => path.join(stateDir(), "server.log");

/** Read the state file; null when missing or malformed. */
function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (
      Number.isInteger(s.pid) && s.pid > 0 &&
      Number.isInteger(s.port) && s.port > 0 &&
      typeof s.host === "string" && Number.isFinite(s.startedAt)
    ) {
      return s;
    }
  } catch {
    /* no state / unreadable */
  }
  return null;
}

/** Create the state file, failing (false) if one appeared in the meantime. */
function writeStateExclusive(state) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(state), { flag: "wx", mode: 0o600 });
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}

function removeState() {
  try {
    fs.unlinkSync(stateFile());
  } catch {
    /* already gone */
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, just not ours to signal
  }
}

/**
 * Send `sig` to the background server. It was started as the leader of its own
 * process group, so on POSIX we signal the whole group in case Next forked
 * workers. Returns false if the process is already gone.
 */
function signalServer(pid, sig) {
  const attempts = process.platform === "win32" ? [pid] : [-pid, pid];
  for (const target of attempts) {
    try {
      process.kill(target, sig);
      return true;
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  }
  return false;
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

/**
 * The state of the background server, or null if there isn't one. A state file
 * whose process is gone — or whose PID has been recycled by something that
 * isn't listening on the recorded port — is stale and is removed, so we never
 * signal a stranger's process.
 */
async function getRunning() {
  const state = readState();
  if (!state) {
    removeState(); // drop a corrupt file, if any
    return null;
  }
  const booting = Date.now() - state.startedAt < STARTUP_GRACE_MS;
  if (pidAlive(state.pid) && (booting || (await portInUse(state.host, state.port)))) {
    return state;
  }
  removeState();
  return null;
}

function formatUptime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const serverUrl = (s) => `http://${s.host}:${s.port}/`;

/**
 * Hostnames BEADSCOPE_ALLOWED_HOSTS lets the server answer to, beyond localhost
 * and IPs. "*" means "any name" so there is nothing to print for it.
 */
function allowedHostNames(raw) {
  return String(raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h));
}

/** `url` re-addressed to each allowed hostname (same port and path). */
function aliasUrls(url, names) {
  return names.map((name) => {
    const u = new URL(url);
    u.hostname = name;
    return u.href;
  });
}

const aliasLines = (url, names) =>
  aliasUrls(url, names)
    .map((u) => `  Also → ${u}\n`)
    .join("");

/* ------------------------------------------------------------------ */
/* Commands                                                           */
/* ------------------------------------------------------------------ */

async function cmdStart(opts) {
  const running = await getRunning();
  if (running) {
    console.log(`\n  Beadscope is already running → ${serverUrl(running)}  (pid ${running.pid})`);
    if (opts.portExplicit && opts.port !== running.port) {
      console.log(`  (ignoring --port ${opts.port}; \`beadscope stop\` first to move it)`);
    }
    const { fullUrl, open } = await showAndOpen(running.host, running.port, opts.open);
    console.log(`  ${fullUrl}`);
    console.log(`${aliasLines(fullUrl, running.allowedHosts ?? [])}`);
    open();
    return;
  }

  ensureBuild();
  const port = await pickPort(opts.port, opts.portExplicit);
  const host = opts.host;
  const nextBin = resolveNextBin();

  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  // The log is truncated on every start so it can't grow without bound across
  // restarts; it holds the output of the current (or last) server only.
  const logFd = fs.openSync(logFile(), "w", 0o600);
  const child = spawn(process.execPath, [nextBin, "start", ROOT, "-p", String(port), "-H", host], {
    cwd: ROOT,
    detached: true, // own session/process group, so it outlives this terminal
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: { ...process.env, PORT: String(port), HOST: host },
  });
  fs.closeSync(logFd);

  let exited = false;
  child.on("error", () => (exited = true));
  child.on("exit", () => (exited = true));

  if (!child.pid) {
    console.error("Could not start the server process.");
    process.exit(1);
  }

  // Recorded so `status` and an "already running" start report what this server
  // accepts, not whatever the later shell happens to have exported.
  const allowedHosts = allowedHostNames(process.env.BEADSCOPE_ALLOWED_HOSTS);
  const state = { pid: child.pid, port, host, startedAt: Date.now(), allowedHosts };
  if (!writeStateExclusive(state)) {
    // Another `beadscope start` won the race between our check and now.
    signalServer(child.pid, "SIGKILL");
    const winner = await getRunning();
    console.log(`\n  Beadscope is already running${winner ? ` → ${serverUrl(winner)}` : ""}\n`);
    return;
  }
  child.unref();

  try {
    await waitForReady(host, port, 30000, () => exited);
  } catch (err) {
    try {
      signalServer(child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    removeState();
    console.error(`Server failed to start (${err.message}). Last of ${logFile()}:\n`);
    console.error(tailFile(logFile(), 20) || "  (log is empty)");
    process.exit(1);
  }

  const { fullUrl, open } = await showAndOpen(host, port, opts.open);
  console.log(
    `\n  Beadscope → ${fullUrl}\n` +
      aliasLines(fullUrl, allowedHosts) +
      `  Running in the background (pid ${child.pid}). Stop it with: beadscope stop\n`,
  );
  open();
}

async function cmdStop() {
  const state = await getRunning();
  if (!state) {
    console.log("Beadscope is not running.");
    return;
  }
  try {
    signalServer(state.pid, "SIGTERM");
    // `next start` drains in-flight requests on SIGTERM, and our SSE change
    // stream never completes on its own — so give it a short deadline, then
    // SIGKILL, exactly like Ctrl+C does for `beadscope run`.
    if (!(await waitForExit(state.pid, STOP_GRACE_MS))) {
      signalServer(state.pid, "SIGKILL");
      if (!(await waitForExit(state.pid, 2000))) {
        console.error(`Could not stop Beadscope (pid ${state.pid}).`);
        process.exit(1);
      }
    }
  } catch (e) {
    console.error(`Could not stop Beadscope (pid ${state.pid}): ${e.message}`);
    process.exit(1);
  }
  removeState();
  console.log(`Stopped Beadscope (pid ${state.pid}).`);
}

async function cmdStatus() {
  const state = await getRunning();
  if (!state) {
    console.log("Beadscope is not running.");
    process.exit(1);
  }
  console.log(
    `Beadscope is running\n` +
      `  URL:  ${serverUrl(state)}\n` +
      aliasUrls(serverUrl(state), state.allowedHosts ?? [])
        .map((u) => `  Also: ${u}\n`)
        .join("") +
      `  PID:  ${state.pid}\n` +
      `  Up:   ${formatUptime(Date.now() - state.startedAt)}\n` +
      `  Log:  ${logFile()}`,
  );
}

/** Last `n` lines of a file (reads at most the final 1 MiB). "" if missing. */
function tailFile(file, n) {
  try {
    const { size } = fs.statSync(file);
    const len = Math.min(size, 1 << 20);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, len, size - len);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString("utf8").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-n).join("\n");
  } catch {
    return "";
  }
}

async function cmdLogs(opts) {
  const file = logFile();
  if (!fs.existsSync(file)) {
    console.error("No server log yet. Start Beadscope with: beadscope start");
    process.exit(1);
  }
  const text = tailFile(file, opts.lines);
  if (text) console.log(text);
  if (!opts.follow) return;

  let offset = fs.statSync(file).size;
  setInterval(() => {
    try {
      const { size } = fs.statSync(file);
      if (size < offset) offset = 0; // truncated by a restart
      if (size === offset) return;
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        process.stdout.write(buf);
        offset = size;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* log briefly missing; try again next tick */
    }
  }, 500);
}

async function cmdRun(opts) {
  ensureBuild();

  const port = await pickPort(opts.port, opts.portExplicit);
  const host = opts.host;
  const nextBin = resolveNextBin();

  const child = spawn(process.execPath, [nextBin, "start", ROOT, "-p", String(port), "-H", host], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, PORT: String(port), HOST: host },
  });

  // Forward signals and clean up the child on exit.
  //
  // `next start` shuts down *gracefully*: on SIGINT/SIGTERM it stops accepting
  // connections and then waits for in-flight requests to drain. Our SSE change
  // stream (app/api/p/[projectId]/beads/stream) is an in-flight request that
  // never completes on its own, so with any browser tab open the server waits
  // forever and Ctrl+C looks like it did nothing. Give the graceful path a
  // short deadline, then escalate to SIGKILL so Ctrl+C always works.
  let shuttingDown = false;
  let forceTimer = null;

  const hardKill = () => {
    if (forceTimer) clearTimeout(forceTimer);
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    process.exit(130);
  };

  const forward = (sig) => {
    if (shuttingDown) {
      hardKill(); // second Ctrl+C — don't wait out the deadline
      return;
    }
    shuttingDown = true;
    child.kill(sig);
    console.log("\n  Stopping…  (Ctrl+C again to force)");
    forceTimer = setTimeout(hardKill, STOP_GRACE_MS);
  };

  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("exit", () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  });
  child.on("exit", (code, signal) => {
    if (forceTimer) clearTimeout(forceTimer);
    process.exit(signal ? 128 : (code ?? 0));
  });

  try {
    await waitForReady(host, port);
  } catch {
    console.error("Server failed to start. See the output above.");
    return; // child's exit handler will set the exit code
  }

  const { fullUrl, open } = await showAndOpen(host, port, opts.open);
  console.log(
    `\n  Beadscope → ${fullUrl}\n` +
      aliasLines(fullUrl, allowedHostNames(process.env.BEADSCOPE_ALLOWED_HOSTS)) +
      `  (Ctrl+C to stop)\n`,
  );
  open();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // No subcommand (or --help): show usage. A bare `beadscope` deliberately does
  // not start a server any more — `beadscope start` does.
  if (opts.help || opts.command === undefined) {
    printHelp();
    process.exit(0);
  }

  switch (opts.command) {
    case "start":
      return cmdStart(opts);
    case "stop":
      return cmdStop(opts);
    case "status":
      return cmdStatus(opts);
    case "logs":
      return cmdLogs(opts);
    case "run":
      return cmdRun(opts);
    default:
      console.error(
        `Unknown command: ${JSON.stringify(opts.command)} (expected one of: ${COMMANDS.join(", ")})`,
      );
      printHelp(process.stderr);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
