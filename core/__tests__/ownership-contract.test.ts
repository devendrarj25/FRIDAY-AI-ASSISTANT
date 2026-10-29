/**
 * One answer to "what may an update touch": program is replaced by a package,
 * shared keeps the owner's additions, data is never replaced or deleted. The
 * importer, the update safety net and the storage janitor all read it.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const contract = require("../../electron/friday-contract.cjs");
const safety = require("../../electron/update-safety.cjs");
const storage = require("../../electron/storage-manager.cjs");
const importer = require("../../electron/importer.cjs");

const { OWNERSHIP } = contract;
const kinds = ["program", "shared", "data"] as const;

describe("ownership contract", () => {
  it("puts every top-level folder in exactly one class", () => {
    const seen = new Map<string, string>();
    for (const kind of kinds) {
      for (const name of OWNERSHIP[kind] as string[]) {
        expect(seen.has(name), `${name} is in ${seen.get(name)} and ${kind}`).toBe(false);
        seen.set(name, kind);
      }
    }
  });

  it("classifies every canonical folder of the FRIDAY root", () => {
    for (const name of contract.NAMES as string[]) {
      expect(contract.ownerOf(name), `${name} has no owner class`).not.toBeNull();
    }
    for (const extra of ["brain-data", "conversations", "backup"]) {
      expect(contract.ownerOf(extra)).toBe("data");
    }
  });

  it("only ever lets an update replace the program", () => {
    expect(contract.ownerOf("app/FRIDAY.exe")).toBe("program");
    expect(contract.ownerOf("memory/long_term/a.json")).toBe("data");
    expect(contract.ownerOf("Models/x.gguf")).toBe("shared");
    expect(contract.ownerOf("somewhere-new/file")).toBeNull();
    for (const name of contract.NEVER_DELETED as string[]) {
      expect(OWNERSHIP.program).not.toContain(name);
    }
  });

  it("is the list every update path uses", () => {
    expect(safety.PROTECTED).toEqual(OWNERSHIP.backedUp);
    for (const name of OWNERSHIP.backedUp)
      expect(OWNERSHIP.data.concat(OWNERSHIP.shared)).toContain(name);
    expect([...safety.MUST_PRESERVE].sort()).toEqual([...contract.NEVER_DELETED].sort());
    // The janitor empties only the temporary parts of these four; the rest it may never touch.
    const swept = new Set(["temporary", "cache", "updates", "logs", "installer"]);
    for (const name of [...OWNERSHIP.data, ...OWNERSHIP.shared]) {
      if (swept.has(name)) expect(storage.PROTECTED_AREAS, name).not.toContain(name);
      else expect(storage.PROTECTED_AREAS, name).toContain(name);
    }
  });

  it("keeps the owner's data when a source update carries a file at the same path", () => {
    for (const name of OWNERSHIP.data as string[]) {
      expect(importer.isUserData(`${name}/anything.json`), name).toBe(true);
    }
    // Code and configuration that ship in the repo still update.
    for (const name of ["src", "electron", "kernel", "models", "config", "skills"]) {
      expect(importer.isUserData(`${name}/file.ts`), name).toBe(false);
    }
  });
});
