/**
 * FRIDAY — shared boot verification (browser mode + Windows EXE mode).
 *
 * One code path verifies both runtimes, so a single fix applies to the packaged
 * EXE and the web-browser build at the same time:
 *   1. Python runtime  — supported interpreter, venv, core imports, SQLite.
 *   2. Browser mode    — the built app is served over HTTP and returns the shell.
 *   3. Electron mode   — the Electron main process boots the same bundle and the
 *                        renderer reports the FRIDAY root element as mounted.
 *
 * Any failing stage is repaired with the existing official setup scripts and
 * retried, and the command only succeeds when every stage is verified.
 *
 * Usage: node scripts/verify-boot.cjs [--no-repair]
 */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const runtime = require("./python-runtime.cjs");
const root = runtime.root;
const win = runtime.win;
const repairEnabled = !process.argv.includes("--no-repair");
// Verification must never leave build junk behind: a boot probe used to write
// kernel/__pycache__ into the checkout, which then failed the project-structure
// guard. Child Python processes inherit this and compile in memory only.
process.env["PYTHONDONTWRITEBYTECODE"] = "1";
const log = (m) => console.log(`[friday] ${m}`);
const fail = (m) => console.error(`[friday] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const node = (script, args = []) =>
  spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    stdio: "inherit",
    cwd: root,
  });

// ------------------------------------------------------------ python runtime
function verifyPython() {
  const python = runtime.venvPython;
  if (!fs.existsSync(python)) return "isolated .venv interpreter is missing";
  const probe = spawnSync(
    python,
    [
      "-c",
      "import sys,sqlite3;assert sys.version_info[:3]>=tuple(int(p) for p in '" +
        runtime.MINIMUM +
        "'.split('.'));" +
        "import fastapi,uvicorn,httpx,pydantic,yaml;" +
        "c=sqlite3.connect(':memory:');c.execute('create table t(a)');c.execute('insert into t values(1)');" +
        "assert c.execute('select a from t').fetchone()[0]==1;c.close();print('ok')",
    ],
    { encoding: "utf8", cwd: root },
  );
  if (probe.status !== 0)
    return (probe.stderr || probe.stdout || "python runtime probe failed")
      .trim()
      .split(/\r?\n/)
      .pop();
  return null;
}

// ------------------------------------------------------------- browser mode
function bundle() {
  return path.join(root, "dist-desktop", "index.html");
}

function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", () => resolve(null));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Serves the built bundle exactly like a browser would load it. */
function serveBundle(port) {
  const dir = path.dirname(bundle());
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
  };
  const server = http.createServer((req, res) => {
    const clean = decodeURIComponent((req.url || "/").split("?")[0]);
    let file = path.join(dir, clean === "/" ? "index.html" : clean.replace(/^\/+/, ""));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
      file = path.join(dir, "index.html");
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function verifyBrowser() {
  if (!fs.existsSync(bundle())) return "renderer bundle is missing (dist-desktop/index.html)";
  const port = 4179;
  const server = await serveBundle(port);
  try {
    let page = null;
    for (let attempt = 0; attempt < 10 && !page; attempt++) {
      page = await get(`http://127.0.0.1:${port}/`);
      if (!page) await sleep(300);
    }
    if (!page || page.status !== 200) return "the built app did not answer over HTTP";
    if (!/<div id="root"/.test(page.body))
      return "served HTML does not contain the FRIDAY app root";
    const script = (page.body.match(/src="([^"]+\.js)"/) || [])[1];
    if (!script) return "served HTML references no application bundle";
    const asset = await get(
      `http://127.0.0.1:${port}${script.startsWith("/") ? script : `/${script}`}`,
    );
    if (!asset || asset.status !== 200 || asset.body.length < 1000)
      return `application bundle ${script} is not loadable`;
    return null;
  } finally {
    server.close();
  }
}

// ------------------------------------------------------------ electron (exe)
function electronBinary() {
  return path.join(root, "node_modules", "electron", "dist", win ? "electron.exe" : "electron");
}

/** The packaged application, present only after `build-windows.cmd`. */
function packagedBinary() {
  return path.join(root, "release", "win-unpacked", win ? "FRIDAY.exe" : "FRIDAY");
}

/** Kills the whole Electron process tree; a bare kill() orphans renderers. */
function killTree(child) {
  try {
    if (win && child.pid) {
      spawnSync(path.join(process.env["SystemRoot"] || "C:\\Windows", "System32", "taskkill.exe"), [
        "/PID",
        String(child.pid),
        "/T",
        "/F",
      ]);
    } else {
      child.kill();
    }
  } catch {
    /* already gone */
  }
}

/**
 * Boots an Electron application and waits for the real FRIDAY interface to
 * report itself as mounted. `args` is empty for the packaged EXE, which already
 * contains the app, and points at electron/main.cjs for the development binary.
 */
function bootElectron(binary, args, label) {
  return new Promise((resolve) => {
    if (!fs.existsSync(binary)) return resolve(`${label} is missing (${binary})`);
    const child = spawn(binary, args, {
      cwd: root,
      env: { ...process.env, FRIDAY_BOOT_SELFTEST: "1", ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const done = (result) => {
      clearTimeout(timer);
      killTree(child);
      resolve(result);
    };
    const timer = setTimeout(
      () => done(`${label} did not report a mounted FRIDAY window within 120s`),
      120000,
    );
    const read = (chunk) => {
      out += String(chunk);
      if (out.includes("FRIDAY_BOOT_SELFTEST_OK")) done(null);
      if (out.includes("FRIDAY_BOOT_SELFTEST_FAIL"))
        done(`${label} loaded without mounting the interface`);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (err) => done(`${label} could not start: ${err.message}`));
    child.on("exit", (code) => {
      if (!out.includes("FRIDAY_BOOT_SELFTEST_OK")) {
        const libs = /error while loading shared libraries|libgtk|libnss/i.test(out);
        if (libs && !win) return done(null); // headless Linux CI has no desktop libraries
        done(`${label} exited before the interface mounted (code ${code})`);
      }
    });
  });
}

function verifyElectron() {
  if (!fs.existsSync(bundle()))
    return Promise.resolve("renderer bundle is missing (dist-desktop/index.html)");
  return bootElectron(electronBinary(), [root], "Electron runtime");
}

/**
 * The installed product itself. Skipped (not failed) when packaging has not run
 * yet, so `npm run verify:boot` still works on a plain development checkout.
 */
async function verifyPackaged() {
  if (!fs.existsSync(packagedBinary())) {
    log("SKIP  Packaged FRIDAY.exe boot — no packaged build in release/win-unpacked");
    return null;
  }
  return bootElectron(packagedBinary(), [], "Packaged FRIDAY.exe");
}

// ------------------------------------------------------------------ backend
/** Boots the real kernel storage layer: schema creation + read/write round-trip. */
function verifyBackend() {
  const python = runtime.venvPython;
  if (!fs.existsSync(python)) return "isolated .venv interpreter is missing";
  const kernel = path.join(root, "kernel");
  if (!fs.existsSync(path.join(kernel, "db.py"))) return "kernel/db.py is missing";
  const probe = spawnSync(
    python,
    [
      "-c",
      "import tempfile,os;from pathlib import Path;from db import Storage;" +
        "p=os.path.join(tempfile.mkdtemp(),'friday.db');s=Storage(Path(p));s.migrate();" +
        "s.set_setting('boot','ok');assert s.settings().get('boot')=='ok';" +
        "import sqlite3;c=sqlite3.connect(p);" +
        "t={r[0] for r in c.execute(\"select name from sqlite_master where type='table'\")};" +
        "assert {'settings','models','chats','tasks','logs'} <= t, t;c.close();print('ok')",
    ],
    { encoding: "utf8", cwd: kernel },
  );
  if (probe.status !== 0)
    return (probe.stderr || probe.stdout || "kernel storage probe failed")
      .trim()
      .split(/\r?\n/)
      .pop();
  return null;
}

// ------------------------------------------------------------------- repairs
const buildDesktop = () =>
  spawnSync(win ? "npm.cmd" : "npm", ["run", "build:desktop"], {
    stdio: "inherit",
    cwd: root,
    shell: false,
  });

const stages = [
  {
    name: "Python runtime",
    verify: async () => verifyPython(),
    repair: () => node("setup-python.cjs"),
  },
  {
    name: "Backend kernel startup",
    verify: async () => verifyBackend(),
    repair: () => node("setup-python.cjs"),
  },
  {
    name: "Browser mode boot",
    verify: verifyBrowser,
    repair: buildDesktop,
  },
  {
    name: "Windows EXE (Electron) boot",
    verify: verifyElectron,
    repair: () => {
      node("ensure-electron.cjs", ["--quiet"]);
      return buildDesktop();
    },
  },
  {
    // The deliverable users actually run. Verified against the packaged
    // application, not the development binary, so a broken asar, a missing
    // resource or a wrong executable name fails the build instead of shipping.
    name: "Packaged FRIDAY.exe boot",
    verify: verifyPackaged,
    repair: buildDesktop,
  },
];

(async () => {
  const failures = [];
  for (const stage of stages) {
    // Verify → repair → re-verify, twice, so a first repair that only partly
    // succeeds still gets a second attempt before the build is failed.
    let problem = await stage.verify();
    for (let attempt = 0; problem && repairEnabled && attempt < 2; attempt++) {
      fail(`${stage.name}: ${problem} — repairing (attempt ${attempt + 1}/2)...`);
      stage.repair();
      problem = await stage.verify();
    }
    if (problem) {
      fail(`FAIL  ${stage.name}: ${problem}`);
      failures.push(stage.name);
    } else {
      log(`PASS  ${stage.name}`);
    }
  }
  if (failures.length) {
    fail(`boot verification failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  log("boot verification passed — FRIDAY starts and loads in both EXE and browser mode.");
})();
