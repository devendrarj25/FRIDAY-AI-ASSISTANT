/**
 * The main process, not the page, decides whether a tool installs or updates: it reads the owner's stored autonomy
 * dial, uses the one data root, and runs every update through planUpdate first. Handler source is cut out of main.cjs
 * and run against fakes.
 */
import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const main = readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const catalog = require_(path.join(root, "electron/installer-catalog.cjs"));

const gateBlock = main.slice(
  main.indexOf("// ---- install and update gate"),
  main.indexOf("// Tools the owner adds by data"),
);
const runBlock = main.slice(
  main.indexOf('ipcMain.handle("tools:run"'),
  main.indexOf("// ---- Import & in-app build"),
);

type Row = Record<string, unknown>;
function harness(opts: { rows: Row[]; stored?: unknown; throwRead?: boolean }) {
  const handlers: Record<string, (e: unknown, a: unknown) => Promise<Record<string, unknown>>> = {};
  const runJob = vi.fn(async () => ({ ok: true }));
  const fakes = {
    ipcMain: { handle: (name: string, fn: never) => void (handlers[name] = fn) },
    stateStore: {
      readState: () => {
        if (opts.throwRead) throw new Error("disk");
        return opts.stored ?? null;
      },
    },
    stateFile: (ns: string) => ns,
    getInstallerCatalog: () => ({
      snapshot: () => ({ rows: opts.rows }),
      planUpdate: catalog.planUpdate,
    }),
    toolchain: { toolById: (id: string) => opts.rows.find((r) => r["id"] === id) ?? null, runJob },
    paths: { root: () => "C:/FRIDAY" },
    getWorkspaceRoot: () => "C:/other",
    log: () => undefined,
    send: () => undefined,
  };
  const names = Object.keys(fakes);
  new Function(...names, `${gateBlock}\n${runBlock}`)(...names.map((n) => (fakes as never)[n]));
  return { handlers, runJob };
}
const upd = { id: "git", updateStatus: "update", fit: { state: "ok" } };
const call = (h: ReturnType<typeof harness>, ch: string, arg: unknown) => h.handlers[ch]!({}, arg);

describe("installer update and tools:run main gate (source pins)", () => {
  it("the renderer's autonomy and root are not read", () => {
    expect(gateBlock + runBlock).not.toMatch(/request\?\.autonomy|job\?\.root|job\?\.autonomy/);
  });
  it("both handlers plan the update before runJob", () => {
    expect(gateBlock.indexOf("planUpdate")).toBeGreaterThan(-1);
    expect(runBlock).toMatch(/gatedToolJob/);
  });
  it("the data root comes from the paths module", () => {
    expect(gateBlock + runBlock).toMatch(/paths\.root\(\)/);
  });
});

describe("installer:update", () => {
  it("ignores a renderer 'full' and asks for consent under the stored Balanced dial", async () => {
    const h = harness({ rows: [upd], stored: { approvalLevel: "balanced" } });
    const out = await call(h, "installer:update", { id: "git", autonomy: "full" });
    expect(out).toMatchObject({ ok: false, allowed: false, needsConsent: true });
    expect(h.runJob).not.toHaveBeenCalled();
  });
  it("runs under the stored Full dial and uses the paths root", async () => {
    const h = harness({ rows: [upd], stored: { approvalLevel: "full" } });
    const out = await call(h, "installer:update", { id: "git", autonomy: "ask" });
    expect(out).toMatchObject({ allowed: true, via: "full-autonomy" });
    expect(h.runJob).toHaveBeenCalledWith(
      { id: "git", action: "update", root: "C:/FRIDAY" },
      expect.any(Function),
    );
  });
  it("a halted store reads as Ask", async () => {
    const h = harness({ rows: [upd], stored: { approvalLevel: "full", halted: true } });
    expect(await call(h, "installer:update", { id: "git" })).toMatchObject({ needsConsent: true });
  });
  it("an unreadable store reads as Ask", async () => {
    const h = harness({ rows: [upd], throwRead: true });
    expect(await call(h, "installer:update", { id: "git" })).toMatchObject({ needsConsent: true });
  });
  it("owner consent lets it run", async () => {
    const h = harness({ rows: [upd], stored: { approvalLevel: "balanced" } });
    const out = await call(h, "installer:update", { id: "git", consent: { granted: true } });
    expect(out).toMatchObject({ allowed: true, via: "consent" });
  });
  it("a notify-only row is refused even under Full with consent", async () => {
    const row = { id: "electron", notifyOnly: true, updateStatus: "update" };
    const h = harness({ rows: [row], stored: { approvalLevel: "full" } });
    const out = await call(h, "installer:update", { id: "electron", consent: { granted: true } });
    expect(out).toMatchObject({ ok: false, allowed: false, notifyOnly: true });
    expect(h.runJob).not.toHaveBeenCalled();
  });
});

describe("tools:run", () => {
  it("an update goes through planUpdate and a renderer root is ignored", async () => {
    const h = harness({ rows: [upd], stored: { approvalLevel: "full" } });
    await call(h, "tools:run", { id: "git", action: "update", root: "C:/evil" });
    expect(h.runJob).toHaveBeenCalledWith(
      { id: "git", action: "update", root: "C:/FRIDAY" },
      expect.any(Function),
    );
  });
  it("an update under Balanced without consent returns needsConsent and never runs", async () => {
    const h = harness({ rows: [upd], stored: { approvalLevel: "balanced" } });
    const out = await call(h, "tools:run", { id: "git", action: "update", root: "C:/evil" });
    expect(out).toMatchObject({ ok: false, needsConsent: true });
    expect(h.runJob).not.toHaveBeenCalled();
  });
  it("a notify-only update is refused under Full", async () => {
    const row = { id: "node", notifyOnly: true, updateStatus: "update" };
    const h = harness({ rows: [row], stored: { approvalLevel: "full" } });
    const out = await call(h, "tools:run", { id: "node", action: "update" });
    expect(out).toMatchObject({ ok: false, notifyOnly: true });
    expect(h.runJob).not.toHaveBeenCalled();
  });
  it("a fresh install of a non-machine tool stays as it was", async () => {
    const h = harness({ rows: [{ id: "git", installed: false, home: "user" }], stored: {} });
    await call(h, "tools:run", { id: "git", action: "install" });
    expect(h.runJob).toHaveBeenCalledTimes(1);
  });
  it("a fresh machine-wide install needs consent unless Full", async () => {
    const row = { id: "git", installed: false, home: "machine" };
    const ask = harness({ rows: [row], stored: { approvalLevel: "balanced" } });
    expect(await call(ask, "tools:run", { id: "git", action: "install" })).toMatchObject({
      needsConsent: true,
    });
    expect(ask.runJob).not.toHaveBeenCalled();
    const ok = harness({ rows: [row], stored: { approvalLevel: "balanced" } });
    await call(ok, "tools:run", { id: "git", action: "install", consent: { granted: true } });
    expect(ok.runJob).toHaveBeenCalledTimes(1);
  });
});
