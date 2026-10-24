/**
 * The Models page: what runs on this PC, finding models, and bringing your own.
 * No network and no engine: the main process pieces are called directly and the
 * rest is read from source.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SUPPORT_RANK,
  checkSupport,
  estimateFit,
  type SystemProfile,
} from "../../src/lib/friday/model-catalog";
import { arrangeByFit, onlineFit, paramsBillions } from "../../src/lib/friday/model-sections";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const importer = require_(path.join(root, "electron/model-import.cjs"));
const hardware = require_(path.join(root, "electron/hardware.cjs"));

const pc = (over: Partial<SystemProfile> = {}): SystemProfile => ({
  os: "win32",
  cpu: "test",
  cores: 8,
  ramGb: 16,
  gpu: "RTX",
  vramGb: 8,
  cuda: null,
  diskFreeGb: 200,
  probedAt: 1,
  ...over,
});
const small = estimateFit(1.5);
const big = estimateFit(70);

describe("what runs on this PC", () => {
  it("never calls a model unsupported just because the PC was not measured", () => {
    const unmeasured = pc({ probedAt: null, ramGb: 0, diskFreeGb: 0, vramGb: 0 });
    expect(checkSupport(small, unmeasured).level).toBe("Unknown");
    expect(checkSupport(big, unmeasured).level).toBe("Unknown");
  });

  it("does not read a zero from a failed probe as a real zero", () => {
    expect(checkSupport(small, pc({ diskFreeGb: 0 })).level).not.toBe("Unsupported");
    expect(checkSupport(small, pc({ ramGb: 0 })).level).not.toBe("Unsupported");
  });

  it("still says unsupported for what really does not fit", () => {
    expect(checkSupport(big, pc()).level).toBe("Unsupported");
    expect(checkSupport(small, pc({ diskFreeGb: 0.5 })).level).toBe("Unsupported");
    expect(checkSupport(small, pc()).level).toBe("Optimal");
    expect(checkSupport(small, pc({ vramGb: 0 })).level).toBe("CPU only");
  });

  it("sizes a found model from the parameter count in its name", () => {
    expect(paramsBillions("7B")).toBe(7);
    expect(paramsBillions("1.5b")).toBe(1.5);
    expect(paramsBillions("135M")).toBeCloseTo(0.135);
    expect(paramsBillions("—")).toBeNull();
    expect(onlineFit({ params: "1.5B" }, pc()).level).toBe("Optimal");
    expect(onlineFit({ params: "70B" }, pc()).level).toBe("Unsupported");
    expect(onlineFit({ params: "—" }, pc()).level).toBe("Unknown");
  });

  it("lists what runs first, installed on top, and says how many it left out", () => {
    const rows = [
      { id: "huge", fit: estimateFit(70), installed: false },
      { id: "ok", fit: estimateFit(3), installed: false },
      { id: "tiny", fit: estimateFit(0.5), installed: false },
      { id: "mine", fit: estimateFit(7), installed: true },
    ];
    const levelOf = (row: (typeof rows)[number]) => checkSupport(row.fit, pc()).level;
    const runs = arrangeByFit(rows, levelOf, {
      fit: "runs",
      measured: true,
      installed: (row) => row.installed,
    });
    expect(runs.shown.map((row) => row.id)).toEqual(["mine", "ok", "tiny"]);
    expect(runs.hidden).toBe(1);
    const all = arrangeByFit(rows, levelOf, { fit: "all", measured: true });
    expect(all.shown).toHaveLength(4);
    expect(all.hidden).toBe(0);
    // Nothing is hidden before the PC has been measured.
    const early = arrangeByFit(rows, levelOf, { fit: "runs", measured: false });
    expect(early.hidden).toBe(0);
    expect(SUPPORT_RANK.Optimal).toBeLessThan(SUPPORT_RANK.Unsupported);
  });

  it("reads free disk from the file system and puts the discrete GPU first", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-hw-"));
    try {
      const disk = hardware.diskFor(dir);
      expect(disk.path).toBe(dir);
      expect(disk.freeGb).toBeGreaterThan(0);
      expect(disk.totalGb).toBeGreaterThanOrEqual(disk.freeGb);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const ordered = hardware.bestGpuFirst([
      { vendor: "intel", name: "UHD", vramTotalMb: 1024 },
      { vendor: "nvidia", name: "RTX", vramTotalMb: 8192 },
      { vendor: "amd", name: "Radeon", vramTotalMb: 4096 },
    ]);
    expect(ordered.map((g: { name: string }) => g.name)).toEqual(["RTX", "Radeon", "UHD"]);
  });

  it("measures the PC at start on the desktop instead of waiting for a button", () => {
    const engine = read("src/lib/friday/models-engine.ts");
    expect(engine).toContain("this.probeSystem();");
    expect(engine).toContain("hw.disk?.freeGb");
    expect(engine).not.toContain("this.probeSystemBrowser())");
    expect(read("electron/main.cjs")).toContain("detectHardware({ root: getWorkspaceRoot() })");
  });
});

describe("search", () => {
  it("is always visible, searches online on Enter and when nothing local matches", () => {
    const page = read("src/routes/models.tsx");
    expect(page).not.toContain('className="relative hidden sm:block"');
    expect(page).toContain('if (e.key === "Enter") void engine.discover(query)');
    expect(page).toContain("void engine.discover(text)");
    expect(page).toContain("onlineFit(d, state.system)");
  });

  it("asks the model index for GGUF only, so Install never pulls a whole safetensors repo", () => {
    const models = read("electron/models.cjs");
    expect(models).toContain('params.set("filter", "gguf")');
  });
});

describe("bringing your own model", () => {
  const temp = () => mkdtempSync(path.join(tmpdir(), "friday-import-"));
  const gguf = (dir: string, name = "tiny.gguf", head = "GGUF") => {
    const file = path.join(dir, name);
    writeFileSync(file, Buffer.concat([Buffer.from(head, "latin1"), Buffer.alloc(2048, 1)]));
    return file;
  };

  it("checks the file before anything is stored", async () => {
    const dir = temp();
    try {
      expect((await importer.inspect(gguf(dir))).format).toBe("GGUF");
      expect((await importer.inspect(gguf(dir, "fake.gguf", "NOPE"))).error).toMatch(
        /not a valid GGUF/,
      );
      writeFileSync(path.join(dir, "notes.txt"), "hello");
      expect((await importer.inspect(path.join(dir, "notes.txt"))).error).toMatch(
        /not a model file/,
      );
      writeFileSync(path.join(dir, "empty.gguf"), "");
      expect((await importer.inspect(path.join(dir, "empty.gguf"))).error).toMatch(/empty/);
      expect((await importer.inspect(path.join(dir, "missing.gguf"))).error).toMatch(/not found/);
      mkdirSync(path.join(dir, "repo", "sub"), { recursive: true });
      writeFileSync(path.join(dir, "repo", "sub", "model.safetensors"), "x".repeat(64));
      const folder = await importer.inspect(path.join(dir, "repo"));
      expect(folder).toMatchObject({ ok: true, kind: "folder", format: "Safetensors" });
      mkdirSync(path.join(dir, "empty-folder"));
      expect((await importer.inspect(path.join(dir, "empty-folder"))).error).toMatch(
        /no model files/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const run = async (over: Record<string, unknown> = {}, file = "tiny.gguf") => {
    const dir = temp();
    const rootDir = temp();
    try {
      const source = gguf(dir, file);
      const events: string[] = [];
      const result = await importer.importModel(
        { path: source, name: "My Tiny 1B" },
        {
          root: rootDir,
          emit: (e: { status: string }) => events.push(e.status),
          ensureEngine: async () => true,
          register: async () => ({ ok: true }),
          verify: async () => ({ ok: true }),
          ...over,
        },
      );
      return { result, events, placed: existsSync(String(result.path || "")), rootDir };
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  };

  it("stores a GGUF under the FRIDAY folder, registers it, and calls it ready only after it answers", async () => {
    const { result, placed } = await run();
    expect(result).toMatchObject({ ok: true, state: "ready", registered: true });
    expect(result.registeredAs).toBe("imported-my-tiny-1b");
    expect(result.path).toContain(path.join("models", "imported", "my-tiny-1b"));
    expect(placed).toBe(true);
  });

  it("says exactly where it stopped", async () => {
    expect((await run({ ensureEngine: async () => false })).result).toMatchObject({
      ok: true,
      state: "stored",
    });
    expect(
      (await run({ register: async () => ({ ok: false, error: "HTTP 500" }) })).result.note,
    ).toContain("HTTP 500");
    expect(
      (await run({ verify: async () => ({ ok: false, error: "empty answer" }) })).result,
    ).toMatchObject({ state: "not-responding", registered: true });
    expect((await run({ root: "" })).result).toMatchObject({ ok: false, state: "failed" });
  });

  it("keeps non-GGUF weights for the runtime that reads them and reports progress", async () => {
    const dir = temp();
    const rootDir = temp();
    try {
      const file = path.join(dir, "weights.safetensors");
      writeFileSync(file, "x".repeat(4096));
      const events: number[] = [];
      const result = await importer.importModel(
        { path: file },
        { root: rootDir, emit: (e: { progress: number }) => events.push(e.progress) },
      );
      expect(result).toMatchObject({ ok: true, state: "stored", format: "Safetensors" });
      expect(result.note).toMatch(/vLLM|ONNX|Transformers/);
      expect(events.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("is wired through the bridge with a real file picker, not the workspace folder picker", () => {
    const page = read("src/routes/models.tsx");
    const panel = page.slice(page.indexOf("function ImportPanel"));
    expect(panel).toContain("pickModelFiles");
    expect(panel).not.toContain("pickFolder");
    expect(panel).toContain("pathForFile");
    const preload = read("electron/preload.cjs");
    for (const name of ["pickModelFiles", "importModel", "onModelImportProgress", "pathForFile"]) {
      expect(preload).toContain(name);
    }
    const main = read("electron/main.cjs");
    expect(main).toContain('"models:pick-files"');
    expect(main).toContain("modelImport.PICK_FILTERS");
    expect(main).toContain('ipcMain.handle("models:import"');
    const table = require_(path.join(root, "electron/ipc-budget-table.cjs"));
    expect(table.CHANNEL_CLASS["models:import"]).toBe("long-job");
    expect(table.CHANNEL_CLASS["models:pick-files"]).toBe("long-job");
  });

  it("starts the engine from where it is installed and registers a finished GGUF download", () => {
    const models = read("electron/models.cjs");
    expect(models).toContain('require("./local-library.cjs").findInstalledOllama()');
    const main = read("electron/main.cjs");
    expect(main).toContain("starting the local engine to register it");
  });
});

describe("transfers of found models", () => {
  it("show up as a transfer row with their own name, and fail visibly", () => {
    const engine = read("src/lib/friday/models-engine.ts");
    expect(engine).toContain("label: item.name");
    expect(engine).toContain("export const jobName");
    const page = read("src/routes/models.tsx");
    expect(page).toContain("jobName(job)");
    expect(page).toContain("jobName(j)");
  });
});
