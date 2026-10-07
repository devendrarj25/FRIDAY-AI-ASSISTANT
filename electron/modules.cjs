// FRIDAY · catalog module runtime.
//
// Discovery is capabilities.list() (tree === modules). Each pack is
// manifest.json + Python register/run/self_test. Shipped packs run from
// appRoot via the same Python interpreter the kernel uses; workspace /
// forged / imported packs use the same harness rooted at the workspace.
// Enable is the existing capabilities.json override — no copy required —
// and the same switch also calls kernel `module.toggle` so the Python
// registry matches the desktop state.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const capabilities = require("./capabilities.cjs");
const { resolvePython } = require("./python.cjs");

function isRoots(value) {
  return Boolean(
    value && typeof value === "object" && (value.appRoot || value.workspaceRoot || value.root),
  );
}

function normalizeRoots(rootOrRoots) {
  if (isRoots(rootOrRoots)) {
    return {
      appRoot: rootOrRoots.appRoot || null,
      workspaceRoot: rootOrRoots.workspaceRoot || rootOrRoots.root || null,
    };
  }
  return { appRoot: null, workspaceRoot: rootOrRoots || null };
}

function list(rootOrRoots) {
  const roots = normalizeRoots(rootOrRoots);
  const report = capabilities.list(roots);
  const modules = (report.items || []).filter((item) => item.tree === "modules").map(withRunnable);
  return { ok: true, modules };
}

function find(rootOrRoots, id) {
  const wanted = String(id || "");
  if (!wanted) return null;
  const { modules } = list(rootOrRoots);
  return (
    modules.find((item) => item.id === wanted) ||
    modules.find((item) => item.id.endsWith(`/${wanted}`)) ||
    null
  );
}

function entryFile(item) {
  if (!item || !item.path) return null;
  const declared = item.entry ? path.join(item.path, item.entry) : null;
  if (declared && fs.existsSync(declared) && fs.statSync(declared).isFile()) return declared;
  for (const name of ["main.py", "module.py", "index.py"]) {
    const file = path.join(item.path, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

function inspectPythonInputs(file) {
  if (!file) return [];
  try {
    const src = fs.readFileSync(file, "utf8");
    const match = src.match(/async\s+def\s+run\s*\(([^)]*)\)/);
    if (!match) return [];
    return match[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.split("=")[0].split(":")[0].trim())
      .filter((name) => name && name !== "self" && name !== "tools" && !name.startsWith("*"));
  } catch {
    return [];
  }
}

function inferRisk(item) {
  const explicit = String((item && item.risk) || "safe");
  if (explicit === "write" || explicit === "exec") return explicit;
  const perms = Array.isArray(item && item.permissions) ? item.permissions.map(String) : [];
  if (perms.some((perm) => /shell\.|process\.|exec|\.cmd/i.test(perm))) return "exec";
  if (perms.some((perm) => /fs\.write/i.test(perm))) return "write";
  return "safe";
}

function withRunnable(item) {
  const file = entryFile(item);
  const inspected = inspectPythonInputs(file);
  const inputs =
    Array.isArray(item.inputs) && item.inputs.length ? item.inputs.map(String) : inspected;
  return {
    ...item,
    runnable: Boolean(file),
    inputs,
    risk: inferRisk(item),
  };
}

function asRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...value };
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { prompt: String(value) };
  }
  return {};
}

function valueToText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const lastOk = [...value]
      .reverse()
      .find((item) => item && typeof item === "object" && item.ok !== false && item.value != null);
    if (lastOk) return valueToText(lastOk.value);
    if (value.length && (typeof value[0] === "string" || typeof value[0] === "number")) {
      return value.map(String).join("\n");
    }
    return "";
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.folder === "string") return value.folder;
    if (typeof value.path === "string") return value.path;
    if (typeof value.content === "string") return value.content;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function previousText(input) {
  if (!input || input.previous == null || input.previous === "") return "";
  return valueToText(input.previous);
}

function extractUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0] : "";
}

function looksLikePath(text) {
  const value = String(text || "").trim();
  if (!value || value.length > 400 || extractUrl(value) || /[\n\r]/.test(value)) return false;
  if (value === "." || value === "..") return true;
  return /[\\/]/.test(value) || /\.[a-z0-9]{1,8}$/i.test(value);
}

function missing(input, key) {
  return input[key] == null || input[key] === "";
}

function declaredInputs(item) {
  return new Set(Array.isArray(item && item.inputs) ? item.inputs.map(String) : []);
}

/**
 * Chat and Test selected often send `{ prompt }`. Packs read `path`, `folder`,
 * `url`, `left`/`right`. Fill only missing declared keys. Never set apply=true
 * from a prompt — write packs stay dry-run unless the caller asked.
 */
function enrichInput(item, raw, workspaceRoot) {
  const input = asRecord(raw);
  const declared = declaredInputs(item);
  const prompt = input.prompt != null && input.prompt !== "" ? String(input.prompt) : "";
  const fromPrev = previousText(input);
  const source = fromPrev || prompt;

  if (missing(input, "prompt") && source) input.prompt = source;

  if (source) {
    const url = extractUrl(prompt || source);
    if (url && declared.has("url") && missing(input, "url")) input.url = url;

    const pathHint = looksLikePath(prompt)
      ? prompt.trim()
      : looksLikePath(source)
        ? String(source).trim()
        : "";
    for (const key of ["path", "folder", "file", "left", "right", "dest"]) {
      if (pathHint && declared.has(key) && missing(input, key)) input[key] = pathHint;
    }
  }

  if (declared.has("folder") && missing(input, "folder")) input.folder = ".";
  if (workspaceRoot && missing(input, "root")) input.root = workspaceRoot;
  if (input.apply !== undefined) input.apply = input.apply === true || input.apply === "true";
  return input;
}

function pythonHarness(entryFile, workspaceRoot, kwargs, permissions) {
  return `import asyncio, importlib.util, inspect, json, os, subprocess, sys
from pathlib import Path

ENTRY = ${JSON.stringify(entryFile)}
WORKSPACE = Path(${JSON.stringify(workspaceRoot)}).resolve()
KWARGS = json.loads(${JSON.stringify(JSON.stringify(kwargs || {}))})
ALLOWED = set(${JSON.stringify(Array.isArray(permissions) ? permissions : [])})
OUT = Path("result.json")

class WorkspaceTools:
    def __init__(self, root):
        self.workspace = Path(root).resolve()
        self.root = self.workspace

    def _jail(self, rel):
        raw = Path(str(rel if rel not in (None, "") else "."))
        target = raw if raw.is_absolute() else (self.workspace / raw)
        target = target.resolve()
        try:
            target.relative_to(self.workspace)
        except ValueError:
            raise PermissionError("path escapes workspace")
        return target

    def _allowed(self, name):
        if name == "fs.read":
            return "fs.read" in ALLOWED or "fs.write" in ALLOWED
        if name == "fs.write":
            return "fs.write" in ALLOWED
        if name == "git" or name.startswith("git."):
            return "git" in ALLOWED or name in ALLOWED
        if name in ("shell.cmd", "shell", "process.exec"):
            return any(item in ALLOWED for item in ("shell.cmd", "shell", "process.exec"))
        return name in ALLOWED

    async def execute(self, name, payload=None, **kwargs):
        payload = payload if isinstance(payload, dict) else {}
        if not self._allowed(name):
            return {"ok": False, "error": f"{name} is not in this module's permissions"}
        try:
            if name == "fs.read":
                target = self._jail(payload.get("path", "."))
                if not target.exists():
                    return {"ok": False, "error": "missing"}
                if target.is_dir():
                    return {
                        "ok": True,
                        "entries": sorted(p.name for p in target.iterdir()),
                        "path": str(target),
                    }
                if not target.is_file():
                    return {"ok": False, "error": "missing"}
                return {
                    "ok": True,
                    "path": str(target),
                    "content": target.read_text(encoding="utf-8", errors="replace"),
                }
            if name == "fs.write":
                target = self._jail(payload.get("path"))
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(str(payload.get("content") or ""), encoding="utf-8")
                return {"ok": True, "path": str(target)}
            if name == "git" or name.startswith("git."):
                args = [str(item) for item in (payload.get("args") or [])]
                if name.startswith("git.") and name != "git":
                    args = [name.split(".", 1)[1], *args]
                jailed = []
                skip_next_jail = False
                for i, arg in enumerate(args):
                    if skip_next_jail:
                        jailed.append(str(self._jail(arg)))
                        skip_next_jail = False
                        continue
                    if arg in ("-C", "--git-dir", "--work-tree"):
                        jailed.append(arg)
                        skip_next_jail = True
                        continue
                    jailed.append(arg)
                proc = subprocess.run(
                    ["git", *jailed],
                    cwd=str(self.workspace),
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                return {
                    "ok": proc.returncode == 0,
                    "stdout": proc.stdout,
                    "stderr": proc.stderr,
                    "code": proc.returncode,
                    **({"error": (proc.stderr or proc.stdout or "git failed").strip()} if proc.returncode else {}),
                }
            return {"ok": False, "error": f"unknown tool {name}"}
        except PermissionError as exc:
            return {"ok": False, "error": str(exc)}
        except FileNotFoundError as exc:
            return {"ok": False, "error": str(exc)}
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "git timed out"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

spec = importlib.util.spec_from_file_location("friday_module_pack", ENTRY)
if spec is None or spec.loader is None:
    raise SystemExit("bad module entry")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
fn = getattr(mod, "run", None)
if fn is None:
    raise SystemExit("module does not define run()")
register = getattr(mod, "register", None)
if callable(register):
    register({"name": Path(ENTRY).parent.name, "entry": Path(ENTRY).name})

sig = inspect.signature(fn)
call = {}
missing = []
for param in sig.parameters.values():
    if param.name in ("self", "tools"):
        continue
    if param.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
        continue
    if param.name in KWARGS:
        call[param.name] = KWARGS[param.name]
    elif param.default is inspect.Parameter.empty:
        missing.append(param.name)
if missing:
    OUT.write_text(json.dumps({"ok": False, "error": "missing required input: " + ", ".join(missing)}), encoding="utf-8")
    sys.exit(0)

tools = WorkspaceTools(WORKSPACE)
value = asyncio.run(fn(tools, **call))
OUT.write_text(json.dumps({"ok": True, "value": value}, default=str), encoding="utf-8")
print("module finished")
`;
}

async function pythonExecutable(workspaceRoot) {
  try {
    const found = await resolvePython(workspaceRoot || null);
    if (found && found.executable) return found.executable;
  } catch {
    /* PATH fallback below */
  }
  return process.platform === "win32" ? "python" : "python3";
}

function runProcess(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let output = "";
    let done = false;
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      shell: false,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve({ ok: false, timedOut: true, output: `${output}\ntimed out after ${timeoutMs}ms` });
    }, timeoutMs);
    const consume = (chunk) => {
      output += String(chunk);
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

async function invokePython(item, args, workspaceRoot, appRoot) {
  const file = entryFile(item);
  if (!file) return { ok: false, error: "This module has no main.py to run." };
  const root = workspaceRoot || appRoot || path.dirname(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-mod-"));
  const harnessFile = path.join(dir, "harness.py");
  fs.writeFileSync(
    harnessFile,
    pythonHarness(file, root, args || {}, item.permissions || []),
    "utf8",
  );
  try {
    const py = await pythonExecutable(appRoot || workspaceRoot);
    const result = await runProcess(py, [harnessFile], dir, 60000);
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
    } catch {
      parsed = null;
    }
    if (parsed && parsed.ok === false) {
      return { ok: false, error: String(parsed.error || "module failed"), value: parsed };
    }
    if (!result.ok) {
      return {
        ok: false,
        error: String(result.output || result.error || "module failed").slice(-1200),
      };
    }
    const value =
      parsed && Object.prototype.hasOwnProperty.call(parsed, "value") ? parsed.value : parsed;
    if (value && typeof value === "object" && value.ok === false) {
      return { ok: false, error: String(value.error || "module failed"), value };
    }
    return { ok: true, value };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* cleaned on the next run */
    }
  }
}

async function invoke(rootOrRoots, id, input = {}, ctx = {}) {
  const started = Date.now();
  const roots = normalizeRoots(rootOrRoots);
  const item = find(roots, id);
  if (!item) return { ok: false, id, error: "Module not found.", ms: Date.now() - started };
  if (!item.enabled && !ctx.allowDisabled)
    return { ok: false, id, error: "Module is disabled.", ms: Date.now() - started };
  if (!item.runnable)
    return { ok: false, id, error: "This module has no main.py to run.", ms: Date.now() - started };
  const args = enrichInput(item, input, roots.workspaceRoot || roots.appRoot);
  try {
    const ran = await invokePython(item, args, roots.workspaceRoot || roots.appRoot, roots.appRoot);
    return { ...ran, id, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, id, error: String(error.message || error), ms: Date.now() - started };
  }
}

/**
 * Persist Enable through capabilities.json (same store as the Modules page)
 * and tell the kernel `module.toggle` so its in-memory registry matches.
 * A kernel miss does not undo the desktop override.
 */
async function setEnabled(rootOrRoots, id, enabled, options = {}) {
  const roots = normalizeRoots(rootOrRoots);
  const wanted = String(id || "");
  const item = find(roots, wanted);
  if (!item) return { ok: false, id: wanted, error: `Module "${id}" was not found.` };
  let capOk = false;
  if (roots.workspaceRoot) {
    const cap = capabilities.setEnabled(
      { workspaceRoot: roots.workspaceRoot },
      item.id,
      Boolean(enabled),
    );
    capOk = Boolean(cap.ok);
  }
  const name = String(item.name || item.id.split("/").filter(Boolean).pop() || "");
  let kernel = null;
  if (typeof options.kernelToggle === "function" && name) {
    try {
      kernel = await options.kernelToggle(name, Boolean(enabled));
    } catch (error) {
      kernel = { ok: false, error: String(error && error.message ? error.message : error) };
    }
  }
  if (!capOk) {
    return {
      ok: false,
      id: item.id,
      name,
      enabled: Boolean(enabled),
      error: "could not write config/capabilities.json",
      kernel,
    };
  }
  return {
    ok: true,
    id: item.id,
    name,
    enabled: Boolean(enabled),
    kernel: Boolean(kernel && kernel.ok !== false),
    kernelResult: kernel,
  };
}

module.exports = {
  list,
  find,
  invoke,
  setEnabled,
  enrichInput,
  entryFile,
  inferRisk,
  inspectPythonInputs,
};
