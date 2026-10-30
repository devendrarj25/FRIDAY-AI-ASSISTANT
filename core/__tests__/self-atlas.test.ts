/**
 * The Self Atlas answers "where am I, what am I, what state am I in" from real probes.
 * Each test builds a throwaway FRIDAY folder, so nothing depends on this checkout,
 * the clock, the network or the real desktop.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);

type Fact = {
  group: string;
  id: string;
  label: string;
  value: string;
  status: "ok" | "warn" | "bad" | "unknown";
  source: string;
  readAt: number;
  confidence: number;
  note?: string;
};
type Atlas = {
  schema: number;
  readAt: number;
  facts: Fact[];
  counts: Record<string, number>;
  groups: Record<string, { total: number }>;
  summary: string;
};
const atlas = require_("../../electron/self-atlas.cjs") as {
  buildAtlas: (ctx?: Record<string, unknown>) => Promise<Atlas>;
  measureDir: (
    dir: string,
    limit?: number,
  ) => { files: number; bytes: number; truncated: boolean; exists: boolean };
  sqliteHeader: (file: string) => { valid: boolean; reason: string };
  autoApproveExec: (text: string) => boolean | null;
  installKind: (ctx: Record<string, unknown>) => string;
};

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function sqliteFile(file: string, { pages = 2, pageSize = 4096, torn = false } = {}) {
  const buffer = Buffer.alloc(pages * pageSize);
  buffer.write("SQLite format 3\u0000", 0, "latin1");
  buffer.writeUInt16BE(pageSize, 16);
  buffer.writeUInt32BE(pages, 28);
  fs.writeFileSync(file, torn ? buffer.subarray(0, pageSize) : buffer);
}

let root = "";
let shipped = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-atlas-"));
  shipped = fs.mkdtempSync(path.join(os.tmpdir(), "friday-shipped-"));
  for (const dir of ["config", "database", "memory/working", "backup", "logs"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  const kernel = "automation:\n  auto_approve_exec: false\n";
  fs.writeFileSync(path.join(root, "config", "kernel.yaml"), kernel);
  fs.writeFileSync(path.join(shipped, "kernel.yaml"), kernel);
  fs.writeFileSync(path.join(root, "config", "models.yaml"), "models: []\n");
  fs.writeFileSync(path.join(shipped, "models.yaml"), "models: []\n");
  sqliteFile(path.join(root, "database", "friday.sqlite3"));
  fs.writeFileSync(path.join(root, "memory", "working", "a.json"), "{}");
  fs.writeFileSync(path.join(root, "backup", "b1.zip"), "zip");
  fs.writeFileSync(path.join(root, "logs", "friday.log"), "started\nready\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(shipped, { recursive: true, force: true });
});

const baseCtx = () => ({
  now: () => NOW,
  root,
  appDir: root,
  exePath: path.join(root, "App", "FRIDAY.exe"),
  isPackaged: true,
  portableDir: "",
  channel: "production",
  version: "1.1.4.6",
  epoch: 2,
  runtime: { electron: "43.8.3", node: "24.0.0", chrome: "140" },
  pid: 4242,
  kernel: async () => ({
    reachable: true,
    port: 8765,
    pid: 4300,
    health: { version: "1.1.4.6", instance_id: "abcdef123456", data_dir: path.join(root, "data") },
  }),
  services: async () => [
    { name: "Ollama", state: "online" },
    { name: "LM Studio", state: "offline" },
  ],
  shippedConfig: (name: string) => path.join(shipped, name),
  inventory: () => ({ items: [{ id: "a" }, { id: "b", updateAvailable: true }] }),
});

const find = (result: Atlas, id: string) => {
  const row = result.facts.find((fact) => fact.id === id);
  if (!row) throw new Error(`no fact ${id}`);
  return row;
};

describe("self atlas", () => {
  it("answers from probes, and every fact carries its source, read time and confidence", async () => {
    const result = await atlas.buildAtlas(baseCtx());
    expect(result.schema).toBe(1);
    expect(result.readAt).toBe(NOW);
    expect(result.facts.length).toBeGreaterThanOrEqual(15);
    for (const row of result.facts) {
      expect(row.source.length, row.id).toBeGreaterThan(0);
      expect(row.readAt, row.id).toBe(NOW);
      expect(row.confidence, row.id).toBeGreaterThanOrEqual(0);
      expect(row.confidence, row.id).toBeLessThanOrEqual(1);
    }
    expect(find(result, "root").value).toBe(path.resolve(root));
    expect(find(result, "exe").value).toContain("installed (Setup)");
    expect(find(result, "friday").value).toBe("1.1.4.6 · epoch 2");
    expect(find(result, "kernel").value).toContain("port 8765");
    expect(find(result, "services").value).toBe("1/2 online: Ollama");
    expect(find(result, "backups").value).toContain("newest");
    expect(result.counts["bad"]).toBe(0);
    expect(result.summary).toContain("facts read");
  });

  it("reports what it cannot inspect as unknown, never as healthy", async () => {
    const result = await atlas.buildAtlas({ now: () => NOW });
    expect(find(result, "root").status).toBe("bad");
    for (const id of ["kernel", "services", "friday", "electron-main", "inventory"]) {
      expect(find(result, id).status, id).toBe("unknown");
      expect(find(result, id).confidence, id).toBeLessThanOrEqual(0.4);
    }
    expect(result.facts.some((row) => row.status === "ok")).toBe(false);
  });

  it("turns a probe that throws into an honest 'not inspected' fact with the reason", async () => {
    const result = await atlas.buildAtlas({
      ...baseCtx(),
      services: async () => {
        throw new Error("health monitor stopped");
      },
    });
    const row = find(result, "services");
    expect(row.status).toBe("unknown");
    expect(row.value).toBe("not inspected");
    expect(row.confidence).toBe(0);
    expect(row.note).toBe("health monitor stopped");
    expect(find(result, "root").status).toBe("ok");
  });

  it("tells the three kinds of EXE apart", async () => {
    expect(atlas.installKind({ isPackaged: true, portableDir: "" })).toBe("installed (Setup)");
    expect(atlas.installKind({ isPackaged: true, portableDir: "D:\\portable" })).toBe(
      "portable EXE",
    );
    expect(atlas.installKind({ isPackaged: false, portableDir: "" })).toContain("source checkout");
  });

  it("flags a kernel that is down, and one that stores data outside the FRIDAY folder", async () => {
    const down = await atlas.buildAtlas({
      ...baseCtx(),
      kernel: async () => ({ reachable: false, error: "connection refused" }),
    });
    expect(find(down, "kernel").status).toBe("bad");
    expect(find(down, "kernel").note).toBe("connection refused");

    const stray = await atlas.buildAtlas({
      ...baseCtx(),
      kernel: async () => ({
        reachable: true,
        health: { version: "1.1.4.6", data_dir: path.join(os.tmpdir(), "somewhere-else") },
      }),
    });
    expect(find(stray, "kernel").status).toBe("bad");
    expect(find(stray, "kernel").note).toContain("outside the FRIDAY folder");
  });

  it("warns when the kernel and the app disagree on the version", async () => {
    const result = await atlas.buildAtlas({
      ...baseCtx(),
      kernel: async () => ({
        reachable: true,
        health: { version: "1.0.0.0", data_dir: path.join(root, "data") },
      }),
    });
    expect(find(result, "kernel").status).toBe("warn");
  });

  it("compares live config with the shipped default and notices a pending .new file", async () => {
    let result = await atlas.buildAtlas(baseCtx());
    expect(find(result, "kernel.yaml").value).toBe("matches the shipped default");
    expect(find(result, "kernel.yaml").status).toBe("ok");

    fs.writeFileSync(path.join(root, "config", "models.yaml"), "models:\n  - id: mine\n");
    fs.writeFileSync(path.join(root, "config", "models.yaml.new"), "models: []\n");
    result = await atlas.buildAtlas(baseCtx());
    expect(find(result, "models.yaml").value).toBe("edited by the owner");
    expect(find(result, "models.yaml").status).toBe("warn");
    expect(find(result, "models.yaml").note).toContain("models.yaml.new");

    fs.rmSync(path.join(root, "config", "kernel.yaml"));
    result = await atlas.buildAtlas(baseCtx());
    expect(find(result, "kernel.yaml").value).toBe("missing");
  });

  it("raises the run-without-asking switch as bad when it is true", async () => {
    expect(atlas.autoApproveExec("automation:\n  auto_approve_exec: true # x\n")).toBe(true);
    expect(atlas.autoApproveExec("automation:\n  other: 1\n")).toBeNull();
    fs.writeFileSync(
      path.join(root, "config", "kernel.yaml"),
      "automation:\n  auto_approve_exec: true\n",
    );
    const result = await atlas.buildAtlas(baseCtx());
    const row = find(result, "auto-approve-exec");
    expect(row.status).toBe("bad");
    expect(row.note).toContain("must stay false");
    expect(row.confidence).toBe(1);
  });

  it("checks the database header without opening it, and says how weak that check is", async () => {
    const ok = await atlas.buildAtlas(baseCtx());
    expect(find(ok, "database").status).toBe("ok");
    expect(find(ok, "database").value).toContain("header valid");
    expect(find(ok, "database").confidence).toBeLessThan(0.8);
    expect(find(ok, "database").note).toContain("header check only");

    sqliteFile(path.join(root, "database", "friday.sqlite3"), { pages: 3, torn: true });
    const torn = await atlas.buildAtlas(baseCtx());
    expect(find(torn, "database").status).toBe("bad");
    expect(find(torn, "database").value).toContain("shorter than its page count");

    fs.writeFileSync(
      path.join(root, "database", "friday.sqlite3"),
      "not a database at all".repeat(10),
    );
    const junk = await atlas.buildAtlas(baseCtx());
    expect(find(junk, "database").status).toBe("bad");

    fs.rmSync(path.join(root, "database", "friday.sqlite3"));
    const none = await atlas.buildAtlas(baseCtx());
    expect(find(none, "database").status).toBe("warn");
    expect(atlas.sqliteHeader.length).toBe(1);
  });

  it("notes when there is no backup yet and when a log tail holds error lines", async () => {
    fs.rmSync(path.join(root, "backup", "b1.zip"));
    fs.writeFileSync(
      path.join(root, "logs", "friday.log"),
      "ok\nERROR kernel failed to bind\nok\nTraceback (most recent call last)\n",
    );
    const result = await atlas.buildAtlas(baseCtx());
    expect(find(result, "backups").value).toBe("no backup yet");
    expect(find(result, "backups").status).toBe("warn");
    expect(find(result, "logs").status).toBe("warn");
    expect(find(result, "logs").note).toContain("2 line(s)");
  });

  it("counts inventory items that have an update", async () => {
    const result = await atlas.buildAtlas(baseCtx());
    expect(find(result, "inventory").value).toBe("2 item(s) · 1 with an update");
    expect(find(result, "inventory").status).toBe("warn");
  });

  it("bounds the folder walk and says the count is partial", () => {
    for (let i = 0; i < 30; i += 1) {
      fs.writeFileSync(path.join(root, "memory", "working", `f${i}.json`), "x");
    }
    const got = atlas.measureDir(path.join(root, "memory"), 10);
    expect(got.truncated).toBe(true);
    expect(got.files).toBeLessThanOrEqual(10);
    expect(atlas.measureDir(path.join(root, "nope")).exists).toBe(false);
  });
});
