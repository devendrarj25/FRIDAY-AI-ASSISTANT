/**
 * FRIDAY · boot wiring of the install and update safety pieces
 *
 * Data migrations, the built-ins sync and the post-update model check were finished but never called.
 * These tests pin where electron/main.cjs calls them and run the real boot functions against fakes.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, "../..");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
const table = require(path.join(root, "electron/ipc-budget-table.cjs")) as {
  CHANNEL_CLASS: Record<string, string>;
};

/** The source of one top-level function of main.cjs, found by its name and balanced braces. */
function functionSource(name: string): string {
  const start = main.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
  expect(start, `${name} is declared in main.cjs`).toBeGreaterThanOrEqual(0);
  const open = main.indexOf("{", main.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < main.length; i += 1) {
    if (main[i] === "{") depth += 1;
    else if (main[i] === "}") {
      depth -= 1;
      if (depth === 0) return main.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is not closed`);
}

function build<T>(name: string, scope: Record<string, unknown>): T {
  const names = Object.keys(scope);
  const make = new Function(...names, `return (${functionSource(name)});`);
  return make(...names.map((key) => scope[key])) as T;
}

describe("boot order in app.whenReady", () => {
  const ready = main.slice(main.indexOf("const config = ensureCanonicalConfig(root);"));

  it("runs the data steps after the canonical config and before the kernel starts", () => {
    const config = ready.indexOf("ensureRootFiles(root, { version: productVersion() });");
    const steps = ready.indexOf("runDataBootSteps(root);");
    const kernel = ready.indexOf("await startKernel(root);");
    expect(config).toBeGreaterThanOrEqual(0);
    expect(steps).toBeGreaterThan(config);
    expect(kernel).toBeGreaterThan(steps);
    expect(main.match(/runDataBootSteps\(root\)/g)).toHaveLength(1);
  });

  it("runs the migrations first, then the built-ins sync with the app folder and the workspace", () => {
    const calls: string[] = [];
    const runDataBootSteps = build<(root: string, state: { last: unknown }) => void>(
      "runDataBootSteps",
      {
        dataMigrations: {
          run: (r: string, v: string) => {
            calls.push(`migrate:${r}:${v}`);
            return { applied: ["0001-x"] };
          },
        },
        builtinsSync: {
          run: (args: { appRoot: string; workspaceRoot: string }) => {
            calls.push(`sync:${args.appRoot}:${args.workspaceRoot}`);
            return { ok: true, skipped: null };
          },
        },
        productVersion: () => "9.9.9.9",
        packagedCapabilityRoot: () => "/app/resources",
        log: () => undefined,
      },
    );
    const state = { last: null as unknown };
    runDataBootSteps("/root", state);
    expect(calls).toEqual(["migrate:/root:9.9.9.9", "sync:/app/resources:/root"]);
    expect(state.last).toEqual({ ok: true, skipped: null });
  });

  it("a throwing migration step does not stop the sync, and a throwing sync does not throw", () => {
    const log = vi.fn();
    const sync = vi.fn(() => {
      throw new Error("sync broke");
    });
    const runDataBootSteps = build<(root: string, state: { last: unknown }) => void>(
      "runDataBootSteps",
      {
        dataMigrations: {
          run: () => {
            throw new Error("migration broke");
          },
        },
        builtinsSync: { run: sync },
        productVersion: () => "1.0.0.0",
        packagedCapabilityRoot: () => "/app",
        log,
      },
    );
    expect(() => runDataBootSteps("/root", { last: null })).not.toThrow();
    expect(sync).toHaveBeenCalledTimes(1);
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("migration broke"))).toBe(true);
    expect(lines.some((line) => line.includes("sync broke"))).toBe(true);
  });

  it("keeps the kill switches in the modules, not in main", () => {
    expect(fs.readFileSync(path.join(root, "electron/data-migrations.cjs"), "utf8")).toContain(
      "FRIDAY_DATA_MIGRATIONS",
    );
    expect(fs.readFileSync(path.join(root, "electron/builtins-sync.cjs"), "utf8")).toContain(
      "FRIDAY_BUILTINS_SYNC",
    );
  });
});

describe("post-update model check", () => {
  const scope = (check: () => Promise<unknown>) => ({
    getWorkspaceRoot: () => "/root",
    productVersion: () => "1.2.5.8",
    installInventory: { postUpdateCheck: check },
    log: vi.fn(),
  });

  it("is a startup task and also asked after the inventory is recorded", () => {
    expect(main).toMatch(/id: "post-update-model-check",\s*phase: "idle"/);
    const record = functionSource("recordInventory");
    expect(record.indexOf("installInventory.writeInventory(")).toBeGreaterThanOrEqual(0);
    expect(record.indexOf("runPostUpdateModelCheck()")).toBeGreaterThan(
      record.indexOf("installInventory.writeInventory("),
    );
  });

  it("calls postUpdateCheck with the folder and the app version and remembers the result", async () => {
    const check = vi.fn(async () => ({ ran: true, result: { ok: true }, persisted: true }));
    const state = { last: null as unknown, settled: false, running: false };
    const run = build<(s: typeof state) => Promise<unknown>>(
      "runPostUpdateModelCheck",
      scope(check),
    );
    await run(state);
    expect(check).toHaveBeenCalledWith("/root", { version: "1.2.5.8" });
    expect(state).toMatchObject({ last: { ok: true }, settled: true, running: false });
    await run(state);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("asks again when nothing could be recorded yet, and survives a throwing check", async () => {
    const check = vi
      .fn()
      .mockResolvedValueOnce({ ran: true, result: { ok: true }, persisted: false })
      .mockRejectedValueOnce(new Error("read failed"));
    const state = { last: null as unknown, settled: false, running: false };
    const run = build<(s: typeof state) => Promise<unknown>>(
      "runPostUpdateModelCheck",
      scope(check),
    );
    await run(state);
    expect(state.settled).toBe(false);
    await expect(run(state)).resolves.toBeNull();
    expect(state.running).toBe(false);
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe("doctor rows", () => {
  const doctor = main.slice(main.indexOf('ipcMain.handle("doctor:run"'));
  const handler = doctor.slice(0, doctor.indexOf('ipcMain.handle("doctor:csp-report"'));

  it("appends the model check row and the built-ins row to the checks", () => {
    expect(handler).toContain("modelCheckDoctorRow()");
    expect(handler).toContain("builtinsSync.doctorRow(builtinsBoot.last)");
    expect(handler.indexOf("checks.push(modelRow)")).toBeLessThan(handler.indexOf("return {"));
  });

  it("gives each row the group and status the Doctor page reads", () => {
    const modelCheckDoctorRow = build<() => Record<string, unknown> | null>("modelCheckDoctorRow", {
      installInventory: {
        readInventory: () => ({ modelCheck: { ok: false, checked: 3, bad: ["voice-a"] } }),
        modelCheckRow: (result: { ok: boolean }) => ({ id: "models-after-update", ok: result.ok }),
      },
      getWorkspaceRoot: () => "/root",
      modelCheckState: { last: null },
    });
    expect(modelCheckDoctorRow()).toMatchObject({
      id: "models-after-update",
      group: "Storage",
      status: "Warning",
      fixable: false,
    });
  });

  it("shows no model row when nothing was ever checked", () => {
    const modelCheckDoctorRow = build<() => unknown>("modelCheckDoctorRow", {
      installInventory: { readInventory: () => null, modelCheckRow: () => ({}) },
      getWorkspaceRoot: () => "/root",
      modelCheckState: { last: null },
    });
    expect(modelCheckDoctorRow()).toBeNull();
  });
});

describe("capabilities:reset-builtin", () => {
  it("is handled in main by capabilities.resetBuiltin with the roots and a string id", () => {
    expect(main).toContain(
      'ipcMain.handle("capabilities:reset-builtin", (_e, id) =>\n  capabilityIndex.resetBuiltin(capabilityRoots(), String(id || "")),\n);',
    );
    expect(main.match(/"capabilities:reset-builtin"/g)).toHaveLength(1);
  });

  it("is exposed as resetBuiltinCapability and budgeted quick", () => {
    expect(preload).toContain(
      'resetBuiltinCapability: (id) => ipcRenderer.invoke("capabilities:reset-builtin", id),',
    );
    expect(table.CHANNEL_CLASS["capabilities:reset-builtin"]).toBe("quick");
  });
});
