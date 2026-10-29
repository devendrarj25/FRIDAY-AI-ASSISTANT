#!/usr/bin/env node
/**
 * Lint .github/workflows with pinned actionlint and shellcheck.
 *
 * The binaries are downloaded from the official release archives, checked
 * against the SHA-256 below, and kept in the temp directory. They are not
 * committed. A hash mismatch refuses to run the tool.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const yaml = require("js-yaml");
const { spawnDirect, localTar } = require("./win-spawn.cjs");

const ROOT = path.resolve(__dirname, "..");

const PINS = {
  actionlint: {
    version: "1.7.12",
    linux: {
      url: "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz",
      sha256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
      binary: "actionlint",
    },
    win32: {
      url: "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_windows_amd64.zip",
      sha256: "6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9",
      binary: "actionlint.exe",
    },
  },
  shellcheck: {
    version: "0.11.0",
    linux: {
      url: "https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.x86_64.tar.xz",
      sha256: "8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198",
      binary: "shellcheck",
    },
    win32: {
      url: "https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.zip",
      sha256: "8a4e35ab0b331c85d73567b12f2a444df187f483e5079ceffa6bda1faa2e740e",
      binary: "shellcheck.exe",
    },
  },
};

function pinFor(name) {
  const tool = PINS[name];
  if (!tool) throw new Error(`unknown lint tool ${name}`);
  const osKey = process.platform === "win32" ? "win32" : "linux";
  const pin = tool[osKey];
  if (!pin) throw new Error(`${name} has no pin for ${process.platform}`);
  if (process.platform !== "win32" && process.platform !== "linux") {
    throw new Error(
      `${name} download is pinned for linux and win32 only (this host: ${process.platform})`,
    );
  }
  if (process.arch !== "x64") {
    throw new Error(`${name} download is pinned for x64 only (this host: ${process.arch})`);
  }
  return { ...pin, version: tool.version, name };
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function assertSha256(file, expected) {
  const got = sha256File(file);
  if (got !== expected) {
    throw new Error(`${path.basename(file)} SHA-256 ${got} does not match ${expected}`);
  }
  return got;
}

async function download(url, dest) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed ${response.status} for ${url}`);
  const body = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
}

function extractArchive(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const spec = localTar(archive, ["-xf", archive, "-C", dest]);
  const result = spawnDirect("tar", spec.args, { cwd: spec.cwd });
  if (result.status !== 0) {
    throw new Error(`could not extract ${path.basename(archive)} (${result.status})`);
  }
}

function findBinary(dir, name) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return full;
    }
  }
  return null;
}

function cachedBinary(home, name) {
  if (!fs.existsSync(home)) return null;
  const binary = findBinary(home, name);
  return binary && fs.existsSync(binary) ? binary : null;
}

async function ensureTool(name) {
  const pin = pinFor(name);
  const home = path.join(os.tmpdir(), "friday-lint-tools", pin.sha256);
  const binary = cachedBinary(home, pin.binary);
  if (binary) return binary;
  const archive = path.join(home, "archive.bin");
  await download(pin.url, archive);
  assertSha256(archive, pin.sha256);
  extractArchive(archive, home);
  const extracted = findBinary(home, pin.binary);
  if (!extracted) throw new Error(`${name} archive did not contain ${pin.binary}`);
  if (process.platform !== "win32") fs.chmodSync(extracted, 0o755);
  return extracted;
}

const SHELLCHECK_EXCLUDES = "SC1091,SC2194,SC2050,SC2153,SC2154,SC2157,SC2043";

/**
 * The March 2026 actionlint release writes a whole run script into shellcheck's
 * stdin before starting the process. Windows anonymous pipes are 4 KiB, and
 * these workflows are larger, so that write never returns. An empty
 * `-shellcheck` turns the integration off. Shellcheck still runs afterwards.
 */
function actionlintArguments(shellcheck, platform = process.platform) {
  const ignore = 'specifying action "\\$/.+" in invalid format';
  if (platform === "win32") return ["-shellcheck=", "-color", "-ignore", ignore];
  return ["-shellcheck", shellcheck, "-color", "-ignore", ignore];
}

function shellKind(shell) {
  const text = String(shell || "");
  if (text === "bash" || text === "sh") return text;
  if (text.startsWith("bash ")) return "bash";
  if (text.startsWith("sh ")) return "sh";
  return "";
}

function sanitizeExpressions(src) {
  let out = "";
  let rest = String(src);
  while (rest.length) {
    const start = rest.indexOf("${{");
    if (start === -1) return out + rest;
    const end = rest.indexOf("}}", start);
    if (end === -1) return out + rest;
    const close = end + 2;
    out += rest.slice(0, start) + "_".repeat(close - start);
    rest = rest.slice(close);
  }
  return out;
}

function runnerShell(runsOn) {
  const labels = [];
  if (typeof runsOn === "string") labels.push(runsOn);
  else if (Array.isArray(runsOn)) labels.push(...runsOn);
  else if (runsOn && Array.isArray(runsOn.labels)) labels.push(...runsOn.labels);
  for (const label of labels) {
    const text = String(label).toLowerCase();
    if (text === "windows" || text.startsWith("windows-")) return "pwsh";
  }
  return "";
}

function shellScriptsFromWorkflow(doc) {
  const scripts = [];
  const workflowShell =
    doc && doc.defaults && doc.defaults.run && doc.defaults.run.shell
      ? String(doc.defaults.run.shell)
      : "";
  const jobs = doc && doc.jobs && typeof doc.jobs === "object" ? doc.jobs : {};
  for (const job of Object.values(jobs)) {
    if (!job || typeof job !== "object") continue;
    const jobShell =
      job.defaults && job.defaults.run && job.defaults.run.shell
        ? String(job.defaults.run.shell)
        : "";
    const fallback = jobShell || workflowShell || runnerShell(job["runs-on"]) || "bash";
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const step of steps) {
      if (!step || typeof step.run !== "string") continue;
      const shell = shellKind(step.shell || fallback);
      if (!shell) continue;
      scripts.push({ shell, source: step.run });
    }
  }
  return scripts;
}

function workflowShellScripts(root = ROOT) {
  const dir = path.join(root, ".github", "workflows");
  const scripts = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const file = path.join(dir, name);
    const doc = yaml.load(fs.readFileSync(file, "utf8"));
    for (const script of shellScriptsFromWorkflow(doc)) scripts.push({ ...script, file: name });
  }
  return scripts;
}

function shellcheckFindings(shellcheck, scripts, spawnImpl = spawnSync) {
  const findings = [];
  for (const script of scripts) {
    const shell = shellKind(script.shell);
    if (!shell) continue;
    const setup = shell === "bash" ? "set -eo pipefail" : "set -e";
    const body = `${setup}\n${sanitizeExpressions(script.source)}\n`;
    const args = ["--norc", "-f", "json", "-x", "--shell", shell, "-e", SHELLCHECK_EXCLUDES, "-"];
    const result = spawnImpl(shellcheck, args, { input: body, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    const stdout = String(result.stdout || "");
    if (result.status && !stdout.trim()) {
      const stderr = String(result.stderr || "").trim();
      throw new Error(
        `shellcheck exited with status ${result.status} and no output${stderr ? `: ${stderr}` : ""}`,
      );
    }
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    for (const item of parsed) {
      const line = Math.max(1, Number(item.line || 1) - 1);
      const message = String(item.message || "").replace(/\.$/, "");
      const where = script.file ? `${script.file}: ` : "";
      findings.push(
        `${where}shellcheck reported issue in this script: SC${item.code}:${item.level}:${line}:${item.column}: ${message}`,
      );
    }
  }
  return findings;
}

async function main() {
  const actionlint = await ensureTool("actionlint");
  const shellcheck = await ensureTool("shellcheck");
  // actionlint 1.7.12 (2026-03-30) does not know the 2026-07-30 `$/`
  // same-repository syntax. Ignore only that message. Every other finding,
  // including shellcheck, still fails the run.
  process.stdout.write("workflow lint: actionlint\n");
  const result = spawnSync(actionlint, actionlintArguments(shellcheck), {
    cwd: ROOT,
    stdio: "inherit",
    timeout: 180000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status === null ? 1 : result.status);
  if (process.platform === "win32") {
    const scripts = workflowShellScripts(ROOT);
    process.stdout.write(`workflow lint: shellcheck ${scripts.length} scripts\n`);
    const findings = shellcheckFindings(shellcheck, scripts);
    if (findings.length) {
      for (const line of findings) console.error(line);
      process.exit(1);
    }
  }
}

module.exports = {
  PINS,
  assertSha256,
  pinFor,
  sha256File,
  cachedBinary,
  actionlintArguments,
  sanitizeExpressions,
  shellScriptsFromWorkflow,
  shellcheckFindings,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  });
}
