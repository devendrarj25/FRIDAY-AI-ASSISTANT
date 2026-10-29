/**
 * Production-readiness contracts that must stay true for a shipped EXE:
 * capability map files exist, the bundled friday.onnx lives only under
 * resources/wake, sample/mock data is preview-only, release workflows cannot
 * fire from a PR.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { load as parseYaml } from "js-yaml";

const root = resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === "release" ||
      entry.name === ".venv" ||
      entry.name === "dist" ||
      entry.name === "dist-desktop" ||
      entry.name === ".friday-dev"
    )
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

describe("production capability map", () => {
  const map = JSON.parse(read("config/production-capability-map.json")) as {
    capabilities: Record<string, { source: string[] }>;
    wakeWord: { bundledOnnx: boolean };
  };

  it("points every A–Z capability at files that exist", () => {
    const missing: string[] = [];
    for (const [key, cap] of Object.entries(map.capabilities)) {
      expect(key).toMatch(/^[A-Z]$/);
      for (const source of cap.source) {
        const path = join(root, source);
        if (!existsSync(path)) missing.push(`${key}: ${source}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("ships the bundled friday.onnx linear scorer and no other onnx/tflite", () => {
    expect(map.wakeWord.bundledOnnx).toBe(true);
    const onnx = walkFiles(root).filter((f) => /\.(onnx|tflite)$/i.test(f));
    expect(onnx).toEqual([join(root, "resources/wake/friday.onnx")]);
    expect(existsSync(join(root, "resources/wake/friday-wake.json"))).toBe(true);
    expect(read("kernel/wake_word.py")).toMatch(/Bundled FRIDAY linear scorer/);
    expect(read("electron/wake-engine.cjs")).toContain("installBundledModel");
  });
});

describe("production must not present mock operational state", () => {
  it("gates every mock.ts import behind desktop/preview detection", () => {
    const files = [
      "src/routes/tools.tsx",
      "src/routes/modules.tsx",
      "src/routes/logs.tsx",
      "src/lib/friday/use-kernel-status.ts",
    ];
    for (const file of files) {
      const src = read(file);
      expect(src, file).toMatch(/from ["']@\/lib\/friday\/mock["']|from ["']\.\/mock["']/);
      expect(src, file).toMatch(/isDesktopApp|supported/);
    }
    expect(read("src/routes/tools.tsx")).toContain(": []");
    expect(read("src/routes/tools.tsx")).toContain("sampleRuntimes");
    expect(read("src/lib/friday/use-friday-live.ts")).not.toMatch(/from ["']\.\/hud["']/);
  });
});

describe("CI/release cannot publish from a pull request", () => {
  it("keeps Release on workflow_dispatch and Official Publish off pull requests", () => {
    const release = parseYaml(read(".github/workflows/release.yml")) as {
      on: Record<string, unknown>;
    };
    expect(Object.keys(release.on)).toEqual(["workflow_dispatch"]);
    expect(release.on).not.toHaveProperty("pull_request");
    expect(release.on).not.toHaveProperty("push");
    expect(release.on).not.toHaveProperty("workflow_call");
    const pr = parseYaml(read(".github/workflows/pr-validation.yml")) as {
      on: Record<string, unknown>;
    };
    expect(pr.on).toHaveProperty("pull_request");
    expect(read(".github/workflows/pr-validation.yml")).not.toContain("release-engine.cjs apply");
  });

  it("uses the same Node engines floor everywhere that matters", () => {
    const pkg = JSON.parse(read("package.json")) as { engines: { node: string; npm: string } };
    expect(pkg.engines.node).toBe(">=22.19.0");
    expect(pkg.engines.npm).toBe(">=10.9.0");
    expect(JSON.parse(read("config/toolchain-versions.json")).nodeMinimum).toBe("22.19.0");
    expect(read("scripts/check-engines.cjs")).toContain("engines.node");
    expect(read("scripts/build-windows.cmd")).toContain("22.19.0");
  });
});

describe("task architecture is queued, not unbounded parallel", () => {
  it("documents one owner graph plus non-blocking chat", () => {
    const graph = read("src/lib/friday/self/task-graph.ts");
    expect(graph).toMatch(/One owner graph runs at a time/);
    expect(graph).toMatch(/Chat is untouched/);
  });
});
