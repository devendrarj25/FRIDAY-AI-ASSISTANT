import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "..", "..");
const pack = require_(path.join(ROOT, "scripts/electron-pack.cjs")) as {
  condenseBuilderLine: (line: string) => string;
  lineForwarder: (write: (t: string) => void) => ((c: string) => void) & { flush: () => void };
};
const pipeline = require_(path.join(ROOT, "scripts/build-pipeline.cjs")) as {
  seedElectronCache: (target: string, source: string) => string[];
};

describe("build run log fixes (2026-11-11)", () => {
  it("condenses the oversized duplicate-dependency line and leaves normal lines alone", () => {
    const long = `  • ${"x".repeat(30)} duplicate dependency references ${"dep ".repeat(200)}`;
    const out = pack.condenseBuilderLine(long);
    expect(out.length).toBeLessThan(160);
    expect(out).toContain("duplicate dependency references");
    expect(pack.condenseBuilderLine("  • packaging platform=win32")).toBe(
      "  • packaging platform=win32",
    );
  });

  it("forwards output line by line, including a final line with no newline", () => {
    const got: string[] = [];
    const push = pack.lineForwarder((t) => got.push(t));
    push("one\ntw");
    push("o\r\nthree");
    push.flush();
    expect(got.join("")).toBe("one\ntwo\nthree");
  });

  it("copies the Electron zip into the build cache once and never overwrites", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-ecache-"));
    const source = path.join(tmp, "default");
    const target = path.join(tmp, "build");
    fs.mkdirSync(path.join(source, "abc"), { recursive: true });
    fs.writeFileSync(path.join(source, "abc", "electron-v45.2.1-win32-x64.zip"), "zip");
    fs.writeFileSync(path.join(source, "abc", "SHASUMS256.txt"), "x");
    expect(pipeline.seedElectronCache(target, source)).toEqual(["electron-v45.2.1-win32-x64.zip"]);
    expect(
      fs.readFileSync(path.join(target, "abc", "electron-v45.2.1-win32-x64.zip"), "utf8"),
    ).toBe("zip");
    expect(pipeline.seedElectronCache(target, source)).toEqual([]);
    expect(pipeline.seedElectronCache(target, target)).toEqual([]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("the build drops a dead FRIDAY_PYTHON and runs the environment check in summary mode", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts/build-pipeline.cjs"), "utf8");
    expect(src).toContain("dropStalePython(process.env)");
    expect(src).toContain('["--fix", "--summary"]');
  });

  it("a reloaded Ollama row is called by its bare tag (kernel pins it too)", () => {
    const py = fs.readFileSync(path.join(ROOT, "kernel/tests/test_router_wire_model.py"), "utf8");
    expect(py).toContain('wire_model == "qwen3:4b"');
    expect(fs.readFileSync(path.join(ROOT, "kernel/router.py"), "utf8")).not.toContain(
      'model.options.get("model", model.id)',
    );
  });

  it("the restart line names the kernel lines that say why a launch had no kernel", () => {
    const harness = require_(path.join(ROOT, "scripts/readiness-test.cjs")) as {
      restartReportLine: (second: unknown, first: unknown) => string;
    };
    const line = harness.restartReportLine(
      {
        stages: [{ name: "BASIC TASK", ok: false, detail: "watchdog" }],
        output:
          "noise\n[kernel] database is locked\nstill noise\nError occurred in handler for 'kernel:rpc'",
      },
      { kernel: { pid: 1, port: 2 } },
    );
    expect(line).toContain("kernel log:");
    expect(line).toContain("database is locked");
  });

  it("inside setup the voice-stack table is a count plus the rows that need a look", () => {
    const stack = require_(path.join(ROOT, "scripts/voice-stack.cjs")) as {
      print: (rows: unknown[], log: (t: string) => void, o: { summary: boolean }) => number;
    };
    const lines: string[] = [];
    const rows = [
      { layer: "a", state: "PASS", name: "one", detail: "x" },
      { layer: "a", state: "INFO", name: "two", detail: "y" },
    ];
    expect(stack.print(rows, (t) => lines.push(t), { summary: true })).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("two");
    expect(text).not.toContain("one ");
    expect(text).toContain("2 rows: 1 pass, 0 fail, 1 info");
    expect(fs.readFileSync(path.join(ROOT, "scripts/doctor.cjs"), "utf8")).toContain('"--summary"');
  });

  it("the toolkit step looks at the copy setup chose first, and setup's own check is a summary", () => {
    const toolkit = fs.readFileSync(path.join(ROOT, "scripts/prefetch-toolkit.cjs"), "utf8");
    expect(toolkit).toContain("managed.readFirst(picked.root)");
    const ps = fs.readFileSync(path.join(ROOT, "scripts/setup-windows.ps1"), "utf8");
    expect(ps).toContain("check-environment.cjs --fix --summary");
  });

  it("no double-quoted PowerShell string has a bare variable-colon (it parses as a scope-qualified variable)", () => {
    const text = fs.readFileSync(path.join(ROOT, "scripts/setup-windows.ps1"), "utf8");
    const scopes = /^(env|script|global|local|private|using|variable|function)$/i;
    const bad: string[] = [];
    text.split(/\r?\n/).forEach((line, i) => {
      for (const quoted of line.matchAll(/"((?:[^"`]|`.)*)"/g)) {
        for (const v of (quoted[1] ?? "").matchAll(/(?<![`$])[$]([A-Za-z_]\w*):/g)) {
          if (!scopes.test(v[1] ?? "")) bad.push(`${i + 1}: ${v[0]}`);
        }
      }
    });
    expect(bad).toEqual([]);
  });
});
