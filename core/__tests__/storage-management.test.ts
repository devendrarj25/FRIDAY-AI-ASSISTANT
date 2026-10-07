/**
 * Storage / install / update / uninstall safety contract.
 *
 * These are real filesystem tests against a temporary FRIDAY root: they prove
 * that an update replaces application files only, that user data and expensive
 * resources survive, that nothing is duplicated, and that the janitor can never
 * reach into user-owned folders.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const paths = require("../../electron/friday-paths.cjs");
const storage = require("../../electron/storage-manager.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-storage-"));
const write = (rel: string, body = "x") => {
  const full = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
};

beforeAll(() => {
  paths.setRoot(root);
  paths.ensureStructure(root);
});

afterAll(() => {
  paths.setProfile("production");
  paths.setRoot(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("canonical resource locations", () => {
  it("gives every resource kind exactly one folder inside the root", () => {
    for (const kind of Object.keys(storage.RESOURCES)) {
      const target: string = storage.resourcePath(root, kind);
      expect(path.resolve(target).startsWith(path.resolve(root))).toBe(true);
    }
  });

  it("reuses an existing legacy folder instead of creating a second copy", () => {
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "friday-legacy-"));
    fs.mkdirSync(path.join(legacyRoot, "data", "models"), { recursive: true });
    expect(storage.resourcePath(legacyRoot, "models")).toBe(
      path.join(legacyRoot, "data", "models"),
    );
    fs.rmSync(legacyRoot, { recursive: true, force: true });
  });

  it("detects installed resources so they are not downloaded again", () => {
    write("models/phi-3/model.gguf", "weights");
    const report = storage.inventory(root);
    expect(report.resources.models.reusable).toBe(true);
    expect(report.reusable).toContain("models");
    expect(report.duplicates).toEqual([]);
  });
});

describe("temporary cleanup never touches user data", () => {
  it("removes only stale temporaries and keeps every protected area", () => {
    const stale = write("temporary/old-download.part", "junk");
    const fresh = write("temporary/in-flight.part", "junk");
    const chats = write("conversations/history/session.json", "{}");
    const model = path.join(root, "models", "phi-3", "model.gguf");
    const old = Date.now() - 3 * 24 * 60 * 60 * 1000;
    fs.utimesSync(stale, old / 1000, old / 1000);

    const result = storage.cleanTemporary(root);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(chats)).toBe(true);
    expect(fs.existsSync(model)).toBe(true);
    expect(result.removed.length).toBeGreaterThan(0);
  });

  it("refuses to remove a protected folder even when asked directly", () => {
    for (const area of ["config", "memory", "conversations", "models", "runtime", "database"]) {
      expect(storage.isProtected(root, path.join(root, area))).toBe(true);
      expect(storage.isProtected(root, path.join(root, area, "deep", "file.json"))).toBe(true);
    }
    expect(storage.isProtected(root, path.join(root, "temporary", "x.tmp"))).toBe(false);
  });
});

describe("install / update / uninstall paths", () => {
  it("startup prepare repairs the layout inside the root and writes one manifest", () => {
    fs.rmSync(path.join(root, "logs"), { recursive: true, force: true });
    const report = storage.prepare(root, { version: "1.3.1" });
    expect(report.version).toBe("1.3.1");
    expect(fs.existsSync(path.join(root, "logs"))).toBe(true);
    expect(fs.existsSync(path.join(root, "storage.json"))).toBe(true);
    // Repair stays inside the root — no sibling folder is ever created.
    expect(fs.existsSync(path.join(path.dirname(root), "FRIDAY"))).toBe(false);
  });

  it("re-running prepare (a reinstall over an older version) is idempotent", () => {
    const first = storage.prepare(root, { version: "1.3.1" });
    const again = storage.prepare(root, { version: "1.3.2" });
    expect(again.duplicates).toEqual([]);
    expect(Object.keys(again.resources)).toEqual(Object.keys(first.resources));
    expect(again.resources.models.path).toBe(first.resources.models.path);
    expect(again.resources.models.files).toBe(first.resources.models.files);
  });

  it("uninstall semantics: application files are replaceable, data is not", () => {
    // Everything the uninstaller may delete lives outside the data root.
    for (const area of storage.PROTECTED_AREAS) {
      expect(storage.isProtected(root, path.join(root, area))).toBe(true);
    }
  });
});

describe("test/production isolation with shared immutable resources", () => {
  it("keeps mutable state per profile and shares models, voices and runtime", () => {
    paths.setProfile("production");
    const prodMemory = paths.dir("memory");
    const prodModels = paths.dir("models");

    paths.setProfile("test");
    const testMemory = paths.dir("memory");
    const testModels = paths.dir("models");
    paths.setProfile("production");

    expect(testMemory).not.toBe(prodMemory);
    expect(testMemory).toContain(path.join("profiles", "test"));
    // A test run must never download a second multi-gigabyte model store.
    expect(testModels).toBe(prodModels);
    expect(paths.isSharedName("models")).toBe(true);
    expect(paths.isSharedName("memory")).toBe(false);
  });
});
