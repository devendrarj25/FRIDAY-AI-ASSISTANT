/**
 * FRIDAY · Sandbox Lab (main process only).
 *
 * A real, isolated development/testing runtime that lives under
 * `<workspace>/sandbox`. Nothing here touches the production FRIDAY source
 * until the owner explicitly approves an apply, and every apply keeps a
 * backup so it can be rolled back automatically when the regression pass
 * fails.
 *
 * Layout (all persisted across restarts):
 *   <workspace>/sandbox/projects.json     registry of sandbox projects
 *   <workspace>/sandbox/projects/<id>/    the isolated project itself
 *   <workspace>/sandbox/logs/<id>.log     appended command/run log
 *   <workspace>/sandbox/history.json      runs, applies and rollbacks
 *   <workspace>/sandbox/backups/<applyId> pre-apply copies for rollback
 *
 * This module reuses the existing toolchain (electron/toolchain.cjs) for
 * runtime installation and the existing sandbox verifier
 * (electron/sandbox.cjs) for regression runs — no duplicate installers.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const toolchain = require("./toolchain.cjs");
const sandbox = require("./sandbox.cjs");
const engines = require("./sandbox-engines.cjs");

const WIN = process.platform === "win32";

/* ------------------------------------------------------------------ paths */

function paths(root) {
  const base = path.join(root, "sandbox");
  return {
    base,
    projects: path.join(base, "projects"),
    registry: path.join(base, "projects.json"),
    logs: path.join(base, "logs"),
    history: path.join(base, "history.json"),
    backups: path.join(base, "backups"),
    config: path.join(base, "config.json"),
  };
}

function ensureDirs(root) {
  const p = paths(root);
  for (const dir of [p.base, p.projects, p.logs, p.backups]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
};

const slug = (text) =>
  String(text || "project")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "project";

const hash = (buf) => crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);

/** Every path the renderer sends is resolved *inside* the project folder. */
function safeJoin(baseDir, relative) {
  const target = path.resolve(baseDir, String(relative || "").replace(/^[\\/]+/, ""));
  const normalBase = path.resolve(baseDir);
  if (target !== normalBase && !target.startsWith(normalBase + path.sep)) {
    throw new Error("Path escapes the sandbox project.");
  }
  return target;
}

/* --------------------------------------------------------------- registry */

function loadRegistry(root) {
  const p = ensureDirs(root);
  const list = readJson(p.registry, []);
  return Array.isArray(list) ? list : [];
}

function saveRegistry(root, list) {
  writeJson(paths(root).registry, list);
  return list;
}

function historyOf(root) {
  const list = readJson(paths(root).history, []);
  return Array.isArray(list) ? list : [];
}

function pushHistory(root, entry) {
  const list = historyOf(root);
  list.unshift({ at: Date.now(), ...entry });
  writeJson(paths(root).history, list.slice(0, 400));
  return entry;
}

function appendLog(root, projectId, text) {
  try {
    const p = ensureDirs(root);
    fs.appendFileSync(path.join(p.logs, `${projectId}.log`), text, "utf8");
  } catch {
    /* logging must never break a run */
  }
}

function readLog(root, projectId, limit = 60000) {
  try {
    const file = path.join(paths(root).logs, `${projectId}.log`);
    const text = fs.readFileSync(file, "utf8");
    return text.length > limit ? text.slice(-limit) : text;
  } catch {
    return "";
  }
}

/* ---------------------------------------------------------------- runtime */

const run = (cmd, args, timeout = 8000) =>
  new Promise((resolve) => {
    try {
      // Windows shims (npm.cmd, npx.cmd …) can only be executed through the
      // command processor on current Node versions — without this they fail
      // with EINVAL and the runtime is wrongly reported as "not detected".
      const shell = WIN && /\.(cmd|bat)$/i.test(cmd);
      execFile(cmd, args, { timeout, windowsHide: true, shell }, (err, stdout, stderr) => {
        const out = `${stdout || ""}${stderr || ""}`.trim();
        resolve(err && !out ? null : out);
      });
    } catch {
      resolve(null);
    }
  });

const which = async (cmd) => {
  const out = await run(WIN ? "where" : "which", [cmd.replace(/\.(cmd|bat)$/i, "")], 5000);
  if (!out) return null;
  const first = out.split(/\r?\n/).find((l) => l.trim() && !/^INFO:/i.test(l));

  return first ? first.trim() : null;
};

const semver = (text) => {
  if (!text) return null;
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(String(text).split(/\r?\n/)[0] || "");
  return m ? m[1] : null;
};

/**
 * The runtimes the sandbox itself needs. `toolId` maps onto the existing
 * Install Manager catalog so installation reuses the real installer with all
 * of its fallbacks (winget → npm → pip) and retries.
 */
const RUNTIME = [
  {
    id: "node",
    label: "Node.js",
    cmd: "node",
    args: ["-v"],
    toolId: "Node.js LTS",
    required: true,
    source: "nodejs.org",
  },
  {
    id: "npm",
    label: "npm",
    cmd: WIN ? "npm.cmd" : "npm",
    // npm ships with Node.js but can be reachable under several names/paths.
    candidates: WIN
      ? ["npm.cmd", "npm.bat", path.join(path.dirname(process.execPath), "npm.cmd")]
      : ["npm"],
    args: ["-v"],
    toolId: "npm",
    required: true,
    source: "npmjs.com",
  },
  {
    id: "git",
    label: "Git",
    cmd: "git",
    args: ["--version"],
    toolId: "Git",
    required: false,
    source: "git-scm.com",
  },
  {
    id: "python",
    label: "Python",
    cmd: WIN ? "python" : "python3",
    candidates: WIN ? ["python", "python3", "py"] : ["python3", "python"],
    args: ["--version"],
    toolId: "Python",
    required: false,
    source: "python.org",
  },
  {
    id: "pip",
    label: "pip",
    cmd: WIN ? "python" : "python3",
    candidates: WIN ? ["python", "python3", "py"] : ["python3", "python"],
    args: ["-m", "pip", "--version"],
    toolId: "pip",
    required: false,
    source: "pypi.org",
  },
  {
    id: "docker",
    label: "Docker",
    cmd: "docker",
    args: ["--version"],
    toolId: "Docker Desktop",
    required: false,
    source: "docker.com",
  },
  {
    id: "compose",
    label: "Compose",
    cmd: "docker",
    args: ["compose", "version"],
    toolId: "Docker Compose",
    required: false,
    source: "docker.com",
  },
  {
    id: "deno",
    label: "Deno",
    cmd: "deno",
    args: ["--version"],
    toolId: "Deno",
    required: false,
    source: "deno.com",
  },
  {
    id: "go",
    label: "Go",
    cmd: "go",
    args: ["version"],
    toolId: "Go",
    required: false,
    source: "go.dev",
  },
  {
    id: "rust",
    label: "Rust",
    cmd: "rustc",
    args: ["--version"],
    toolId: "Rust",
    required: false,
    source: "rust-lang.org",
  },
  {
    id: "gh",
    label: "GitHub CLI",
    cmd: "gh",
    args: ["--version"],
    toolId: "GitHub CLI",
    required: false,
    source: "cli.github.com",
  },
  {
    id: "eslint",
    label: "ESLint",
    cmd: "eslint",
    args: ["--version"],
    toolId: "ESLint",
    required: false,
    source: "eslint.org",
  },
  {
    id: "vitest",
    label: "Vitest",
    cmd: "vitest",
    args: ["--version"],
    toolId: "Vitest",
    required: false,
    source: "vitest.dev",
  },
  {
    id: "ruff",
    label: "Ruff",
    cmd: "ruff",
    args: ["--version"],
    toolId: "Ruff",
    required: false,
    source: "astral.sh",
  },
  {
    id: "pytest",
    label: "pytest",
    cmd: "pytest",
    args: ["--version"],
    toolId: "pytest",
    required: false,
    source: "pytest.org",
  },
  {
    id: "cmake",
    label: "CMake",
    cmd: "cmake",
    args: ["--version"],
    toolId: "CMake",
    required: false,
    source: "cmake.org",
  },
  {
    id: "rg",
    label: "ripgrep",
    cmd: "rg",
    args: ["--version"],
    toolId: "ripgrep",
    required: false,
    source: "github.com/BurntSushi/ripgrep",
  },
  {
    id: "jq",
    label: "jq",
    cmd: "jq",
    args: ["--version"],
    toolId: "jq (JSON)",
    required: false,
    source: "jqlang.org",
  },
  {
    id: "bun",
    label: "Bun",
    cmd: "bun",
    args: ["-v"],
    toolId: "Bun",
    required: false,
    source: "bun.sh",
  },
  {
    id: "pnpm",
    label: "pnpm",
    cmd: "pnpm",
    args: ["-v"],
    toolId: "pnpm",
    required: false,
    source: "pnpm.io",
  },
  {
    id: "java",
    label: "OpenJDK",
    cmd: "java",
    args: ["-version"],
    toolId: "OpenJDK (Temurin)",
    required: false,
    source: "adoptium.net",
  },
  {
    id: "cargo",
    label: "Cargo",
    cmd: "cargo",
    args: ["--version"],
    toolId: "Rust",
    required: false,
    source: "rust-lang.org",
  },
  {
    id: "yarn",
    label: "Yarn",
    cmd: WIN ? "yarn.cmd" : "yarn",
    args: ["-v"],
    toolId: "Yarn",
    required: false,
    source: "yarnpkg.com",
  },
  {
    id: "tsc",
    label: "TypeScript",
    cmd: WIN ? "tsc.cmd" : "tsc",
    args: ["-v"],
    toolId: "TypeScript",
    required: false,
    source: "typescriptlang.org",
  },
  {
    id: "prettier",
    label: "Prettier",
    cmd: WIN ? "prettier.cmd" : "prettier",
    args: ["--version"],
    toolId: "Prettier",
    required: false,
    source: "prettier.io",
  },
  {
    id: "uv",
    label: "uv",
    cmd: "uv",
    args: ["--version"],
    toolId: "uv (Python)",
    required: false,
    source: "astral.sh",
  },
  {
    id: "podman",
    label: "Podman",
    cmd: "podman",
    args: ["--version"],
    toolId: "Podman",
    required: false,
    source: "podman.io",
  },
  {
    id: "ninja",
    label: "Ninja",
    cmd: "ninja",
    args: ["--version"],
    toolId: "Ninja",
    required: false,
    source: "ninja-build.org",
  },
  {
    id: "clang",
    label: "Clang",
    cmd: "clang",
    args: ["--version"],
    toolId: "LLVM / Clang",
    required: false,
    source: "llvm.org",
  },
  {
    id: "sqlite",
    label: "SQLite",
    cmd: "sqlite3",
    args: ["--version"],
    toolId: "SQLite",
    required: false,
    source: "sqlite.org",
  },
  {
    id: "yq",
    label: "yq",
    cmd: "yq",
    args: ["--version"],
    toolId: "yq (YAML)",
    required: false,
    source: "github.com/mikefarah",
  },
  {
    id: "dotnet",
    label: ".NET SDK",
    cmd: "dotnet",
    args: ["--version"],
    toolId: ".NET SDK",
    required: false,
    source: "microsoft.com",
  },
  {
    id: "wsl",
    label: "WSL",
    cmd: "wsl",
    args: ["-l", "-v"],
    toolId: "WSL 2",
    required: false,
    source: "microsoft.com",
    okIfOutput: true,
  },
];

/** Probe one runtime and *verify the executable actually runs*. */
async function probeRuntime(entry) {
  const candidates = entry.candidates?.length ? entry.candidates : [entry.cmd];
  let found = null;
  let out = null;
  let version = null;
  for (const cmd of candidates) {
    const located = await which(cmd);
    const answer = await run(cmd, entry.args, 10000);
    const parsed = semver(answer);
    if (!found) found = located;
    if (!out) out = answer;
    if (parsed) {
      found = located || found;
      out = answer;
      version = parsed;
      break;
    }
  }
  return {
    id: entry.id,
    label: entry.label,
    required: Boolean(entry.required),
    toolId: entry.toolId,
    source: entry.source,
    path: found || null,
    version: version || null,
    // "verified" means the binary was executed and answered, not just found.
    ok: entry.okIfOutput ? Boolean(version || out) : Boolean(version),
    detail: version
      ? `${entry.label} ${version}`
      : out
        ? String(out).slice(0, 200)
        : "not detected",
  };
}

/** Detect the whole sandbox runtime, in parallel. */
async function detectRuntime() {
  const tools = await Promise.all(RUNTIME.map(probeRuntime));
  return {
    ok: tools.filter((t) => t.required).every((t) => t.ok),
    tools,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
  };
}

/**
 * Install a missing runtime through the existing toolchain job runner.
 * Retries once, then re-probes the real executable before reporting success.
 */
async function installRuntime(id, emit = () => {}) {
  const entry = RUNTIME.find((r) => r.id === id);
  if (!entry) return { ok: false, error: `Unknown runtime "${id}".` };
  const already = await probeRuntime(entry);
  if (already.ok) return { ok: true, skipped: true, tool: already };

  let last = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    emit({
      id,
      phase: attempt === 1 ? "Installing" : "Retrying",
      line: `${entry.label}: attempt ${attempt}`,
    });
    try {
      last = await toolchain.runJob(
        { id: entry.toolId, action: attempt === 1 ? "install" : "repair" },
        (event) => emit({ id, phase: event.phase, line: event.line, ok: event.ok }),
      );
    } catch (error) {
      last = { ok: false, error: String(error.message || error) };
    }
    const probe = await probeRuntime(entry);
    if (probe.ok) {
      emit({ id, phase: "Verified", line: probe.detail, ok: true });
      return { ok: true, tool: probe };
    }
  }
  const probe = await probeRuntime(entry);
  return {
    ok: false,
    tool: probe,
    error:
      last?.error ||
      `${entry.label} could not be installed or verified. Install it from ${entry.source}.`,
  };
}

/* --------------------------------------------------------------- projects */

const TEMPLATES = {
  blank: {
    label: "Blank workspace",
    files: {
      "README.md": "# Sandbox project\n\nIsolated FRIDAY sandbox workspace.\n",
    },
  },
  node: {
    label: "Node script",
    files: {
      "package.json": JSON.stringify(
        {
          name: "sandbox-app",
          private: true,
          version: "0.1.0",
          type: "module",
          scripts: { start: "node index.mjs", test: "node --test" },
        },
        null,
        2,
      ),
      "index.mjs": "console.log('FRIDAY sandbox is running on', process.version);\n",
      "README.md": "# Node sandbox\n\n`npm start` runs index.mjs inside the sandbox only.\n",
    },
  },
  python: {
    label: "Python script",
    files: {
      "main.py": "print('FRIDAY sandbox python ready')\n",
      "requirements.txt": "",
      "README.md": "# Python sandbox\n",
    },
  },
  container: {
    label: "Container project",
    files: {
      Dockerfile: 'FROM node:20-alpine\nWORKDIR /work\nCOPY . .\nCMD ["node", "index.mjs"]\n',
      "compose.yaml": "services:\n  app:\n    build: .\n    working_dir: /work\n",
      "index.mjs": "console.log('FRIDAY container sandbox ready on', process.version);\n",
      "README.md":
        "# Container sandbox\n\nRun with the Docker or Podman engine — the project folder is mounted at /work. `docker compose config` checks the compose file without building.\n",
    },
  },
  deno: {
    label: "Deno (permissioned)",
    files: {
      "main.ts": "console.log('FRIDAY deno sandbox ready', Deno.version.deno);\n",
      "deno.json":
        JSON.stringify({ tasks: { start: "deno run --allow-read main.ts" } }, null, 2) + "\n",
      "README.md":
        "# Deno sandbox\n\nRuns with explicit permissions only: read/write the project folder.\n",
    },
  },
  friday: {
    label: "FRIDAY source copy",
    files: {},
    copySource: true,
  },
  pytest: {
    label: "Python pytest",
    files: {
      "tests/test_ready.py": "def test_sandbox_ready():\n    assert True\n",
      "requirements.txt": "pytest\n",
      "README.md": "# pytest sandbox\n\n`python -m pytest -q` runs inside this project only.\n",
    },
  },
  go: {
    label: "Go module",
    files: {
      "go.mod": "module sandbox\n\ngo 1.22\n",
      "main.go":
        'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("FRIDAY go sandbox ready")\n}\n',
      "README.md": "# Go sandbox\n\n`go test ./...` and `go run .` stay inside this folder.\n",
    },
  },
  rust: {
    label: "Rust crate",
    files: {
      "Cargo.toml": '[package]\nname = "sandbox"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/main.rs": 'fn main() {\n    println!("FRIDAY rust sandbox ready");\n}\n',
      "README.md": "# Rust sandbox\n\n`cargo test` runs inside this folder.\n",
    },
  },
  linux: {
    label: "Linux / Make checks",
    files: {
      Makefile:
        ".PHONY: test lint\n\ntest:\n\t@echo FRIDAY linux sandbox checks\nlint:\n\t@echo no extra linter configured\n",
      "README.md":
        "# Linux sandbox\n\nOn Windows this project is meant to run under the WSL or Docker isolation engine — FRIDAY does not ship a Linux distro. `make test` is the check target.\n",
    },
  },
  java: {
    label: "Java",
    files: {
      "Main.java":
        'public class Main {\n  public static void main(String[] args) {\n    System.out.println("FRIDAY java sandbox ready");\n  }\n}\n',
      "README.md":
        "# Java sandbox\n\n`javac Main.java` then `java Main`. Isolation is still the project engine (process / Docker / WSL).\n",
    },
  },
  cmake: {
    label: "CMake / C",
    files: {
      "CMakeLists.txt":
        "cmake_minimum_required(VERSION 3.16)\nproject(sandbox C)\nadd_executable(sandbox src/main.c)\nenable_testing()\nadd_test(NAME sandbox_boot COMMAND sandbox)\n",
      "src/main.c":
        '#include <stdio.h>\nint main(void) {\n  printf("FRIDAY cmake sandbox ready\\n");\n  return 0;\n}\n',
      "README.md":
        "# CMake sandbox\n\n`cmake -S . -B build` then `cmake --build build` stay inside this folder.\n",
    },
  },
};

function projectDir(root, id) {
  return path.join(paths(root).projects, id);
}

function describe(root, entry) {
  const dir = projectDir(root, entry.id);
  return { ...entry, dir, exists: fs.existsSync(dir) };
}

function listProjects(root) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected.", projects: [] };
  const list = loadRegistry(root).map((entry) => describe(root, entry));
  return { ok: true, projects: list, base: paths(root).base };
}

function createProject(root, { name, template = "blank", sourceRoot = null } = {}) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  const registry = loadRegistry(root);
  const base = slug(name);
  let id = base;
  let n = 2;
  while (registry.some((p) => p.id === id)) id = `${base}-${n++}`;

  const dir = projectDir(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const tpl = TEMPLATES[template] || TEMPLATES.blank;

  if (tpl.copySource) {
    if (!sourceRoot || !fs.existsSync(sourceRoot)) {
      return {
        ok: false,
        error: "The FRIDAY source project could not be located for a source copy.",
      };
    }
    sandbox.copyProject(sourceRoot, dir);
  }
  for (const [file, content] of Object.entries(tpl.files || {})) {
    const target = safeJoin(dir, file);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }

  const entry = {
    id,
    name: String(name || id),
    template,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    origin: tpl.copySource ? sourceRoot : null,
  };
  registry.unshift(entry);
  saveRegistry(root, registry);
  pushHistory(root, { kind: "create", projectId: id, detail: `${entry.name} (${tpl.label})` });
  appendLog(root, id, `\n[${new Date().toISOString()}] project created from ${tpl.label}\n`);
  return { ok: true, project: describe(root, entry) };
}

function removeProject(root, id, { keepFiles = false } = {}) {
  const registry = loadRegistry(root).filter((p) => p.id !== id);
  saveRegistry(root, registry);
  if (!keepFiles) {
    try {
      fs.rmSync(projectDir(root, id), { recursive: true, force: true });
    } catch {
      /* locked files are left behind on purpose */
    }
  }
  pushHistory(root, { kind: "remove", projectId: id });
  return { ok: true };
}

/** Copy an existing folder into a sandbox project (import). */
function importFolder(root, { id, folder, target = "" } = {}) {
  if (!folder || !fs.existsSync(folder))
    return { ok: false, error: "That folder no longer exists." };
  const dir = projectDir(root, id);
  if (!fs.existsSync(dir)) return { ok: false, error: "Unknown sandbox project." };
  const into = safeJoin(dir, target);
  fs.mkdirSync(into, { recursive: true });
  const copied = sandbox.copyProject(folder, into);
  touch(root, id);
  pushHistory(root, { kind: "import", projectId: id, detail: `${copied} file(s) from ${folder}` });
  return { ok: true, files: copied };
}

function touch(root, id) {
  const registry = loadRegistry(root);
  const entry = registry.find((p) => p.id === id);
  if (entry) {
    entry.updatedAt = Date.now();
    saveRegistry(root, registry);
  }
}

const IGNORED = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "dist",
  "build",
  "__pycache__",
  ".cache",
]);

/**
 * Commands this project can run as checks/tests. Nothing is spawned here —
 * `runCommand` is the one executor. Installs are not included (those stay exec).
 */
function planProjectChecks(root, id) {
  const dir = projectDir(root, id);
  if (!fs.existsSync(dir)) return { ok: false, error: "Unknown sandbox project.", checks: [] };
  const checks = [];
  const has = (rel) => fs.existsSync(path.join(dir, rel));
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  const hasExt = (ext) => names.some((name) => String(name).toLowerCase().endsWith(ext));
  const pkg = readJson(path.join(dir, "package.json"), null);
  const scripts = pkg && typeof pkg.scripts === "object" ? pkg.scripts : {};
  if (scripts.typecheck) {
    checks.push({ id: "typecheck", label: "Typecheck", command: "npm run typecheck" });
  } else if (has("tsconfig.json")) {
    checks.push({ id: "tsc", label: "tsc --noEmit", command: "tsc --noEmit" });
  }
  if (scripts.lint) {
    checks.push({ id: "lint", label: "Lint", command: "npm run lint" });
  }
  if (scripts.test) {
    checks.push({ id: "test", label: "Tests", command: "npm test" });
  }
  if (scripts["docs:check"]) {
    checks.push({ id: "docscheck", label: "docs:check", command: "npm run docs:check" });
  }
  if (
    has(".prettierrc") ||
    has(".prettierrc.json") ||
    has("prettier.config.js") ||
    has("prettier.config.cjs") ||
    has("prettier.config.mjs")
  ) {
    checks.push({ id: "prettier", label: "Prettier check", command: "prettier --check ." });
  }
  const pythonProject =
    has("main.py") ||
    has("requirements.txt") ||
    has("pyproject.toml") ||
    has("tests") ||
    has("pytest.ini");
  if (pythonProject) {
    const py = WIN ? "python" : "python3";
    checks.push({
      id: "compileall",
      label: "Python compile",
      command: `${py} -m compileall -q .`,
    });
    checks.push({ id: "pytest", label: "pytest", command: `${py} -m pytest -q` });
    checks.push({ id: "ruff", label: "Ruff", command: "ruff check ." });
  }
  if (has("go.mod")) {
    checks.push({ id: "govet", label: "Go vet", command: "go vet ./..." });
    checks.push({ id: "gotest", label: "Go test", command: "go test ./..." });
  }
  if (has("Cargo.toml")) {
    checks.push({ id: "cargocheck", label: "Cargo check", command: "cargo check" });
    checks.push({ id: "cargotest", label: "Cargo test", command: "cargo test" });
  }
  if (has("deno.json") || has("deno.jsonc") || (has("main.ts") && !pkg)) {
    checks.push({ id: "denocheck", label: "Deno check", command: "deno check ." });
    checks.push({ id: "denotest", label: "Deno test", command: "deno test" });
  }
  if (!scripts.test && (has("bun.lock") || has("bun.lockb"))) {
    checks.push({ id: "buntest", label: "Bun test", command: "bun test" });
  }
  if (has("CMakeLists.txt")) {
    checks.push({ id: "cmake", label: "CMake configure", command: "cmake -S . -B build" });
  }
  if (has("Main.java")) {
    checks.push({ id: "javac", label: "javac Main.java", command: "javac Main.java" });
  }
  if (hasExt(".sln") || hasExt(".csproj") || hasExt(".fsproj")) {
    checks.push({ id: "dotnettest", label: "dotnet test", command: "dotnet test" });
  }
  if (has("Makefile") || has("makefile")) {
    checks.push({ id: "maketest", label: "make test", command: "make test" });
  }
  if (has(".git")) {
    checks.push({ id: "gitstatus", label: "git status", command: "git status --short" });
  }
  return { ok: true, dir, checks };
}

function listFiles(root, id, { limit = 4000 } = {}) {
  const dir = projectDir(root, id);
  if (!fs.existsSync(dir)) return { ok: false, error: "Unknown sandbox project.", files: [] };
  const files = [];
  const walk = (current, rel) => {
    if (files.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      if (IGNORED.has(entry.name)) continue;
      const relative = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        files.push({ path: relative, dir: true });
        walk(full, relative);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* ignore */
        }
        files.push({ path: relative, dir: false, size });
      }
    }
  };
  walk(dir, "");
  return { ok: true, files, dir };
}

function readFile(root, id, relative) {
  try {
    const file = safeJoin(projectDir(root, id), relative);
    const stat = fs.statSync(file);
    if (stat.size > 2 * 1024 * 1024)
      return { ok: false, error: "File is too large to edit here (>2 MB)." };
    return { ok: true, content: fs.readFileSync(file, "utf8"), size: stat.size };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

function writeFile(root, id, relative, content) {
  try {
    const file = safeJoin(projectDir(root, id), relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(content ?? ""), "utf8");
    touch(root, id);
    appendLog(root, id, `[${new Date().toISOString()}] edited ${relative}\n`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

function deleteFile(root, id, relative) {
  try {
    const file = safeJoin(projectDir(root, id), relative);
    fs.rmSync(file, { recursive: true, force: true });
    touch(root, id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

/* ------------------------------------------------------------- execution */

const running = new Map();

/**
 * Run a real command inside one sandbox project.
 * The working directory can never leave the project folder.
 * Isolation engine is auto-selected unless the project (or request) picks one.
 */
async function runCommand(root, options = {}, emit = () => {}) {
  const { id, command, runId, timeoutMs = 15 * 60 * 1000, cwd = "" } = options;
  const dir = projectDir(root, id);
  if (!fs.existsSync(dir)) return { ok: false, error: "Unknown sandbox project." };
  const line = String(command || "").trim();
  if (!line) return { ok: false, error: "No command given." };

  let workdir;
  try {
    workdir = safeJoin(dir, cwd);
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }

  const resolved = await resolveCommandEngine(root, id, options);
  const pythonCommand = commandLooksLikePython(line);
  let engineId = engines.engineForCommand(resolved.engineId, { python: pythonCommand });
  let selected = resolved.selected || null;
  const spec = engines.ENGINES.find((engine) => engine.id === engineId);
  if (spec && !spec.launchOnly) {
    const probe = await engines.probeEngine(spec);
    if (!probe.ready) {
      selected = await engines.ensureSelected({ allowInstall: allowEngineInstall() });
      engineId = engines.engineForCommand(selected.id, { python: pythonCommand });
    }
  }

  const wrapped = engines.wrap(engineId, {
    command: line,
    dir: workdir,
    image: options.image || config(root).image,
    network: options.network ?? config(root).network,
  });
  if (!wrapped.ok) return { ok: false, error: wrapped.error, engine: engineId };
  const executed = wrapped.line;
  const isolated = Boolean(wrapped.isolated);
  const isolationNote =
    isolated || !selected?.warning
      ? wrapped.note
      : `${wrapped.note || engineId} · ${selected.warning}`;

  return new Promise((resolve) => {
    const jobId = runId || `run-${Date.now().toString(36)}`;
    const started = Date.now();
    let output = "";
    let done = false;
    appendLog(
      root,
      id,
      `\n[${engineId}${isolationNote ? ` · ${isolationNote}` : ""}${isolated ? "" : " · not OS-isolated"}]\n$ ${line}\n`,
    );
    emit({
      runId: jobId,
      projectId: id,
      phase: "start",
      command: line,
      engine: engineId,
      note: isolationNote,
      isolated,
    });

    const shell = WIN ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    // cmd.exe cannot read Node's backslash-escaped quoting, so on Windows the
    // command line is handed over verbatim with exactly one outer quote pair.
    const args = WIN ? ["/d", "/s", "/c", `"${executed}"`] : ["-lc", executed];
    try {
      fs.mkdirSync(path.join(dir, ".tmp"), { recursive: true });
    } catch {
      /* best effort */
    }
    const child = spawn(shell, args, {
      cwd: workdir,
      windowsHide: true,
      windowsVerbatimArguments: WIN,
      env: {
        ...process.env,
        CI: "1",
        FORCE_COLOR: "0",
        FRIDAY_SANDBOX: "1",
        FRIDAY_SANDBOX_PROJECT: id,
        FRIDAY_SANDBOX_DIR: dir,
        FRIDAY_SANDBOX_ENGINE: engineId,
        FRIDAY_SANDBOX_ISOLATED: isolated ? "1" : "0",
        TMP: path.join(dir, ".tmp"),
        TEMP: path.join(dir, ".tmp"),
      },
    });

    running.set(jobId, child);

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      running.delete(jobId);
      const payload = {
        ...result,
        runId: jobId,
        projectId: id,
        command: line,
        engine: engineId,
        isolated,
        warning: isolated ? null : selected?.warning || null,
        ms: Date.now() - started,
      };
      appendLog(root, id, `${output}\n[exit ${result.code ?? "?"} · ${payload.ms}ms]\n`);
      pushHistory(root, {
        kind: "run",
        projectId: id,
        detail: `${line} · ${engineId}`,
        ok: payload.ok,
        ms: payload.ms,
      });
      emit({ ...payload, phase: "done" });
      resolve(payload);
    };

    const timer = setTimeout(() => {
      try {
        if (WIN) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ ok: false, timedOut: true, output: `${output}\ntimed out after ${timeoutMs}ms` });
    }, timeoutMs);

    const consume = (chunk) => {
      const text = engines.decodeOutput(chunk);
      output += text;
      if (output.length > 200000) output = output.slice(-200000);
      emit({ runId: jobId, projectId: id, phase: "output", line: text });
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.on("error", (error) => finish({ ok: false, output: `${output}\n${error.message}` }));
    child.on("close", (code) => finish({ ok: code === 0, code, output }));
  });
}

function cancelRun(runId) {
  const child = running.get(runId);
  if (!child) return { ok: false, error: "That run already finished." };
  try {
    if (WIN) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  running.delete(runId);
  return { ok: true };
}

function activeRuns() {
  return [...running.keys()];
}

/* ------------------------------------------------ diff / approve / apply */

const APPLY_SKIP = new Set([...sandbox.SKIP, ".tmp", "sandbox"]);

function fileList(dir) {
  const out = new Map();
  const walk = (current, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (APPLY_SKIP.has(entry.name)) continue;
      const relative = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile()) out.set(relative, full);
    }
  };
  walk(dir, "");
  return out;
}

const readSafe = (file) => {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
};

/**
 * Exact proposed changes between a sandbox project and the real FRIDAY source.
 * Nothing is written — this is the preview the owner approves.
 */
function diffToSource(root, id, sourceRoot) {
  if (!sourceRoot || !fs.existsSync(sourceRoot)) {
    return { ok: false, error: "The FRIDAY source project could not be located." };
  }
  const dir = projectDir(root, id);
  if (!fs.existsSync(dir)) return { ok: false, error: "Unknown sandbox project." };

  const sandboxFiles = fileList(dir);
  const sourceFiles = fileList(sourceRoot);
  const changes = [];
  for (const [rel, full] of sandboxFiles) {
    const sandboxBuf = readSafe(full);
    if (!sandboxBuf) continue;
    const sourceFile = sourceFiles.get(rel);
    const sourceBuf = sourceFile ? readSafe(sourceFile) : null;
    if (sourceBuf && sourceBuf.equals(sandboxBuf)) continue;
    const text = sandboxBuf.length < 400000 && !sandboxBuf.includes(0);
    changes.push({
      path: rel,
      status: sourceBuf ? "modified" : "added",
      bytes: sandboxBuf.length,
      sandboxHash: hash(sandboxBuf),
      sourceHash: sourceBuf ? hash(sourceBuf) : null,
      preview: text ? sandboxBuf.toString("utf8").slice(0, 4000) : "(binary file)",
      current:
        sourceBuf && sourceBuf.length < 400000 && !sourceBuf.includes(0)
          ? sourceBuf.toString("utf8").slice(0, 4000)
          : null,
    });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, sourceRoot, projectDir: dir, changes };
}

/**
 * Apply approved files from a sandbox project into the real FRIDAY source.
 * Every replaced/created file is backed up first so `rollbackApply` can
 * restore the exact previous state.
 */
function applyToSource(root, id, sourceRoot, files = [], { note = "", expect = null } = {}) {
  const preview = diffToSource(root, id, sourceRoot);
  if (!preview.ok) return preview;
  const wanted = new Set((files || []).map(String));
  const selected = preview.changes.filter((c) => wanted.size === 0 || wanted.has(c.path));
  if (!selected.length) return { ok: false, error: "No approved changes to apply." };

  // Refuse conflicting duplicates: the source must still match what the owner
  // reviewed, otherwise the preview is stale.
  // `expect` is the source hash map the owner actually reviewed. When it is
  // provided, any file that moved since then is refused instead of silently
  // overwriting a newer change.
  const stale = expect
    ? selected.filter((c) => {
        if (!(c.path in expect)) return false;
        const buf = readSafe(path.join(sourceRoot, c.path));
        const currentHash = buf ? hash(buf) : null;
        return currentHash !== (expect[c.path] ?? null);
      })
    : [];
  if (stale.length) {
    return {
      ok: false,
      stale: stale.map((s) => s.path),
      error: "The FRIDAY source changed since this preview — review the changes again.",
    };
  }

  const applyId = `apply-${Date.now().toString(36)}`;
  const backupDir = path.join(paths(root).backups, applyId);
  const applied = [];
  try {
    for (const change of selected) {
      const target = path.join(sourceRoot, change.path);
      const backup = path.join(backupDir, change.path);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      if (fs.existsSync(target)) fs.copyFileSync(target, backup);
      else fs.writeFileSync(`${backup}.__absent__`, "", "utf8");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(projectDir(root, id), change.path), target);
      applied.push(change.path);
    }
  } catch (error) {
    const record = { applyId, projectId: id, sourceRoot, files: applied, backupDir, failed: true };
    rollbackApply(root, record);
    return { ok: false, error: String(error.message || error), rolledBack: true };
  }

  const record = {
    applyId,
    projectId: id,
    sourceRoot,
    files: applied,
    backupDir,
    note,
    at: Date.now(),
  };
  writeJson(path.join(backupDir, "apply.json"), record);
  pushHistory(root, {
    kind: "apply",
    projectId: id,
    detail: `${applied.length} file(s)`,
    applyId,
    files: applied,
  });
  return { ok: true, ...record };
}

/** Restore every file of one apply from its backup. */
function rollbackApply(root, record) {
  const info =
    typeof record === "string"
      ? readJson(path.join(paths(root).backups, record, "apply.json"), null)
      : record;
  if (!info) return { ok: false, error: "That apply has no backup on disk." };
  const restored = [];
  for (const rel of info.files || []) {
    const target = path.join(info.sourceRoot, rel);
    const backup = path.join(info.backupDir, rel);
    try {
      if (fs.existsSync(backup)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(backup, target);
      } else if (fs.existsSync(`${backup}.__absent__`)) {
        fs.rmSync(target, { force: true });
      }
      restored.push(rel);
    } catch {
      /* keep restoring the rest */
    }
  }
  pushHistory(root, {
    kind: "rollback",
    projectId: info.projectId,
    applyId: info.applyId,
    detail: `${restored.length} file(s)`,
  });
  return { ok: true, restored };
}

function listApplies(root) {
  const dir = paths(root).backups;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
  return entries
    .map((e) => readJson(path.join(dir, e.name, "apply.json"), null))
    .filter(Boolean)
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

/**
 * Approve → apply → regression → automatic rollback when the regression fails.
 * `verify` is the existing sandbox verifier, so no second implementation.
 */
async function applyAndVerify(
  root,
  { id, sourceRoot, files = [], note = "", expect = null } = {},
  onProgress = () => {},
) {
  onProgress({ step: "Applying approved changes" });
  const applied = applyToSource(root, id, sourceRoot, files, { note, expect });
  if (!applied.ok) return applied;

  onProgress({ step: "Running the full regression pass" });
  let regression = { ok: false, checks: [], error: "regression did not run" };
  try {
    regression = await sandbox.verify({ root: sourceRoot, onProgress });
  } catch (error) {
    regression = { ok: false, checks: [], error: String(error.message || error) };
  }

  if (!regression.ok) {
    onProgress({ step: "Regression failed — rolling back" });
    const rolled = rollbackApply(root, applied);
    return {
      ok: false,
      applied,
      regression,
      rolledBack: rolled.ok,
      error: regression.error || "Regression tests failed; the changes were rolled back.",
    };
  }
  pushHistory(root, {
    kind: "verified",
    projectId: id,
    applyId: applied.applyId,
    detail: "regression passed",
  });
  return { ok: true, applied, regression };
}

/* ------------------------------------------------------------------ misc */

function config(root) {
  return {
    defaultTemplate: "node",
    keepLogs: true,
    // Isolation used when a project does not pick its own engine.
    engine: "auto",
    network: false,
    image: null,
    ...readJson(paths(root).config, {}),
  };
}

/** The engine a project runs under: its own choice, else auto-select. */
function engineFor(root, id) {
  const entry = loadRegistry(root).find((p) => p.id === id);
  if (entry?.engine && entry.engine !== "auto") return entry.engine;
  const cfg = config(root).engine;
  if (cfg && cfg !== "auto") return cfg;
  return "auto";
}

function allowEngineInstall() {
  return !process.env.VITEST;
}

function commandLooksLikePython(line) {
  const first = String(line || "")
    .trim()
    .replace(/^"+|"+$/g, "")
    .split(/[\s"]/)[0];
  const base = String(first || "")
    .split(/[/\\]/)
    .pop();
  return /^(python\d*|py)(\.exe)?$/i.test(base || "");
}

async function resolveCommandEngine(root, id, options = {}) {
  if (options.engine) return { engineId: options.engine, source: "request" };
  const chosen = engineFor(root, id);
  if (chosen && chosen !== "auto") return { engineId: chosen, source: "project" };
  const selected = await engines.ensureSelected({ allowInstall: allowEngineInstall() });
  return { engineId: selected.id, source: "auto", selected };
}

/** Pick the isolation engine for one project (persisted with the project). */
function setProjectEngine(root, id, engineId) {
  const known = engines.catalog().some((e) => e.id === engineId);
  if (!known) return { ok: false, error: `Unknown sandbox engine "${engineId}".` };
  if (engineId === "windows-sandbox") {
    const edition = engines.lastEdition();
    if (!engines.windowsSandboxSupported(edition || { windowsSandboxEligible: false })) {
      return { ok: false, error: engines.WINDOWS_SANDBOX_HOME_MESSAGE };
    }
  }
  const registry = loadRegistry(root);
  const entry = registry.find((p) => p.id === id);
  if (!entry) return { ok: false, error: "Unknown sandbox project." };
  entry.engine = engineId;
  entry.updatedAt = Date.now();
  saveRegistry(root, registry);
  pushHistory(root, { kind: "engine", projectId: id, detail: engineId });
  return { ok: true, project: describe(root, entry) };
}

function setConfig(root, patch) {
  const next = { ...config(root), ...(patch || {}) };
  writeJson(paths(root).config, next);
  return next;
}

function summary(root, sourceRoot) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  ensureDirs(root);
  const projects = loadRegistry(root).map((entry) => describe(root, entry));
  return {
    ok: true,
    base: paths(root).base,
    sourceRoot: sourceRoot || null,
    projects,
    history: historyOf(root).slice(0, 60),
    applies: listApplies(root).slice(0, 30),
    active: activeRuns(),
    config: config(root),
    tmp: os.tmpdir(),
  };
}

module.exports = {
  paths,
  detectRuntime,
  installRuntime,
  engineFor,
  setProjectEngine,
  detectEngines: engines.detect,
  installEngine: engines.install,
  launchEngine: engines.launch,
  startEngineService: engines.startService,
  ensureEngineReady: engines.ensureReady,
  wrapForEngine: engines.wrap,
  resolveCommandEngine,
  ensureSelectedEngine: engines.ensureSelected,
  listProjects,
  createProject,
  removeProject,
  importFolder,
  listFiles,
  planProjectChecks,
  readFile,
  writeFile,
  deleteFile,
  runCommand,
  cancelRun,
  activeRuns,
  diffToSource,
  applyToSource,
  applyAndVerify,
  rollbackApply,
  listApplies,
  readLog,
  historyOf,
  config,
  setConfig,
  summary,
  TEMPLATES,
  RUNTIME,
  safeJoin,
};
