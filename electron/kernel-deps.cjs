/**
 * FRIDAY · Python packages of the local AI service after an update.
 *
 * A new version can add a package to kernel/requirements.txt. The installer
 * ships the kernel code but the packages live in the managed Python
 * environment under the FRIDAY folder, which an update does not touch, so a
 * newly required package would be missing until something failed. Once per
 * change of that file (remembered by hash in <root>/updates/kernel-deps.json)
 * this runs `pip install -r` in the background:
 *
 *   - only the owner's managed interpreter is used, never a system one that
 *     could not take the packages;
 *   - nothing is uninstalled or downgraded (plain `install -r`);
 *   - a failure is remembered for a day so a broken network does not retry on
 *     every start, and it never blocks or crashes start-up.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const STAMP = path.join("updates", "kernel-deps.json");
const RETRY_AFTER_FAILURE_MS = 24 * 3600_000;
const PIP_TIMEOUT_MS = 20 * 60_000;

/** Same hash for the same requirements: comments, blank lines and CRLF do not count. */
function hashRequirements(file) {
  const lines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line && !line.startsWith("#"));
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

function readStamp(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, STAMP), "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writeStamp(root, value) {
  try {
    fs.mkdirSync(path.join(root, "updates"), { recursive: true });
    fs.writeFileSync(path.join(root, STAMP), JSON.stringify(value, null, 2));
  } catch {
    /* the next start decides again */
  }
}

/** What would happen on the next sync, without doing it. */
function status({ root, file, now = Date.now() }) {
  if (!root || !file || !fs.existsSync(file)) return { needed: false, reason: "no requirements" };
  const hash = hashRequirements(file);
  const stamp = readStamp(root);
  if (stamp.hash === hash) return { needed: false, hash, reason: "current" };
  if (stamp.failed?.hash === hash && now - Number(stamp.failed.at || 0) < RETRY_AFTER_FAILURE_MS) {
    return { needed: false, hash, reason: "failed recently", error: stamp.failed.error || "" };
  }
  return { needed: true, hash, reason: stamp.hash ? "requirements changed" : "not recorded yet" };
}

/** Real pip run: resolves { code, out } and never throws. */
function runPip(exe, args, { timeoutMs = PIP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out: out.slice(-4000) });
    };
    let child;
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1", PYTHONIOENCODING: "utf-8" },
      });
    } catch (error) {
      out = String(error?.message || error);
      resolve({ code: -1, out });
      return;
    }
    const timer = setTimeout(() => {
      out += "\npip timed out";
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(-2);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (error) => {
      out += String(error?.message || error);
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
  });
}

/**
 * Install what the shipped requirements.txt asks for when it changed.
 * Returns { ok, skipped?, installed?, current?, error? }.
 */
async function syncKernelDeps({
  root,
  file,
  python,
  run = runPip,
  log = () => {},
  now = Date.now(),
}) {
  const state = status({ root, file, now });
  if (!state.needed)
    return { ok: true, skipped: true, current: state.reason === "current", reason: state.reason };
  if (!python?.exe) return { ok: true, skipped: true, reason: "no managed Python found" };
  log(`kernel packages: ${state.reason}, running pip install -r`);
  const args = [
    ...(python.prefix || []),
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--prefer-binary",
    "-r",
    file,
  ];
  const result = await run(python.exe, args);
  const stamp = readStamp(root);
  if (result.code === 0) {
    writeStamp(root, { hash: state.hash, at: now, python: python.executable || python.exe });
    log("kernel packages: installed");
    return { ok: true, installed: true };
  }
  const error = String(result.out || `pip exited with ${result.code}`)
    .trim()
    .slice(-600);
  writeStamp(root, { ...stamp, failed: { hash: state.hash, at: now, error } });
  log(`kernel packages: failed — ${error.split("\n").pop()}`);
  return { ok: false, error };
}

module.exports = { hashRequirements, status, syncKernelDeps, runPip, STAMP };
