/**
 * FRIDAY · run a kernel device/control function from a catalog tool pack.
 *
 * The 19 kernelTool packs used to be manifests only. Their real implementation
 * already lives in kernel/control.py, devices_android.py, devices_bluetooth.py
 * and devices_network.py (same functions kernel/tools.py calls). This module
 * is the one Node entry that catalog index.cjs files use — not a second
 * control stack.
 */
const path = require("node:path");
const { spawn } = require("node:child_process");
const python = require("./python.cjs");

const KERNEL = path.join(__dirname, "..", "kernel");

const DRIVER = `
import inspect, json, sys, traceback

raw = json.loads(sys.stdin.read() or "{}")
module_name = raw.get("module")
fn_name = raw.get("fn")
args = raw.get("args") or {}
sys.path.insert(0, raw["kernel"])
try:
    mod = __import__(module_name)
    fn = getattr(mod, fn_name)
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}))
    raise SystemExit(0)

sig = inspect.signature(fn)
kwargs = {}
missing = []
for name, param in sig.parameters.items():
    if name in args and args[name] is not None:
        kwargs[name] = args[name]
    elif param.default is inspect.Parameter.empty and param.kind in (
        inspect.Parameter.POSITIONAL_ONLY,
        inspect.Parameter.POSITIONAL_OR_KEYWORD,
        inspect.Parameter.KEYWORD_ONLY,
    ):
        missing.append(name)
if missing:
    print(json.dumps({"ok": False, "error": missing[0] + " is required"}))
    raise SystemExit(0)
try:
    result = fn(**kwargs)
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}))
    raise SystemExit(0)
if not isinstance(result, dict):
    result = {"ok": True, "value": result}
print(json.dumps(result, default=str))
`;

/** Stop a timed-out child. SIGKILL does not reap a Windows process tree. */
function stopProcessTree(child) {
  if (!child || child.pid == null) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.unref?.();
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    /* already gone */
  }
}

function spawnJson(executable, args, input, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(executable, args, {
      cwd: KERNEL,
      env: { ...process.env, PYTHONPATH: KERNEL },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    timer = setTimeout(() => {
      stopProcessTree(child);
      finish({ ok: false, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      finish({ ok: false, error: String(error.message || error) });
    });
    child.on("close", (code) => {
      const line = stdout.trim().split(/\n/).filter(Boolean).pop() || "";
      if (line) {
        try {
          finish(JSON.parse(line));
          return;
        } catch {
          /* fall through */
        }
      }
      finish({
        ok: false,
        error: stderr.trim() || stdout.trim() || `python exited ${code}`,
      });
    });
    try {
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    } catch (error) {
      finish({ ok: false, error: String(error.message || error) });
    }
  });
}

async function callPython(moduleName, fnName, args, timeoutMs = 25000) {
  const resolved = await python.resolvePython(null);
  if (!resolved || !resolved.executable) {
    return { ok: false, error: "No supported Python interpreter was found." };
  }
  return spawnJson(
    resolved.executable,
    ["-c", DRIVER],
    { module: moduleName, fn: fnName, args: args || {}, kernel: KERNEL },
    timeoutMs,
  );
}

async function androidInput(input = {}) {
  const action = String(input.action || "tap");
  const serial = input.serial || null;
  if (action === "text") {
    if (!input.text) return { ok: false, error: "text is required" };
    return callPython("devices_android", "type_text", { text: String(input.text), serial });
  }
  if (action === "swipe") {
    return callPython("devices_android", "swipe", {
      x1: Number(input.x1) || 0,
      y1: Number(input.y1) || 0,
      x2: Number(input.x2) || 0,
      y2: Number(input.y2) || 0,
      ms: Number(input.ms) || 300,
      serial,
    });
  }
  return callPython("devices_android", "tap", {
    x: Number(input.x) || 0,
    y: Number(input.y) || 0,
    serial,
  });
}

async function androidTransfer(input = {}) {
  const direction = String(input.direction || "push");
  if (!input.local || !input.remote) {
    return { ok: false, error: "local and remote paths are required" };
  }
  if (direction === "pull") {
    return callPython("devices_android", "pull", {
      remote: input.remote,
      local: input.local,
      serial: input.serial || null,
    });
  }
  return callPython("devices_android", "push", {
    local: input.local,
    remote: input.remote,
    serial: input.serial || null,
  });
}

async function networkDiscover(input = {}) {
  const kind = String(input.kind || "all");
  const seconds = Math.min(Math.max(Number(input.seconds) || 4, 0.1), 8);
  const result = { ok: true, mdns: [], dlna: [], self: null };
  const lan = await callPython("devices_network", "lan_address", {});
  result.self = lan;
  if (kind === "all" || kind === "mdns") {
    const found = await callPython("devices_network", "discover_mdns", { seconds });
    result.mdns = found.devices || [];
    if (found.ok === false) result.mdnsError = found.error;
  }
  if (kind === "all" || kind === "dlna") {
    const found = await callPython("devices_network", "discover_dlna", { seconds });
    result.dlna = found.devices || [];
    if (found.ok === false) result.dlnaError = found.error;
  }
  return result;
}

const DISPATCH = {
  "app.launch": (input) => {
    if (!String(input.app || "").trim())
      return { ok: false, error: "an application name or path is required" };
    return callPython("control", "launch_app", {
      app: String(input.app).trim(),
      args: Array.isArray(input.args) ? input.args : [],
      cwd: input.cwd || null,
    });
  },
  "app.focus": (input) => {
    if (!input.title && input.hwnd == null)
      return { ok: false, error: "a window title or hwnd is required" };
    return callPython("control", "focus_window", {
      title: input.title || null,
      hwnd: input.hwnd || null,
    });
  },
  "app.close": (input) => {
    if (!input.title && input.hwnd == null)
      return { ok: false, error: "a window title or hwnd is required" };
    return callPython("control", "close_window", {
      title: input.title || null,
      hwnd: input.hwnd || null,
    });
  },
  "app.list_windows": () => callPython("control", "list_windows", {}),
  "input.type": (input) => {
    if (input.text == null || input.text === "") return { ok: false, error: "text is required" };
    return callPython("control", "type_text", {
      text: String(input.text),
      target: input.target || null,
      hwnd: input.hwnd || null,
      interval: Number(input.interval) || 0.01,
    });
  },
  "input.hotkey": (input) => {
    const keys = Array.isArray(input.keys)
      ? input.keys
      : String(input.keys || input.prompt || "")
          .split(/[+,]/)
          .map((k) => k.trim())
          .filter(Boolean);
    if (!keys.length) return { ok: false, error: "at least one key is required" };
    return callPython("control", "hotkey", {
      keys,
      target: input.target || null,
      hwnd: input.hwnd || null,
    });
  },
  "input.click": (input) => {
    if (input.x == null || input.y == null) {
      return {
        ok: false,
        error: "x and y are required — I will not click the current pointer blindly.",
      };
    }
    return callPython("control", "click", {
      x: Number(input.x),
      y: Number(input.y),
      button: input.button || "left",
      clicks: Number(input.clicks) || 1,
      target: input.target || null,
      hwnd: input.hwnd || null,
    });
  },
  "screen.read_text": (input) =>
    callPython("control", "read_text", {
      region: Array.isArray(input.region) ? input.region : null,
      lang: input.lang || "eng",
    }),
  "android.list": () => callPython("devices_android", "list_devices", {}),
  "android.open_app": (input) => {
    if (!String(input.app || "").trim()) return { ok: false, error: "app is required" };
    return callPython("devices_android", "open_app", {
      app: String(input.app),
      serial: input.serial || null,
    });
  },
  "android.input": (input) => androidInput(input),
  "android.transfer": (input) => androidTransfer(input),
  "android.mirror": (input) =>
    callPython("devices_android", "mirror", { serial: input.serial || null }),
  "bluetooth.list": () => callPython("devices_bluetooth", "paired_devices", {}),
  "bluetooth.scan": (input) =>
    callPython("devices_bluetooth", "scan", { seconds: Math.min(Number(input.seconds) || 6, 8) }),
  "bluetooth.media": (input) => {
    if (!input.command) return { ok: false, error: "command is required" };
    return callPython("devices_bluetooth", "media", { command: String(input.command) });
  },
  "bluetooth.send_file": (input) => {
    if (!input.path) return { ok: false, error: "path is required" };
    return callPython("devices_bluetooth", "send_file", {
      path: String(input.path),
      device: input.device || "",
    });
  },
  "network.discover": (input) => networkDiscover(input),
  "network.cast": (input) => {
    if (!input.controlUrl && !input.control_url)
      return { ok: false, error: "controlUrl is required" };
    if (input.stop) {
      return callPython("devices_network", "stop", {
        control_url: input.controlUrl || input.control_url,
      });
    }
    return callPython("devices_network", "cast", {
      control_url: input.controlUrl || input.control_url,
      media_url: input.mediaUrl || input.media_url || "",
    });
  },
};

async function runKernelTool(name, input = {}, timeoutMs = 25000) {
  const fn = DISPATCH[name];
  if (!fn) return { ok: false, error: `Unknown kernel tool: ${name}` };
  try {
    const result = await fn(input || {}, timeoutMs);
    return result && typeof result === "object" ? result : { ok: true, value: result };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

module.exports = { runKernelTool, callPython, spawnJson, stopProcessTree };
