/**
 * FRIDAY · data migrations at boot
 *
 * electron/data-migrations.cjs is the CommonJS runner Electron main loads. It works on the same ledger
 * (database/migrations.json) and the same migration ids as installer/migration/index.ts, so the two lists
 * must never drift. The updater entry point passes the new version through to the ledger.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { MIGRATIONS as TS_MIGRATIONS, runMigrations } from "../../installer/migration";
import { migrateAfterUpdate } from "../../updater/migration";

const require = createRequire(import.meta.url);
const repo = path.resolve(__dirname, "../..");
const runner = require(path.join(repo, "electron/data-migrations.cjs")) as {
  MIGRATIONS: { id: string; describe: string; run: (root: string) => void }[];
  ledgerFile: (root: string) => string;
  run: (
    root: string,
    appVersion?: string | null,
    options?: {
      env?: Record<string, string | undefined>;
      migrations?: { id: string; describe: string; run: (root: string) => void }[];
      now?: () => number;
    },
  ) => { applied: string[]; error?: string; skipped?: string };
};

let root = "";
const readLedger = () => JSON.parse(fs.readFileSync(runner.ledgerFile(root), "utf8"));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-data-migrations-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("boot data migrations", () => {
  it("applies the unapplied migrations once and stamps the app version", () => {
    const result = runner.run(root, "1.2.5.8", { now: () => 42 });
    expect(result).toEqual({ applied: ["0001-config-capabilities"] });
    expect(readLedger()).toEqual([
      { id: "0001-config-capabilities", appliedAt: 42, appVersion: "1.2.5.8" },
    ]);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, "config", "capabilities.json"), "utf8")),
    ).toEqual({});
  });

  it("is idempotent: a second run applies nothing and re-stamps nothing", () => {
    runner.run(root, "1.2.5.8");
    const before = fs.readFileSync(runner.ledgerFile(root), "utf8");
    expect(runner.run(root, "1.2.5.9")).toEqual({ applied: [] });
    expect(fs.readFileSync(runner.ledgerFile(root), "utf8")).toBe(before);
  });

  it("keeps an old ledger row with no version and an existing capabilities record", () => {
    fs.mkdirSync(path.join(root, "database"), { recursive: true });
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    const old = [{ id: "0001-config-capabilities", appliedAt: 5 }];
    fs.writeFileSync(runner.ledgerFile(root), JSON.stringify(old));
    fs.writeFileSync(path.join(root, "config", "capabilities.json"), '{"keep":true}');
    expect(runner.run(root, "1.2.5.8")).toEqual({ applied: [] });
    expect(readLedger()).toEqual(old);
    expect(fs.readFileSync(path.join(root, "config", "capabilities.json"), "utf8")).toBe(
      '{"keep":true}',
    );
  });

  it("does not overwrite a capabilities record the owner already has when the ledger is new", () => {
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(path.join(root, "config", "capabilities.json"), '{"schema":2,"x":true}');
    runner.run(root, "1.2.5.8");
    expect(fs.readFileSync(path.join(root, "config", "capabilities.json"), "utf8")).toBe(
      '{"schema":2,"x":true}',
    );
  });

  it("writes a .bak of the ledger before it applies something new", () => {
    fs.mkdirSync(path.join(root, "database"), { recursive: true });
    fs.writeFileSync(runner.ledgerFile(root), "[]");
    let seenBackup = "";
    const probe = {
      id: "9000-probe",
      describe: "reads the backup while it runs",
      run() {
        seenBackup = fs.readFileSync(`${runner.ledgerFile(root)}.bak`, "utf8");
      },
    };
    expect(runner.run(root, "2.0.0", { migrations: [probe] }).applied).toEqual(["9000-probe"]);
    expect(seenBackup).toBe("[]");
    expect(readLedger().map((row: { id: string }) => row.id)).toEqual(["9000-probe"]);
  });

  it("never throws: a failing migration is reported, earlier ones stay recorded, later ones wait", () => {
    const ok = { id: "9001-ok", describe: "ok", run() {} };
    const bad = {
      id: "9002-bad",
      describe: "fails",
      run() {
        throw new Error("disk is full");
      },
    };
    const later = { id: "9003-later", describe: "never reached", run() {} };
    const result = runner.run(root, "2.0.0", { migrations: [ok, bad, later] });
    expect(result.applied).toEqual(["9001-ok"]);
    expect(result.error).toContain("9002-bad");
    expect(result.error).toContain("disk is full");
    expect(readLedger().map((row: { id: string }) => row.id)).toEqual(["9001-ok"]);
  });

  it("never throws on a missing root and leaves a damaged ledger untouched", () => {
    expect(runner.run("", "1.0.0")).toMatchObject({ applied: [], error: expect.any(String) });
    fs.mkdirSync(path.join(root, "database"), { recursive: true });
    fs.writeFileSync(runner.ledgerFile(root), "{not json");
    const result = runner.run(root, "1.0.0");
    expect(result.applied).toEqual([]);
    expect(result.error).toBeTruthy();
    expect(fs.readFileSync(runner.ledgerFile(root), "utf8")).toBe("{not json");
  });

  it("is switched off by FRIDAY_DATA_MIGRATIONS=0 and writes nothing", () => {
    const result = runner.run(root, "1.0.0", { env: { FRIDAY_DATA_MIGRATIONS: "0" } });
    expect(result).toEqual({ applied: [], skipped: "disabled" });
    expect(fs.existsSync(path.join(root, "database"))).toBe(false);
    expect(fs.existsSync(path.join(root, "config"))).toBe(false);
  });
});

describe("the CommonJS runner and installer/migration share one list", () => {
  it("declares exactly the migration ids that installer/migration/index.ts declares", () => {
    const source = fs.readFileSync(path.join(repo, "installer/migration/index.ts"), "utf8");
    const declared = [...source.matchAll(/^\s*id:\s*"(\d{4}-[^"]+)"/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect(runner.MIGRATIONS.map((m) => m.id)).toEqual(declared);
    expect(TS_MIGRATIONS.map((m) => m.id)).toEqual(declared);
  });

  it("leaves the same ledger ids and the same files as the TypeScript runner", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "friday-data-migrations-ts-"));
    try {
      runner.run(root, "3.0.0");
      runMigrations(other, "3.0.0");
      const ids = (dir: string) =>
        JSON.parse(fs.readFileSync(path.join(dir, "database", "migrations.json"), "utf8")).map(
          (row: { id: string; appVersion?: string }) => [row.id, row.appVersion],
        );
      expect(ids(root)).toEqual(ids(other));
      expect(fs.readFileSync(path.join(root, "config", "capabilities.json"), "utf8")).toBe(
        fs.readFileSync(path.join(other, "config", "capabilities.json"), "utf8"),
      );
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("updater/migration passes the new version to the ledger", () => {
  it("stamps every newly applied migration with the version it updated to", () => {
    const report = migrateAfterUpdate("1.2.5.7", "1.2.5.8", root);
    expect(report.from).toBe("1.2.5.7");
    expect(report.to).toBe("1.2.5.8");
    expect(report.applied.length).toBeGreaterThan(0);
    for (const record of report.applied) expect(record.appVersion).toBe("1.2.5.8");
  });

  it("stamps nothing when the target version is unknown", () => {
    const report = migrateAfterUpdate("1.2.5.7", null, root);
    for (const record of report.applied) expect(record).not.toHaveProperty("appVersion");
  });
});

describe("the ledger backup is never overwritten by a damaged file", () => {
  const throwing = {
    id: "9002-bad",
    describe: "fails",
    run() {
      throw new Error("disk is full");
    },
  };
  const old = [{ id: "0000-old", appliedAt: 1 }];
  const writeLedgerFiles = (main: string | null, bak: string | null) => {
    fs.mkdirSync(path.join(root, "database"), { recursive: true });
    if (main !== null) fs.writeFileSync(runner.ledgerFile(root), main);
    if (bak !== null) fs.writeFileSync(`${runner.ledgerFile(root)}.bak`, bak);
  };
  const bakFile = () => `${runner.ledgerFile(root)}.bak`;

  it("keeps a good .bak when the main file is damaged and the only pending step throws", () => {
    writeLedgerFiles("{not json", JSON.stringify(old));
    const result = runner.run(root, "2.0.0", { migrations: [throwing] });
    expect(result.applied).toEqual([]);
    expect(result.error).toContain("9002-bad");
    expect(JSON.parse(fs.readFileSync(bakFile(), "utf8"))).toEqual(old);
    expect(fs.readFileSync(runner.ledgerFile(root), "utf8")).toBe("{not json");
  });

  it("writes no .bak at all when nothing was applied and none existed", () => {
    writeLedgerFiles(JSON.stringify(old), null);
    runner.run(root, "2.0.0", { migrations: [throwing] });
    expect(fs.existsSync(bakFile())).toBe(false);
    expect(readLedger()).toEqual(old);
  });

  it("copies the readable main file to .bak once a step was applied", () => {
    writeLedgerFiles(JSON.stringify(old), null);
    const ok = { id: "9001-ok", describe: "ok", run() {} };
    expect(runner.run(root, "2.0.0", { migrations: [ok] }).applied).toEqual(["9001-ok"]);
    expect(JSON.parse(fs.readFileSync(bakFile(), "utf8"))).toEqual(old);
    expect(readLedger().map((row: { id: string }) => row.id)).toEqual(["0000-old", "9001-ok"]);
  });

  it("recovers from a good .bak when the main file is damaged and does not poison the .bak", () => {
    writeLedgerFiles("{not json", JSON.stringify(old));
    const ok = { id: "9001-ok", describe: "ok", run() {} };
    expect(runner.run(root, "2.0.0", { migrations: [ok] }).applied).toEqual(["9001-ok"]);
    expect(readLedger().map((row: { id: string }) => row.id)).toEqual(["0000-old", "9001-ok"]);
    expect(JSON.parse(fs.readFileSync(bakFile(), "utf8"))).toEqual(old);
  });
});

describe("both runners treat a damaged ledger the same way", () => {
  const damagedFixtures: [string, string, string | null][] = [
    ["main is not JSON and there is no backup", "{not json", null],
    ["main is JSON but not a list and there is no backup", '{"id":"x"}', null],
    ["main and backup are both damaged", "{not json", "[oops"],
  ];
  for (const [name, main, bak] of damagedFixtures) {
    it(`refuses and changes nothing when ${name}`, () => {
      const other = fs.mkdtempSync(path.join(os.tmpdir(), "friday-data-migrations-ts-"));
      try {
        for (const dir of [root, other]) {
          fs.mkdirSync(path.join(dir, "database"), { recursive: true });
          fs.writeFileSync(path.join(dir, "database", "migrations.json"), main);
          if (bak !== null)
            fs.writeFileSync(path.join(dir, "database", "migrations.json.bak"), bak);
        }
        const cjs = runner.run(root, "3.0.0");
        migrateAfterUpdate("2.0.0", "3.0.0", other);
        expect(cjs.applied).toEqual([]);
        for (const dir of [root, other]) {
          expect(fs.readFileSync(path.join(dir, "database", "migrations.json"), "utf8")).toBe(main);
          expect(fs.existsSync(path.join(dir, "config", "capabilities.json"))).toBe(false);
        }
      } finally {
        fs.rmSync(other, { recursive: true, force: true });
      }
    });
  }

  it("both recover the same rows from a good backup when the main file is damaged", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "friday-data-migrations-ts-"));
    try {
      for (const dir of [root, other]) {
        fs.mkdirSync(path.join(dir, "database"), { recursive: true });
        fs.writeFileSync(path.join(dir, "database", "migrations.json"), "{not json");
        fs.writeFileSync(
          path.join(dir, "database", "migrations.json.bak"),
          JSON.stringify([{ id: "0000-old", appliedAt: 1 }]),
        );
      }
      runner.run(root, "3.0.0");
      migrateAfterUpdate("2.0.0", "3.0.0", other);
      const ids = (dir: string) =>
        JSON.parse(fs.readFileSync(path.join(dir, "database", "migrations.json"), "utf8")).map(
          (row: { id: string }) => row.id,
        );
      expect(ids(root)).toEqual(["0000-old", "0001-config-capabilities"]);
      expect(ids(other)).toEqual(ids(root));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("states in the updater module that the CommonJS runner exists too", () => {
    const source = fs.readFileSync(path.join(repo, "updater/migration/index.ts"), "utf8");
    expect(source).not.toContain("exactly one place");
  });
});

describe("the ledger reading rule exists once", () => {
  it("installer/migration reads and settles the ledger through the CommonJS runner", () => {
    const source = fs.readFileSync(path.join(repo, "installer/migration/index.ts"), "utf8");
    expect(source).toContain("electron/data-migrations.cjs");
    expect(source).toMatch(/bootRunner\.readLedger\(/);
    expect(source).toMatch(/bootRunner\.settleLedger\(/);
    expect(source).not.toMatch(/JSON\.parse/);
    expect(source).not.toContain("copyFileSync");
  });
});
