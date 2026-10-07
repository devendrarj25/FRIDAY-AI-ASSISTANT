/**
 * Shipped modules: real manifests, real self_test / run(), kernel + Electron
 * discovery, and two modules can run together without sharing temp paths.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const ROOT = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const capabilities = require("../../electron/capabilities.cjs") as {
  list: (roots: { appRoot?: string | null; workspaceRoot?: string | null }) => {
    items: { id: string; tree: string; enabled: boolean; name: string; entry: string | null }[];
  };
  setEnabled: (roots: { workspaceRoot: string }, id: string, enabled: boolean) => { ok: boolean };
};

const LEGACY = [
  "modules/repo-import",
  "modules/developer/project-scaffold",
  "modules/developer/stack-audit",
  "modules/developer/table-inspect",
  "modules/developer/data-normalize",
  "modules/developer/sqlite-inspect",
  "modules/system/log-inspect",
];

function walkNamed(dir: string, filename: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "__pycache__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkNamed(full, filename, out);
    else if (entry.name === filename) out.push(full);
  }
  return out;
}

function shippedModuleIds(): string[] {
  return walkNamed(path.join(ROOT, "modules"), "manifest.json").map((file) => {
    const rel = path.relative(path.join(ROOT, "modules"), path.dirname(file)).replace(/\\/g, "/");
    return `modules/${rel}`;
  });
}

function pythonBin(): string | null {
  for (const bin of ["python3", "python"]) {
    try {
      execFileSync(bin, ["-c", "import json"], { stdio: "ignore" });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}

function runPython(code: string, timeout = 120000) {
  const bin = pythonBin();
  expect(bin, "python3 is required to run module self-tests").toBeTruthy();
  return execFileSync(bin!, ["-c", code], { encoding: "utf8", timeout });
}

describe("shipped modules catalog", () => {
  it("lists every shipped module from appRoot, including repo-import at modules/<name>/", () => {
    const expected = shippedModuleIds();
    expect(expected.length).toBeGreaterThanOrEqual(70);
    const { items } = capabilities.list({ appRoot: ROOT, workspaceRoot: null });
    const modules = items.filter((item) => item.tree === "modules");
    const ids = modules.map((item) => item.id);
    for (const id of expected) expect(ids, id).toContain(id);
    for (const id of LEGACY) expect(ids, id).toContain(id);
    const repo = modules.find((item) => item.id === "modules/repo-import");
    expect(repo?.enabled).toBe(true);
    expect(repo?.entry).toBe("main.py");
    const enabled = modules.filter((item) => item.enabled).map((item) => item.id);
    expect(enabled).toEqual(["modules/repo-import"]);
  });

  it("kernel discover finds one-level and two-level module manifests", () => {
    const expected = shippedModuleIds().map(
      (id) =>
        id
          .replace(/^modules\//, "")
          .split("/")
          .pop() as string,
    );
    const script = `
import json, sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "kernel"))})
from modules import ModuleRegistry
class Storage:
    def enabled_tools(self):
        return {}
reg = ModuleRegistry(Path(${JSON.stringify(path.join(ROOT, "modules"))}), Storage())
names = sorted(m["name"] for m in reg.discover())
print(json.dumps(names))
`;
    const names = JSON.parse(runPython(script)) as string[];
    expect(names).toEqual(
      expect.arrayContaining(LEGACY.map((id) => id.split("/").pop() as string)),
    );
    expect(names).toEqual(
      expect.arrayContaining(["git-status-report", "checksum-manifest", "gguf-inventory"]),
    );
    expect(names).toHaveLength(expected.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it("each module with self_test actually runs and returns ok", () => {
    const entries = walkNamed(path.join(ROOT, "modules"), "main.py").filter(
      (file) => path.basename(path.dirname(file)) !== "repo-import",
    );
    expect(entries.length).toBeGreaterThanOrEqual(70);
    const script = `
import importlib.util, json, sys
from pathlib import Path
fails = []
ok = 0
for entry in ${JSON.stringify(entries)}:
    spec = importlib.util.spec_from_file_location("friday_mod", entry)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not hasattr(mod, "self_test"):
        fails.append({"entry": entry, "error": "no self_test"})
        continue
    mod.register({"name": Path(entry).parent.name, "version": "1"})
    result = mod.self_test({})
    if not isinstance(result, dict) or result.get("ok") is not True:
        fails.append({"entry": entry, "result": result})
        continue
    ok += 1
print(json.dumps({"ok": ok, "fails": fails}))
`;
    const out = JSON.parse(runPython(script)) as { ok: number; fails: unknown[] };
    expect(out.fails, JSON.stringify(out.fails)).toEqual([]);
    expect(out.ok).toBe(entries.length);
  });

  it("repo-import run() clones via tools then reports stack without shared ports", () => {
    const entry = path.join(ROOT, "modules", "repo-import", "main.py");
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "friday-repo-import-"));
    try {
      const script = `
import asyncio, importlib.util, json, os
from pathlib import Path
spec = importlib.util.spec_from_file_location("friday_mod", ${JSON.stringify(entry)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.register({"name": "repo-import", "version": "0.2.0"})
root = Path(${JSON.stringify(workspace)})

class Tools:
    async def execute(self, name, args, **kw):
        if name == "git":
            dest = root / args["args"][2]
            dest.mkdir()
            (dest / "package.json").write_text("{}", encoding="utf-8")
            return {"ok": True}
        if name == "fs.read":
            target = root / args["path"]
            return {"ok": True, "entries": sorted(p.name for p in target.iterdir())}
        return {"ok": False, "error": name}

result = asyncio.run(mod.run(Tools(), "https://example.invalid/demo.git", "cloned"))
print(json.dumps(result))
`;
      const lines = runPython(script)
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.startsWith("{"));
      const result = JSON.parse(lines.at(-1) || "{}");
      expect(result.ok).toBe(true);
      expect(result.stack).toContain("node");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("runs two modules at once with isolated temp prefixes (no shared path)", () => {
    const a = path.join(ROOT, "modules", "developer", "project-scaffold", "main.py");
    const b = path.join(ROOT, "modules", "system", "log-inspect", "main.py");
    const script = `
import importlib.util, json, tempfile, os

def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.register({"name": name, "version": "1"})
    return mod

a = load(${JSON.stringify(a)}, "project_scaffold")
b = load(${JSON.stringify(b)}, "log_inspect")
before = set(os.listdir(tempfile.gettempdir()))
ra = a.self_test({})
rb = b.self_test({})
after = set(os.listdir(tempfile.gettempdir()))
leftover = [name for name in (after - before) if name.startswith("friday-project-scaffold-") or name.startswith("friday-log-inspect-")]
print(json.dumps({"a": ra.get("ok"), "b": rb.get("ok"), "leftover": leftover}))
`;
    const out = JSON.parse(runPython(script));
    expect(out.a).toBe(true);
    expect(out.b).toBe(true);
    expect(out.leftover).toEqual([]);
  });

  it("capability enable override can turn two modules on without colliding ids", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "friday-mod-enable-"));
    try {
      expect(
        capabilities.setEnabled(
          { workspaceRoot: workspace },
          "modules/developer/project-scaffold",
          true,
        ).ok,
      ).toBe(true);
      expect(
        capabilities.setEnabled({ workspaceRoot: workspace }, "modules/system/log-inspect", true)
          .ok,
      ).toBe(true);
      const { items } = capabilities.list({ appRoot: ROOT, workspaceRoot: workspace });
      const on = items.filter(
        (item) =>
          item.enabled &&
          (item.id === "modules/developer/project-scaffold" ||
            item.id === "modules/system/log-inspect"),
      );
      expect(on).toHaveLength(2);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
