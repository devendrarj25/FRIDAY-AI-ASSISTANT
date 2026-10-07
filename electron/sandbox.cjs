// FRIDAY · sandbox verification.
//
// Before a self-change is adopted, FRIDAY copies the project into an isolated
// folder and runs the real checks there (typecheck + tests, and a Python
// syntax pass when the kernel changed). Nothing in the live install is touched
// while the sandbox runs, so a bad change can never take FRIDAY down.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const engines = require("./sandbox-engines.cjs");

const WIN = process.platform === "win32";

// Never copied into a sandbox: heavy, regenerable or user data.
const SKIP = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "runtime",
  "release",
  "dist",
  "dist-electron",
  "electron-release",
  "backups",
  "backup",
  "updates",
  "temporary",
  "database",
  "memory",
  "conversations",
  "debug",
  "logs",
]);

function copyProject(root, target) {
  fs.mkdirSync(target, { recursive: true });
  let files = 0;
  const walk = (dir, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const from = path.join(dir, entry.name);
      const to = path.join(target, rel, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        walk(from, path.join(rel, entry.name));
      } else if (entry.isFile()) {
        try {
          fs.copyFileSync(from, to);
          files += 1;
        } catch {
          /* locked file — skipped, the check below still runs */
        }
      }
    }
  };
  walk(root, "");
  return files;
}

/** Reuse the real dependency tree instead of a multi-minute install. */
function linkModules(root, target) {
  const source = path.join(root, "node_modules");
  if (!fs.existsSync(source)) return false;
  const link = path.join(target, "node_modules");
  try {
    fs.symlinkSync(source, link, WIN ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

/**
 * .cmd/.bat (and the npm family, which are .cmd shims) cannot be spawned
 * directly on Windows. A real executable such as git must NOT go through
 * cmd.exe: the shell joins argv with spaces and splits a commit message.
 */
function commandNeedsWindowsShell(command) {
  const base = path.basename(String(command || "")).toLowerCase();
  return (
    base === "npm" ||
    base === "npx" ||
    base === "yarn" ||
    base === "pnpm" ||
    base.endsWith(".cmd") ||
    base.endsWith(".bat")
  );
}

function run(command, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let output = "";
    let done = false;
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: WIN && commandNeedsWindowsShell(command),
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        if (WIN) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve({ ok: false, timedOut: true, output: `${output}\ntimed out after ${timeoutMs}ms` });
    }, timeoutMs);
    const consume = (chunk) => {
      output += engines.decodeOutput(chunk);
      if (output.length > 20000) output = output.slice(-20000);
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, output: `${output}\n${error.message}` });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output });
    });
  });
}

function scriptsOf(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts || {};
  } catch {
    return {};
  }
}

/** Is a real executable for `cmd` on PATH? Used to tell "failed" from "missing". */
async function hasTool(cmd, cwd) {
  const probe = await run(WIN ? "where" : "which", [cmd], cwd, 8000);
  return Boolean(probe.ok && String(probe.output || "").trim());
}

/** A locally installed node CLI (node_modules/.bin) beats a global one. */
function localBin(dir, name) {
  const bin = path.join(dir, "node_modules", ".bin", WIN ? `${name}.cmd` : name);
  return fs.existsSync(bin) ? bin : null;
}

const MISSING = (tool, why) =>
  `${tool} is not installed — open Install Manager and install ${tool} so this check can run. (${why})`;

/**
 * Verify the current workspace contents in isolation.
 * @returns {{ ok:boolean, dir:string|null, checks:{id:string,label:string,ok:boolean,detail:string}[] }}
 */
async function verify({ root, areas = [], onProgress = () => {} } = {}) {
  if (!root || !fs.existsSync(root)) {
    return { ok: false, dir: null, checks: [], error: "No FRIDAY workspace is selected." };
  }
  const dir = path.join(root, "temporary", `sandbox-${Date.now().toString(36)}`);
  const checks = [];
  try {
    onProgress({ step: "Cloning project into the sandbox" });
    const copied = copyProject(root, dir);
    checks.push({
      id: "clone",
      label: "Isolated clone",
      ok: copied > 0,
      detail: `${copied} file(s) copied to ${dir}`,
    });
    const linked = linkModules(root, dir);

    const scripts = scriptsOf(dir);
    if (!linked) {
      checks.push({
        id: "deps",
        label: "Dependencies",
        ok: false,
        detail: "node_modules could not be linked — install dependencies before verifying.",
      });
    } else {
      if (scripts.typecheck) {
        onProgress({ step: "Typechecking in the sandbox" });
        const result = await run("npm", ["run", "typecheck"], dir, 6 * 60 * 1000);
        checks.push({
          id: "typecheck",
          label: "Typecheck",
          ok: result.ok,
          detail: result.ok ? "no type errors" : result.output.slice(-1200),
        });
      }
      // Lint with the repository's own ESLint setup. A configured lint script
      // with no ESLint present is reported honestly instead of being skipped.
      if (scripts.lint) {
        const eslint = localBin(dir, "eslint") || (await hasTool("eslint", dir));
        if (!eslint) {
          checks.push({
            id: "lint",
            label: "Lint (ESLint)",
            ok: false,
            detail: MISSING("ESLint", "package.json defines a lint script"),
          });
        } else {
          onProgress({ step: "Linting in the sandbox" });
          const result = await run("npm", ["run", "lint"], dir, 6 * 60 * 1000);
          checks.push({
            id: "lint",
            label: "Lint (ESLint)",
            ok: result.ok,
            detail: result.ok ? "no lint errors" : result.output.slice(-1200),
          });
        }
      }
      if (scripts.test) {
        const vitest = localBin(dir, "vitest") || (await hasTool("vitest", dir));
        if (!vitest) {
          checks.push({
            id: "tests",
            label: "Test suite",
            ok: false,
            detail: MISSING("Vitest", "package.json defines a test script"),
          });
        } else {
          onProgress({ step: "Running tests in the sandbox" });
          const result = await run("npm", ["test", "--", "--run"], dir, 10 * 60 * 1000);
          checks.push({
            id: "tests",
            label: "Test suite",
            ok: result.ok,
            detail: result.ok ? "all tests passed" : result.output.slice(-1200),
          });
        }
      }
    }

    if (areas.includes("kernel")) {
      const python =
        (await hasTool(WIN ? "python" : "python3", dir)) || (await hasTool("python", dir));
      if (!python) {
        checks.push({
          id: "kernel",
          label: "Kernel syntax",
          ok: false,
          detail: MISSING("Python", "the change touches the Python kernel"),
        });
      } else {
        onProgress({ step: "Compiling the Python kernel" });
        const result = await run(
          "python",
          ["-m", "compileall", "-q", "kernel"],
          dir,
          3 * 60 * 1000,
        );
        checks.push({
          id: "kernel",
          label: "Kernel syntax",
          ok: result.ok,
          detail: result.ok ? "kernel compiles" : result.output.slice(-800),
        });

        // Real Python lint, when Ruff is available. Its absence is stated in the
        // report — never silently dropped — with the way to fix it.
        if (await hasTool("ruff", dir)) {
          onProgress({ step: "Linting the kernel with Ruff" });
          const lint = await run("ruff", ["check", "kernel"], dir, 3 * 60 * 1000);
          checks.push({
            id: "kernel-lint",
            label: "Kernel lint (Ruff)",
            ok: lint.ok,
            detail: lint.ok ? "no lint errors" : lint.output.slice(-1000),
          });
        } else {
          checks.push({
            id: "kernel-lint",
            label: "Kernel lint (Ruff)",
            ok: true,
            skipped: true,
            detail:
              "Ruff is not installed — install it in Install Manager to add Python lint cover",
          });
        }

        // The kernel ships its own pytest suite; if it exists it must really run.
        if (fs.existsSync(path.join(dir, "kernel", "tests"))) {
          if (await hasTool("pytest", dir)) {
            onProgress({ step: "Running kernel tests (pytest)" });
            const py = await run("pytest", ["-q", "kernel/tests"], dir, 10 * 60 * 1000);
            checks.push({
              id: "kernel-tests",
              label: "Kernel tests (pytest)",
              ok: py.ok,
              detail: py.ok ? "all kernel tests passed" : py.output.slice(-1200),
            });
          } else {
            checks.push({
              id: "kernel-tests",
              label: "Kernel tests (pytest)",
              ok: false,
              detail: MISSING("pytest", "kernel/tests exists and must be verified"),
            });
          }
        }
      }
    }

    const selected = await engines.ensureSelected({ allowInstall: false });
    const ok = checks.every((c) => c.ok);
    return {
      ok,
      dir,
      checks,
      engine: {
        id: selected.id,
        isolated: selected.isolated,
        detail: selected.detail,
        warning: selected.warning || null,
      },
    };
  } catch (error) {
    return { ok: false, dir, checks, error: String(error.message || error) };
  } finally {
    // The clone is disposable; the report is what matters.
    try {
      fs.rmSync(path.join(dir, "node_modules"), { force: true, recursive: false });
    } catch {
      /* junction already gone */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* left behind under temporary/ — cleaned on the next run */
    }
  }
}

/**
 * Run a piece of code in isolation.
 *
 * Used by the skill forge before a skill is ever installed, by FRIDAY when she
 * writes code for herself, and by the manual "run in sandbox" action. The code
 * gets its own throwaway folder under temporary/processing, a hard timeout and
 * — unless explicitly allowed — no network.
 *
 * @returns {Promise<{ok:boolean, output:string, dir:string, timedOut?:boolean, ms:number}>}
 */
async function runIsolated({
  root,
  code,
  language = "node",
  input = null,
  timeoutMs = 30000,
  allowNetwork = false,
  keepDir = false,
  extraBinds = [],
} = {}) {
  const started = Date.now();
  if (!root) return { ok: false, output: "No FRIDAY workspace is selected.", dir: "", ms: 0 };
  if (!code || !String(code).trim())
    return { ok: false, output: "No code to run.", dir: "", ms: 0 };

  const dir = path.join(root, "temporary", "processing", `run-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  const python = language === "python";
  const file = path.join(dir, python ? "main.py" : "main.mjs");
  fs.writeFileSync(file, String(code), "utf8");
  if (input !== null && input !== undefined) {
    fs.writeFileSync(path.join(dir, "input.json"), JSON.stringify(input), "utf8");
  }

  const env = {
    ...process.env,
    CI: "1",
    FORCE_COLOR: "0",
    FRIDAY_SANDBOX: "1",
    FRIDAY_SANDBOX_DIR: dir,
    ...(allowNetwork
      ? {}
      : { HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "" }),
  };

  let selected = await engines.ensureSelected({ allowInstall: false });
  const commandEngine = engines.engineForCommand(selected.id, { python });
  if (commandEngine !== selected.id) {
    selected = {
      ...selected,
      id: commandEngine,
      isolated: false,
      detail: "guarded process in the project folder",
    };
  }
  env.FRIDAY_SANDBOX_ENGINE = selected.id;
  env.FRIDAY_SANDBOX_ISOLATED = engines.isOsIsolated(selected.id) ? "1" : "0";
  const fileName = python ? "main.py" : "main.mjs";
  const useContainer = selected.id === "docker" || selected.id === "podman";
  const isolatedRun = engines.isOsIsolated(selected.id);
  let usedEngine = selected.id;
  let isolated = isolatedRun;
  let wrapNote = isolatedRun ? selected.detail : selected.warning || "no OS isolation engine ready";

  let result;
  if (isolatedRun) {
    const inner = python
      ? useContainer
        ? `python3 ${fileName}`
        : `python ${fileName}`
      : useContainer
        ? `node ${fileName}`
        : `${process.execPath.replace(/"/g, "")} ${fileName}`;
    const wrapped = engines.wrap(selected.id, {
      command: inner,
      dir,
      network: allowNetwork,
      extraBinds: [root, ...(Array.isArray(extraBinds) ? extraBinds : [])],
      image: python && useContainer ? "python:3.12-alpine" : undefined,
    });
    if (wrapped.ok) {
      usedEngine = wrapped.engine;
      isolated = Boolean(wrapped.isolated);
      wrapNote = wrapped.note;
      const shell = WIN ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
      const args = WIN ? ["/d", "/s", "/c", `"${wrapped.line}"`] : ["-lc", wrapped.line];
      result = await new Promise((resolve) => {
        let output = "";
        let done = false;
        const child = spawn(shell, args, {
          cwd: dir,
          windowsHide: true,
          windowsVerbatimArguments: WIN,
          shell: false,
          env: python ? env : { ...env, ELECTRON_RUN_AS_NODE: "1" },
        });
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          try {
            if (WIN)
              spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
            else child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          resolve({
            ok: false,
            timedOut: true,
            output: `${output}\ntimed out after ${timeoutMs}ms`,
          });
        }, timeoutMs);
        const consume = (chunk) => {
          output += engines.decodeOutput(chunk);
          if (output.length > 20000) output = output.slice(-20000);
        };
        child.stdout?.on("data", consume);
        child.stderr?.on("data", consume);
        child.on("error", (error) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ ok: false, output: `${output}\n${error.message}` });
        });
        child.on("close", (exit) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ ok: exit === 0, code: exit, output });
        });
      });
    } else {
      usedEngine = "process";
      isolated = false;
      wrapNote = wrapped.error || "engine could not wrap this command; ran unisolated";
    }
  }

  // Windows container mode and a WSL install with no distribution both answer
  // their probe and then cannot run the command. Use the guarded process.
  if (
    result &&
    !result.ok &&
    /no matching manifest for windows|no installed distributions/i.test(result.output || "")
  ) {
    usedEngine = "process";
    isolated = false;
    wrapNote =
      "Docker is in Windows container mode and cannot run Linux images; ran in the guarded process.";
    result = null;
  }

  if (!result) {
    result = await new Promise((resolve) => {
      let output = "";
      let done = false;
      const child = spawn(python ? "python" : process.execPath, [file], {
        cwd: dir,
        windowsHide: true,
        shell: false,
        env: python ? env : { ...env, ELECTRON_RUN_AS_NODE: "1" },
      });
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try {
          if (WIN)
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
          else child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve({ ok: false, timedOut: true, output: `${output}\ntimed out after ${timeoutMs}ms` });
      }, timeoutMs);
      const consume = (chunk) => {
        output += engines.decodeOutput(chunk);
        if (output.length > 20000) output = output.slice(-20000);
      };
      child.stdout?.on("data", consume);
      child.stderr?.on("data", consume);
      child.on("error", (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, output: `${output}\n${error.message}` });
      });
      child.on("close", (exit) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: exit === 0, code: exit, output });
      });
    });
  }

  let resultJson = null;
  try {
    const raw = fs.readFileSync(path.join(dir, "result.json"), "utf8");
    resultJson = JSON.parse(raw);
  } catch {
    /* the run does not have to write a result file */
  }

  if (!keepDir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* cleaned on the next run */
    }
  }

  return {
    ...result,
    result: resultJson,
    dir,
    ms: Date.now() - started,
    engine: usedEngine,
    isolated,
    warning: isolated ? null : wrapNote || selected.warning || null,
  };
}

module.exports = {
  verify,
  copyProject,
  runIsolated,
  SKIP,
  runCommand: run,
  commandNeedsWindowsShell,
};
