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
  const result = spawnSync("tar", ["-xf", archive, "-C", dest], { encoding: "utf8" });
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

async function main() {
  const actionlint = await ensureTool("actionlint");
  const shellcheck = await ensureTool("shellcheck");
  // actionlint 1.7.12 (2026-03-30) does not know the 2026-07-30 `$/`
  // same-repository syntax. Ignore only that message. Every other finding,
  // including shellcheck, still fails the run.
  const result = spawnSync(
    actionlint,
    [
      "-shellcheck",
      shellcheck,
      "-color",
      "-ignore",
      'specifying action "\\$/.+" in invalid format',
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exit(result.status === null ? 1 : result.status);
}

module.exports = { PINS, assertSha256, pinFor, sha256File, cachedBinary };

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  });
}
