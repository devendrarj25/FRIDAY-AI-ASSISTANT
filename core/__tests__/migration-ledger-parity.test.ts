/**
 * FRIDAY · migration ledger: one reading rule
 *
 * electron/data-migrations.cjs (boot) and installer/migration/index.ts (the typed runner the updater uses) read
 * the same ledger, database/migrations.json. The reading rule lives once, in the CommonJS module
 * (readLedger, settleLedger), and the typed runner calls it. This table feeds the same fixtures to both runners
 * and fails when their outcomes differ, so a damaged ledger is never "left as it is" by one and "restored from
 * the backup and run" by the other.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { runMigrations, appliedMigrations, settleLedger } from "../../installer/migration";

const require = createRequire(import.meta.url);
const repo = path.resolve(__dirname, "../..");
const boot = require(path.join(repo, "electron/data-migrations.cjs")) as {
  ledgerFile: (root: string) => string;
  run: (root: string, appVersion?: string | null) => { applied: string[]; error?: string };
  readLedger: (
    root: string,
    options?: Record<string, unknown>,
  ) => { rows: { id: string }[]; source: "file" | "backup" | "none" } | null;
  settleLedger: (root: string, options?: Record<string, unknown>) => boolean;
};

const BOM = String.fromCharCode(0xfeff);
const OLD = JSON.stringify([{ id: "0000-old", appliedAt: 1 }]);
const NEW_ID = "0001-config-capabilities";

type Fixture = {
  name: string;
  main: string | Buffer | "dir" | null;
  bak: string | Buffer | null;
  /** The ledger ids after a run, or "unreadable" when the main file is left as it is. */
  after: string[] | "left";
};

const fixtures: Fixture[] = [
  { name: "no ledger at all", main: null, bak: null, after: [NEW_ID] },
  { name: "a good main file", main: OLD, bak: null, after: ["0000-old", NEW_ID] },
  { name: "main is {} and the backup is good", main: "{}", bak: OLD, after: ["0000-old", NEW_ID] },
  {
    name: "main is null and the backup is good",
    main: "null",
    bak: OLD,
    after: ["0000-old", NEW_ID],
  },
  {
    name: "main is a number and the backup is good",
    main: "7",
    bak: OLD,
    after: ["0000-old", NEW_ID],
  },
  { name: "main is {} and there is no backup", main: "{}", bak: null, after: "left" },
  { name: "main is null and there is no backup", main: "null", bak: null, after: "left" },
  {
    name: "main is truncated and the backup is good",
    main: '[{"id":"0000-old","appliedAt":1',
    bak: OLD,
    after: ["0000-old", NEW_ID],
  },
  {
    name: "main is truncated and there is no backup",
    main: '[{"id":"0000-',
    bak: null,
    after: "left",
  },
  {
    name: "main starts with a byte order mark",
    main: `${BOM}${OLD}`,
    bak: null,
    after: ["0000-old", NEW_ID],
  },
  {
    name: "the backup starts with a byte order mark and main is damaged",
    main: "{not json",
    bak: `${BOM}${OLD}`,
    after: ["0000-old", NEW_ID],
  },
  {
    name: "main is missing and the backup is good",
    main: null,
    bak: OLD,
    after: ["0000-old", NEW_ID],
  },
  { name: "main is missing and the backup is damaged", main: null, bak: "[oops", after: "left" },
  { name: "main and backup are both damaged", main: "{not json", bak: "[oops", after: "left" },
  { name: "main and backup are both valid but not lists", main: "{}", bak: "{}", after: "left" },
  { name: "main is empty and the backup is good", main: "", bak: OLD, after: ["0000-old", NEW_ID] },
  { name: "main is empty and there is no backup", main: "", bak: null, after: "left" },
  { name: "main is empty and the backup is empty", main: "", bak: "", after: "left" },
  {
    name: "main cannot be replaced (a folder stands in its place) and the backup is good",
    main: "dir",
    bak: OLD,
    after: "left",
  },
];

let dirs: string[] = [];
const makeRoot = (fixture: Fixture) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-ledger-parity-"));
  dirs.push(root);
  fs.mkdirSync(path.join(root, "database"), { recursive: true });
  const file = boot.ledgerFile(root);
  if (fixture.main === "dir") fs.mkdirSync(file);
  else if (fixture.main !== null) fs.writeFileSync(file, fixture.main);
  if (fixture.bak !== null) fs.writeFileSync(`${file}.bak`, fixture.bak);
  return root;
};
beforeEach(() => {
  dirs = [];
});
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** What the owner can see afterwards: the ledger ids, or "left" when the main file was not rewritten. */
function outcome(root: string, fixture: Fixture) {
  const file = boot.ledgerFile(root);
  const stat = fs.existsSync(file) ? fs.statSync(file) : null;
  let ids: string[] | "left" = "left";
  if (stat?.isFile()) {
    try {
      const rows = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(rows) && rows.some((row: { id: string }) => row.id === NEW_ID))
        ids = rows.map((row: { id: string }) => row.id);
    } catch {
      /* damaged and left as it is */
    }
  }
  const bak = fs.existsSync(`${file}.bak`) ? fs.readFileSync(`${file}.bak`, "utf8") : null;
  return { ids, bak, expectedBak: fixture.bak };
}

describe("both ledger runners reach the same outcome on every damaged-ledger fixture", () => {
  for (const fixture of fixtures) {
    it(`${fixture.name}`, () => {
      const bootRoot = makeRoot(fixture);
      const typedRoot = makeRoot(fixture);
      const bootResult = boot.run(bootRoot, "3.0.0");
      let typedThrew = false;
      try {
        runMigrations(typedRoot, "3.0.0");
      } catch {
        typedThrew = true;
      }
      expect(typedThrew).toBe(false);
      const fromBoot = outcome(bootRoot, fixture);
      const fromTyped = outcome(typedRoot, fixture);
      expect(fromBoot.ids).toEqual(fixture.after);
      expect(fromTyped.ids).toEqual(fixture.after);
      // A backup is only ever replaced by a copy of a good ledger, never by a damaged one.
      for (const result of [fromBoot, fromTyped]) {
        if (fixture.after === "left") expect(result.bak).toBe(fixture.bak);
      }
      if (fixture.after === "left") {
        expect(bootResult.applied).toEqual([]);
        expect(fs.existsSync(path.join(typedRoot, "config", "capabilities.json"))).toBe(false);
      }
    });
  }
});

describe("readLedger is one rule for every caller", () => {
  const readCases: [Fixture, "file" | "backup" | "none" | null][] = [
    [{ name: "none", main: null, bak: null, after: [] }, "none"],
    [{ name: "main", main: OLD, bak: "[oops", after: [] }, "file"],
    [{ name: "bom main", main: `${BOM}${OLD}`, bak: null, after: [] }, "file"],
    [{ name: "object main", main: "{}", bak: OLD, after: [] }, "backup"],
    [{ name: "null main", main: "null", bak: OLD, after: [] }, "backup"],
    [{ name: "empty main", main: "", bak: OLD, after: [] }, "backup"],
    [{ name: "missing main", main: null, bak: OLD, after: [] }, "backup"],
    [{ name: "both damaged", main: "{x", bak: "[x", after: [] }, null],
    [{ name: "object main alone", main: "{}", bak: null, after: [] }, null],
  ];
  for (const [fixture, source] of readCases) {
    it(`${fixture.name}: ${source ?? "damaged"}`, () => {
      const root = makeRoot(fixture);
      const ledger = boot.readLedger(root);
      expect(ledger?.source ?? null).toBe(source);
      if (source === "file" || source === "backup")
        expect(ledger?.rows.map((row) => row.id)).toEqual(["0000-old"]);
      if (source === "none") expect(ledger?.rows).toEqual([]);
      // The typed side reports the same rows.
      expect(appliedMigrations(root).map((row) => row.id)).toEqual(
        ledger ? ledger.rows.map((row) => row.id) : [],
      );
    });
  }
});

describe("settleLedger restores a damaged main file from a good backup and never throws", () => {
  it("copies the backup over a damaged main file, byte for byte", () => {
    const root = makeRoot({ name: "x", main: "{}", bak: OLD, after: [] });
    expect(boot.settleLedger(root)).toBe(true);
    expect(fs.readFileSync(boot.ledgerFile(root), "utf8")).toBe(OLD);
    expect(fs.readFileSync(`${boot.ledgerFile(root)}.bak`, "utf8")).toBe(OLD);
  });

  it("is the same function the typed runner exports", () => {
    const root = makeRoot({ name: "x", main: "null", bak: OLD, after: [] });
    expect(settleLedger(root)).toBe(true);
    expect(fs.readFileSync(boot.ledgerFile(root), "utf8")).toBe(OLD);
  });

  it("leaves a readable or absent ledger alone", () => {
    const good = makeRoot({ name: "x", main: OLD, bak: "[oops", after: [] });
    expect(boot.settleLedger(good)).toBe(true);
    expect(fs.readFileSync(`${boot.ledgerFile(good)}.bak`, "utf8")).toBe("[oops");
    const none = makeRoot({ name: "x", main: null, bak: null, after: [] });
    expect(boot.settleLedger(none)).toBe(true);
    expect(fs.existsSync(boot.ledgerFile(none))).toBe(false);
  });

  it("answers false and changes nothing when the ledger cannot be read", () => {
    const root = makeRoot({ name: "x", main: "{x", bak: "[x", after: [] });
    expect(boot.settleLedger(root)).toBe(false);
    expect(fs.readFileSync(boot.ledgerFile(root), "utf8")).toBe("{x");
  });

  it("answers false instead of throwing when the main file is locked", () => {
    const root = makeRoot({ name: "x", main: "{}", bak: OLD, after: [] });
    const locked = {
      ...fs,
      copyFileSync() {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      },
    };
    expect(boot.settleLedger(root, { fsApi: locked })).toBe(false);
    expect(fs.readFileSync(boot.ledgerFile(root), "utf8")).toBe("{}");
    expect(fs.readFileSync(`${boot.ledgerFile(root)}.bak`, "utf8")).toBe(OLD);
  });
});
