// Runs every browser suite in scripts/ (the test-*.mjs files that read BEADSCOPE_TEST_URL)
// against isolated demo servers, then prints a summary and exits non-zero if any suite failed.
//
//   npm run build
//   npm run test:browser              # all suites
//   npm run test:browser -- focus     # only suites whose name contains "focus"
//
// Needs a production build (`npm run build`) and a Playwright browser
// (`npx playwright install chromium`). Each server gets a throwaway XDG_CONFIG_HOME and no
// analytics key, and runs in demo mode, so no project data is read or written.
//
// Most suites assert read-only behavior or intercept every project request, so they share one
// read-only server. The suites in NEEDS_WRITABLE edit a real (throwaway) project and need
// editing enabled, so they get a second server. Suites run one at a time because they share
// those servers.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(root, "scripts");
const NEEDS_WRITABLE = new Set(["test-close-actor.mjs"]);
const SUITE_TIMEOUT_MS = 3 * 60_000;
const SERVER_START_TIMEOUT_MS = 60_000;

const filters = process.argv.slice(2);
const suites = fs
  .readdirSync(scriptsDir)
  .filter((file) => /^test-.*\.mjs$/.test(file))
  .filter((file) => fs.readFileSync(path.join(scriptsDir, file), "utf8").includes("BEADSCOPE_TEST_URL"))
  .filter((file) => filters.length === 0 || filters.some((f) => file.includes(f)))
  .sort();
if (suites.length === 0) {
  console.error("No browser suites matched.");
  process.exit(2);
}

const servers = [];
const tempDirs = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(label, { readOnly }) {
  const port = await freePort();
  const config = fs.mkdtempSync(path.join(os.tmpdir(), `beadscope-browser-${label}-`));
  tempDirs.push(config);
  const env = { ...process.env, XDG_CONFIG_HOME: config, BEADS_DEMO: "1", POSTHOG_KEY: "", NEXT_TELEMETRY_DISABLED: "1" };
  delete env.BEADSCOPE_READ_ONLY;
  if (readOnly) env.BEADSCOPE_READ_ONLY = "1";
  const child = spawn(process.execPath, [path.join(root, "bin", "beadscope.mjs"), "run", "--no-open", "--port", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  let exited = false;
  child.once("exit", () => (exited = true));
  servers.push(child);

  const url = `http://localhost:${port}`;
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`The ${label} server exited early:\n${output}`);
    try {
      if ((await fetch(`${url}/api/projects`)).ok) return url;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The ${label} server did not become ready within ${SERVER_START_TIMEOUT_MS / 1000}s:\n${output}`);
}

function runSuite(file, baseUrl) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(scriptsDir, file)], {
      cwd: root,
      env: { ...process.env, BEADSCOPE_TEST_URL: baseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      output += `\nTimed out after ${SUITE_TIMEOUT_MS / 1000}s\n`;
      child.kill("SIGKILL");
    }, SUITE_TIMEOUT_MS);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ file, ok: code === 0, code: code ?? signal, seconds: (Date.now() - started) / 1000, output });
    });
  });
}

async function shutdown() {
  for (const child of servers) child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const child of servers) if (child.exitCode === null) child.kill("SIGKILL");
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await shutdown();
    process.exit(130);
  });
}

const results = [];
try {
  const urls = {};
  if (suites.some((file) => !NEEDS_WRITABLE.has(file))) urls.readOnly = await startServer("read-only", { readOnly: true });
  if (suites.some((file) => NEEDS_WRITABLE.has(file))) urls.writable = await startServer("writable", { readOnly: false });

  for (const file of suites) {
    const result = await runSuite(file, NEEDS_WRITABLE.has(file) ? urls.writable : urls.readOnly);
    results.push(result);
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${file.padEnd(36)} ${result.seconds.toFixed(1)}s`);
    if (!result.ok) console.log(result.output.trimEnd().split("\n").map((line) => `      ${line}`).join("\n"));
  }
} finally {
  await shutdown();
}

const failed = results.filter((result) => !result.ok);
const total = results.reduce((sum, result) => sum + result.seconds, 0);
console.log(`\n${results.length - failed.length}/${results.length} suites passed in ${total.toFixed(0)}s`);
if (failed.length > 0) console.log(`Failed: ${failed.map((result) => result.file).join(", ")}`);
process.exit(failed.length > 0 ? 1 : 0);
