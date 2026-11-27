/**
 * The built-in versus user layer after an update: built-ins stay pristine in
 * the program folder, the owner's record lives in config/capabilities.json,
 * and the boot sync only reads user trees. Every fixture is a throwaway folder
 * and the clock is injected, so nothing here depends on the date or the PC.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const here = import.meta.dirname;

type Row = {
  id: string;
  origin: string;
  version: string | null;
  status: string;
  path: string;
  enabled: boolean;
  provenance?: string | null;
  fork?: { baseSha256: string };
  staleOverride?: { version: string | null };
};
type Roots = { appRoot: string; workspaceRoot: string };
type Report = {
  ok: boolean;
  skipped: string | null;
  fast: boolean;
  counts: { builtins: number; overridden: number; stale: number } | null;
  removed: string[];
  pruned: string[];
};
const capabilities = require_(path.resolve(here, "../../electron/capabilities.cjs")) as {
  list: (roots: Roots) => { items: Row[] };
  setEnabled: (roots: { workspaceRoot: string }, id: string, on: boolean) => { ok: boolean };
  installPack: (
    roots: { workspaceRoot: string },
    pack: Record<string, unknown>,
    hint?: string,
  ) => { ok: boolean; id: string; path: string };
  migrateState: (workspaceRoot: string) => { ok: boolean; migrated: boolean; reason?: string };
  recordFork: (roots: Roots, id: string) => { ok: boolean };
  forkBuiltin: (roots: Roots, id: string) => { ok: boolean; id: string; path?: string };
  resetBuiltin: (
    roots: Roots,
    id: string,
    options?: { now?: () => number },
  ) => { ok: boolean; backup?: string; error?: string };
};
const sync = require_(path.resolve(here, "../../electron/builtins-sync.cjs")) as {
  run: (options: Roots & { env?: Record<string, string> }) => Report;
  itemHash: (target: string) => string;
  doctorRow: (report: Report) => { id: string; ok: boolean; detail: string };
};
const manifest = require_(path.resolve(here, "../../scripts/builtins-manifest.cjs")) as {
  generate: (
    root: string,
    options: { release: string },
  ) => {
    trees: Record<string, { id: string; sha256: string }[]>;
  };
  write: (root: string, file: string, options: { release: string }) => unknown;
};

let appRoot = "";
let workspaceRoot = "";
const ID = "agents/core/demo";
const stateFile = () => path.join(workspaceRoot, "config", "capabilities.json");
const readState = () => JSON.parse(fs.readFileSync(stateFile(), "utf8"));
const put = (root: string, name: string, version: string, extra: Record<string, unknown> = {}) => {
  const dir = path.join(root, "agents", "core", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name, version, ...extra }));
  return dir;
};
const ship = (release: string) =>
  manifest.write(appRoot, path.join(appRoot, "builtins.json"), { release });
const row = (id = ID) =>
  capabilities.list({ appRoot, workspaceRoot }).items.find((item) => item.id === id) as Row;
const run = (env: Record<string, string> = {}) => sync.run({ appRoot, workspaceRoot, env });
const treeSnapshot = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (base: string) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const full = path.join(base, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${path.relative(dir, full)}:${fs.readFileSync(full, "utf8")}`);
    }
  };
  walk(dir);
  return out.sort();
};

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "friday-sync-"));
  appRoot = path.join(base, "app");
  workspaceRoot = path.join(base, "workspace");
  fs.mkdirSync(appRoot);
  fs.mkdirSync(workspaceRoot);
});
afterEach(() => fs.rmSync(path.dirname(appRoot), { recursive: true, force: true }));

describe("row status", () => {
  it("calls a shipped item builtin and a user-only item custom", () => {
    put(appRoot, "demo", "1.0.0");
    put(workspaceRoot, "mine", "0.1.0");
    ship("1.0.0.0");
    expect(row().status).toBe("builtin");
    expect(row("agents/core/mine").status).toBe("custom");
  });

  it("shows the built-in as identical when the workspace copy has the same content", () => {
    put(appRoot, "demo", "1.0.0");
    put(workspaceRoot, "demo", "1.0.0");
    ship("1.0.0.0");
    const item = row();
    expect(item.status).toBe("identical");
    expect(item.origin).toBe("app");
  });

  it("marks a recorded fork whose base changed as forked-stale and lets the fork win", () => {
    put(appRoot, "demo", "1.0.0");
    put(workspaceRoot, "demo", "1.0.0", { summary: "my edit" });
    ship("1.0.0.0");
    expect(capabilities.recordFork({ appRoot, workspaceRoot }, ID).ok).toBe(true);
    expect(row().status).toBe("overridden");
    put(appRoot, "demo", "2.0.0");
    ship("1.0.1.0");
    const item = row();
    expect(item.status).toBe("forked-stale");
    expect(item.origin).toBe("workspace");
    expect(item.version).toBe("1.0.0");
  });

  it("keeps an unrecorded older copy behind a strictly newer built-in", () => {
    put(appRoot, "demo", "2.0.0");
    put(workspaceRoot, "demo", "1.0.0", { summary: "old merge" });
    ship("1.0.1.0");
    const item = row();
    expect(item.origin).toBe("app");
    expect(item.status).toBe("builtin");
    expect(item.staleOverride?.version).toBe("1.0.0");
  });

  it("marks a user copy that wins over a built-in as overridden", () => {
    put(appRoot, "demo", "1.0.0");
    put(workspaceRoot, "demo", "1.5.0", { summary: "edited" });
    ship("1.0.0.0");
    expect(row().status).toBe("overridden");
  });
});

describe("the boot sync", () => {
  it("writes lastBuiltins once and then takes the fast path", () => {
    put(appRoot, "demo", "1.0.0");
    ship("1.0.0.0");
    const first = run();
    expect(first.ok).toBe(true);
    expect(first.fast).toBe(false);
    const state = readState();
    expect(state.schema).toBe(2);
    expect(state.lastBuiltins.release).toBe("1.0.0.0");
    expect(state.lastBuiltins.sha256).toMatch(/^[0-9a-f]{64}$/);
    const before = fs.readFileSync(stateFile(), "utf8");
    const second = run();
    expect(second.fast).toBe(true);
    expect(second.counts).toEqual(first.counts);
    expect(fs.readFileSync(stateFile(), "utf8")).toBe(before);
  });

  it("runs again when the shipped manifest changes", () => {
    put(appRoot, "demo", "1.0.0");
    ship("1.0.0.0");
    run();
    put(appRoot, "demo", "1.1.0");
    ship("1.0.1.0");
    const again = run();
    expect(again.fast).toBe(false);
    expect(readState().lastBuiltins.release).toBe("1.0.1.0");
  });

  it("never writes into the user trees", () => {
    put(appRoot, "demo", "2.0.0");
    put(workspaceRoot, "demo", "1.0.0", { summary: "copy" });
    put(workspaceRoot, "mine", "0.1.0");
    ship("1.0.0.0");
    const before = treeSnapshot(path.join(workspaceRoot, "agents"));
    run();
    expect(treeSnapshot(path.join(workspaceRoot, "agents"))).toEqual(before);
    expect(fs.existsSync(path.join(workspaceRoot, "config", "capabilities.json"))).toBe(true);
  });

  it("is switched off by FRIDAY_BUILTINS_SYNC=0 and writes nothing", () => {
    put(appRoot, "demo", "1.0.0");
    ship("1.0.0.0");
    const report = run({ FRIDAY_BUILTINS_SYNC: "0" });
    expect(report.skipped).toBe("disabled");
    expect(fs.existsSync(stateFile())).toBe(false);
  });

  it("does nothing when the build shipped no builtins.json", () => {
    put(appRoot, "demo", "1.0.0");
    const report = run();
    expect(report.skipped).toBe("no-manifest");
    expect(fs.existsSync(stateFile())).toBe(false);
  });

  it("adds a tombstone for a built-in the new release no longer ships and keeps the user copy", () => {
    const gone = put(appRoot, "gone", "1.0.0");
    put(appRoot, "demo", "1.0.0");
    ship("1.0.0.0");
    run();
    put(workspaceRoot, "gone", "1.0.0", { summary: "my fork of a removed one" });
    fs.rmSync(gone, { recursive: true, force: true });
    ship("1.0.1.0");
    const report = run();
    expect(report.removed).toEqual(["agents/core/gone"]);
    expect(readState().removedBuiltins["agents/core/gone"]).toEqual({ since: "1.0.1.0" });
    const item = row("agents/core/gone");
    expect(item.status).toBe("removed");
    expect(fs.existsSync(path.join(workspaceRoot, "agents", "core", "gone", "manifest.json"))).toBe(
      true,
    );
  });

  it("clears a tombstone when the built-in comes back", () => {
    const gone = put(appRoot, "gone", "1.0.0");
    ship("1.0.0.0");
    run();
    fs.rmSync(gone, { recursive: true, force: true });
    ship("1.0.1.0");
    run();
    expect(readState().removedBuiltins["agents/core/gone"]).toBeDefined();
    put(appRoot, "gone", "1.0.0");
    ship("1.0.2.0");
    run();
    expect(readState().removedBuiltins["agents/core/gone"]).toBeUndefined();
  });

  it("prunes toggles for ids that exist nowhere and keeps the others, with a .bak", () => {
    put(appRoot, "demo", "1.0.0");
    put(workspaceRoot, "mine", "0.1.0");
    ship("1.0.0.0");
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ [ID]: false, "agents/core/mine": true, "agents/core/ghost": true }),
    );
    const old = fs.readFileSync(stateFile(), "utf8");
    const report = run();
    expect(report.pruned).toEqual(["agents/core/ghost"]);
    const state = readState();
    expect(state[ID]).toBe(false);
    expect(state["agents/core/mine"]).toBe(true);
    expect(state["agents/core/ghost"]).toBeUndefined();
    expect(fs.readFileSync(`${stateFile()}.bak`, "utf8")).toBe(old);
  });

  it("counts built-ins, overridden and stale copies and reports them for Doctor", () => {
    put(appRoot, "demo", "1.0.0");
    put(appRoot, "other", "2.0.0");
    put(appRoot, "third", "1.0.0");
    put(workspaceRoot, "demo", "1.5.0", { summary: "edited" });
    put(workspaceRoot, "other", "1.0.0", { summary: "old merge" });
    ship("1.0.0.0");
    const report = run();
    expect(report.counts).toEqual({ builtins: 3, overridden: 1, stale: 1 });
    const doctor = sync.doctorRow(report);
    expect(doctor.id).toBe("builtins");
    expect(doctor.detail).toBe("Built-ins 3, overridden 1, stale 1");
  });

  it("leaves a state file it cannot read, or one from a newer FRIDAY, untouched", () => {
    put(appRoot, "demo", "1.0.0");
    ship("1.0.0.0");
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), "{ not json");
    expect(run().skipped).toBe("unreadable-state");
    expect(fs.readFileSync(stateFile(), "utf8")).toBe("{ not json");
    const newer = JSON.stringify({ schema: 3, [ID]: true, future: 1 });
    fs.writeFileSync(stateFile(), newer);
    expect(run().skipped).toBe("newer-schema");
    expect(fs.readFileSync(stateFile(), "utf8")).toBe(newer);
  });

  it("hashes an item exactly as the build generator does", () => {
    const dir = put(appRoot, "demo", "1.0.0");
    fs.writeFileSync(path.join(dir, "notes.txt"), "line one\r\nline two\r\n");
    const generated = manifest.generate(appRoot, { release: "1.0.0.0" });
    const entry = generated.trees["agents"]?.find((item) => item.id === ID);
    expect(sync.itemHash(dir)).toBe(entry?.sha256);
  });
});

describe("schema 2 of config/capabilities.json", () => {
  it("migrates a v1 toggle map forward only, keeps every toggle, and is idempotent", () => {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    const v1 = JSON.stringify({ [ID]: false, "tools/custom/x": true });
    fs.writeFileSync(stateFile(), v1);
    expect(capabilities.migrateState(workspaceRoot)).toMatchObject({ ok: true, migrated: true });
    const state = readState();
    expect(state).toMatchObject({ schema: 2, [ID]: false, "tools/custom/x": true });
    expect(state.forks).toEqual({});
    expect(state.removedBuiltins).toEqual({});
    expect(fs.readFileSync(`${stateFile()}.bak`, "utf8")).toBe(v1);
    const once = fs.readFileSync(stateFile(), "utf8");
    expect(capabilities.migrateState(workspaceRoot)).toMatchObject({ ok: true, migrated: false });
    expect(fs.readFileSync(stateFile(), "utf8")).toBe(once);
  });

  it("still reads a v1 file: the toggle is honoured and nothing is rewritten", () => {
    put(appRoot, "demo", "1.0.0");
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    const v1 = JSON.stringify({ [ID]: false });
    fs.writeFileSync(stateFile(), v1);
    expect(row().enabled).toBe(false);
    expect(fs.readFileSync(stateFile(), "utf8")).toBe(v1);
  });

  it("does not create a file when there is none, and does not downgrade a newer one", () => {
    expect(capabilities.migrateState(workspaceRoot)).toMatchObject({ ok: true, migrated: false });
    expect(fs.existsSync(stateFile())).toBe(false);
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({ schema: 9, a: 1 }));
    expect(capabilities.migrateState(workspaceRoot).migrated).toBe(false);
    expect(readState().schema).toBe(9);
  });

  it("keeps schema-2 records when a toggle changes, and refuses a reserved id", () => {
    put(appRoot, "demo", "1.0.0");
    ship("1.0.0.0");
    run();
    expect(capabilities.setEnabled({ workspaceRoot }, ID, false).ok).toBe(true);
    const state = readState();
    expect(state[ID]).toBe(false);
    expect(state.schema).toBe(2);
    expect(state.lastBuiltins.release).toBe("1.0.0.0");
    expect(capabilities.setEnabled({ workspaceRoot }, "forks", true).ok).toBe(false);
    expect(readState().forks).toEqual({});
  });
});

describe("provenance on installed packs", () => {
  const pack = { tree: "skills", id: "prov-demo", name: "Prov Demo", code: "export default 1" };
  const manifestOf = (result: { path: string }) =>
    JSON.parse(fs.readFileSync(path.join(result.path, "skill.json"), "utf8"));

  it("records marketplace without a hint, import with one, and an explicit value when valid", () => {
    expect(manifestOf(capabilities.installPack({ workspaceRoot }, pack)).provenance).toBe(
      "marketplace",
    );
    expect(manifestOf(capabilities.installPack({ workspaceRoot }, pack, "skills")).provenance).toBe(
      "import",
    );
    expect(
      manifestOf(capabilities.installPack({ workspaceRoot }, { ...pack, provenance: "forge" }))
        .provenance,
    ).toBe("forge");
    expect(
      manifestOf(capabilities.installPack({ workspaceRoot }, { ...pack, provenance: "robot" }))
        .provenance,
    ).toBe("marketplace");
  });

  it("shows provenance on the row, and reads a missing value as user", () => {
    const installed = capabilities.installPack({ workspaceRoot }, pack);
    put(workspaceRoot, "plain", "0.1.0");
    expect(row(installed.id).provenance).toBe("marketplace");
    expect(row("agents/core/plain").provenance).toBe("user");
  });
});

describe("fork and reset to built-in", () => {
  it("forks a built-in into the workspace and records the base", () => {
    put(appRoot, "demo", "1.0.0");
    ship("1.0.0.0");
    const result = capabilities.forkBuiltin({ appRoot, workspaceRoot }, ID);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(workspaceRoot, "agents", "core", "demo", "manifest.json"))).toBe(
      true,
    );
    const fork = readState().forks[ID];
    expect(fork.baseVersion).toBe("1.0.0");
    expect(fork.baseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(capabilities.forkBuiltin({ appRoot, workspaceRoot }, ID).ok).toBe(false);
    expect(capabilities.forkBuiltin({ appRoot, workspaceRoot }, "agents/core/nope").ok).toBe(false);
  });

  it("copies the fork to backup first, then removes only the user copy", () => {
    put(appRoot, "demo", "1.0.0");
    const userDir = put(workspaceRoot, "demo", "1.0.0", { summary: "my edit" });
    fs.writeFileSync(path.join(userDir, "extra.txt"), "mine");
    const keep = put(workspaceRoot, "mine", "0.1.0");
    ship("1.0.0.0");
    capabilities.recordFork({ appRoot, workspaceRoot }, ID);
    const result = capabilities.resetBuiltin({ appRoot, workspaceRoot }, ID, {
      now: () => Date.UTC(2026, 10, 27, 10, 15, 0),
    });
    expect(result.ok).toBe(true);
    expect(result.backup).toBeDefined();
    const backup = result.backup as string;
    expect(backup.startsWith(path.join(workspaceRoot, "backup", "capabilities"))).toBe(true);
    expect(path.basename(backup)).toBe("agents__core__demo-20261127T101500");
    expect(fs.readFileSync(path.join(backup, "extra.txt"), "utf8")).toBe("mine");
    expect(fs.existsSync(userDir)).toBe(false);
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(path.join(appRoot, "agents", "core", "demo", "manifest.json"))).toBe(true);
    expect(readState().forks[ID]).toBeUndefined();
    expect(row().status).toBe("builtin");
  });

  it("refuses a custom item, a missing copy and a path outside the workspace", () => {
    put(appRoot, "demo", "1.0.0");
    put(workspaceRoot, "mine", "0.1.0");
    ship("1.0.0.0");
    expect(capabilities.resetBuiltin({ appRoot, workspaceRoot }, "agents/core/mine").ok).toBe(
      false,
    );
    expect(capabilities.resetBuiltin({ appRoot, workspaceRoot }, ID).ok).toBe(false);
    expect(capabilities.resetBuiltin({ appRoot, workspaceRoot }, "../../etc").ok).toBe(false);
    expect(fs.existsSync(path.join(workspaceRoot, "agents", "core", "mine"))).toBe(true);
  });
});
