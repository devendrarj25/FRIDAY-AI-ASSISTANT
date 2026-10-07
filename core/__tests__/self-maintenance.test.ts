import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const archIndex = require("../../electron/architecture-index.cjs");
const impact = require("../../electron/impact.cjs");

let root: string;

const write = (rel: string, body: string) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-self-"));
  write("package.json", JSON.stringify({ name: "friday", dependencies: { react: "19.0.0" } }));
  write("src/lib/helper.ts", "export const value = 1;\n");
  write("src/routes/index.tsx", "import { value } from '@/lib/helper';\nexport default value;\n");
  write(
    "electron/main.cjs",
    "const { value } = require('./helper.cjs');\nmodule.exports = value;\n",
  );
  write("electron/helper.cjs", "module.exports = { value: 1 };\n");
  write("kernel/main.py", "from tools import run\n");
  write("kernel/tools.py", "def run():\n    return 1\n");
  write("plugins/demo/index.cjs", "module.exports = {};\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("architecture index", () => {
  it("maps real dependency edges across TypeScript, CommonJS and Python", () => {
    const index = archIndex.buildIndex(root);
    expect(index.edges["src/routes/index.tsx"]).toContain("src/lib/helper.ts");
    expect(index.edges["electron/main.cjs"]).toContain("electron/helper.cjs");
    expect(index.edges["kernel/main.py"]).toContain("kernel/tools.py");
    expect(index.reverse["src/lib/helper.ts"]).toContain("src/routes/index.tsx");
    expect(index.entryPoints).toContain("electron/main.cjs");
  });

  it("persists and reloads without rebuilding", () => {
    const index = archIndex.buildIndex(root);
    expect(archIndex.saveIndex(index)).toBeTruthy();
    const loaded = archIndex.loadIndex(root);
    expect(loaded?.totals.files).toBe(index.totals.files);
  });

  it("detects added, changed and deleted files incrementally", () => {
    const index = archIndex.buildIndex(root);
    write("src/lib/helper.ts", "export const value = 2;\n");
    write("plugins/demo/extra.cjs", "module.exports = 1;\n");
    fs.rmSync(path.join(root, "kernel/tools.py"));

    const { changes } = archIndex.updateIndex(index, [
      "src/lib/helper.ts",
      "plugins/demo/extra.cjs",
      "kernel/tools.py",
    ]);
    const byPath = Object.fromEntries(changes.map((c: { path: string }) => [c.path, c]));
    expect(byPath["src/lib/helper.ts"].state).toBe("changed");
    expect(byPath["plugins/demo/extra.cjs"].state).toBe("added");
    expect(byPath["kernel/tools.py"].state).toBe("deleted");
  });

  it("reports an unchanged file as no change", () => {
    const index = archIndex.buildIndex(root);
    const { changes } = archIndex.updateIndex(index, ["src/lib/helper.ts"]);
    expect(changes).toHaveLength(0);
  });
});

describe("impact verdicts", () => {
  const assess = (paths: { path: string; area: string; state?: string }[]) => {
    const index = archIndex.buildIndex(root);
    return impact.assess({
      index,
      root,
      changes: paths.map((p) => ({ state: "changed", ...p })),
    });
  };

  it("hot-reloads workspace content", () => {
    expect(assess([{ path: "plugins/demo/index.cjs", area: "plugins" }]).verdict).toBe(
      "hot-reload",
    );
  });

  it("requires a restart for kernel and config changes", () => {
    expect(assess([{ path: "kernel/tools.py", area: "kernel" }]).verdict).toBe("restart");
  });

  it("requires a rebuild for renderer sources and manifests", () => {
    expect(assess([{ path: "src/lib/helper.ts", area: "renderer" }]).verdict).toBe("rebuild");
    expect(assess([{ path: "package.json", area: "other" }]).verdict).toBe("rebuild");
  });

  it("blocks a change that references something unresolved", () => {
    write("src/routes/index.tsx", "import { gone } from '@/lib/missing';\nexport default gone;\n");
    const result = assess([{ path: "src/routes/index.tsx", area: "renderer" }]);
    expect(result.verdict).toBe("blocked");
    expect(result.blockers[0].reason).toContain("unresolved import");
  });

  it("escalates when a dependent entry point is affected", () => {
    const result = assess([{ path: "electron/helper.cjs", area: "shell" }]);
    expect(result.dependents).toContain("electron/main.cjs");
    expect(result.verdict).toBe("restart");
  });
});
