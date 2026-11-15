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

  it("a terminal gets one in-place progress bar per tool download; a log keeps one line per ten percent", () => {
    const toolkit = require_(path.join(ROOT, "scripts/prefetch-toolkit.cjs")) as {
      eventPrinter: (
        log: (l: string) => void,
        id: string,
        progressLine: undefined,
        o: { tty: boolean; out: { write: (t: string) => void } },
      ) => ((e: unknown) => void) & { end: () => void };
    };
    const written: string[] = [];
    const lines: string[] = [];
    const live = toolkit.eventPrinter((l) => lines.push(l), "cmake", undefined, {
      tty: true,
      out: { write: (t) => written.push(t) },
    });
    for (const percent of [0, 3, 3, 40, 100]) {
      live({ phase: "Downloading", percent, speedMbps: 5.4 });
    }
    live({ line: "installed" });
    live.end();
    const frames = written.filter((t) => t.startsWith("\r"));
    expect(frames).toHaveLength(4); // 0, 3, 40, 100: a repeat of 3 is not redrawn
    expect(frames[2]).toContain("[##########--------------]  40%");
    expect(frames[3]).toContain("100%");
    expect(written.filter((t) => t === "\n")).toHaveLength(1); // the bar is closed before the next message
    expect(lines).toEqual(["[friday] cmake          installed"]);

    const plain: string[] = [];
    const log = toolkit.eventPrinter((l) => plain.push(l), "pandoc", undefined, {
      tty: false,
      out: { write: () => undefined },
    });
    for (let percent = 0; percent <= 100; percent += 1) log({ phase: "Downloading", percent });
    expect(plain).toHaveLength(11);
  });

  it("the readiness run starts the installed Ollama first so chat tries the model setup pulled", async () => {
    const harness = require_(path.join(ROOT, "scripts/readiness-test.cjs")) as {
      ensureLocalChatEngine: (deps: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    let ups = 0;
    const started: string[] = [];
    const models = {
      ollamaUp: async () => (++ups >= 3 ? new Set(["qwen3:4b"]) : null),
      findOllama: () => ({ exe: "C:/Ollama/ollama.exe" }),
      startOllama: (exe: string) => started.push(exe),
    };
    const result = await harness.ensureLocalChatEngine({ env: {}, models, waitMs: 1 });
    expect(result).toMatchObject({ up: true, started: true, models: 1 });
    expect(started).toEqual(["C:/Ollama/ollama.exe"]);

    const running = await harness.ensureLocalChatEngine({
      env: {},
      models: { ...models, ollamaUp: async () => new Set(["a", "b"]) },
    });
    expect(running).toMatchObject({ up: true, started: false, models: 2 });

    expect(await harness.ensureLocalChatEngine({ env: { CI: "true" }, models })).toMatchObject({
      up: false,
      skipped: "hosted CI",
    });
    const none = await harness.ensureLocalChatEngine({
      env: {},
      models: { ...models, ollamaUp: async () => null, findOllama: () => null },
    });
    expect(none).toMatchObject({ up: false, skipped: "Ollama is not installed" });
  });

  it("a local build stops at a verified, bootable installer; PR Validation and the release still run the install-and-chat check", () => {
    const { readinessSkip } = require_(path.join(ROOT, "scripts/build-pipeline.cjs")) as {
      readinessSkip: (o: { caller: string }, env?: Record<string, string>) => string;
    };
    expect(readinessSkip({ caller: "cmd" }, {})).toMatch(/^skipped:/);
    expect(readinessSkip({ caller: "npm" }, {})).toMatch(/^skipped:/);
    expect(readinessSkip({ caller: "cmd" }, { FRIDAY_BUILD_READINESS: "1" })).toBe("");
    for (const caller of ["pr-validation", "friday-release", "node", "ci"]) {
      expect(readinessSkip({ caller }, {})).toBe("");
    }
    const pipeline = fs.readFileSync(path.join(ROOT, "scripts/build-pipeline.cjs"), "utf8");
    expect(pipeline).toContain("verify:install");
  });
});
