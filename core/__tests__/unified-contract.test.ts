import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { TREES as coreTrees } from "../discovery";
import { fridayFolders } from "../paths";

const root = resolve(__dirname, "../..");
const require_ = createRequire(import.meta.url);
const contract = require_(join(root, "electron/friday-contract.cjs"));
const paths = require_(join(root, "electron/friday-paths.cjs"));
const workspace = require_(join(root, "electron/workspace.cjs"));
const capabilities = require_(join(root, "electron/capabilities.cjs"));

/**
 * One structure contract: the path resolver, workspace verification and both
 * discovery passes must agree, or a folder can be "required" by one subsystem
 * and unknown to another.
 */
describe("unified FRIDAY contract", () => {
  it("resolves paths and workspace folders from the same registry", () => {
    expect(paths.NAMES).toEqual(contract.NAMES);
    expect(workspace.REQUIRED_FOLDERS ?? contract.requiredFolders()).toEqual(
      contract.requiredFolders(),
    );
    expect(fridayFolders()).toEqual(contract.requiredFolders());
  });

  it("uses one capability-tree definition for both discovery passes", () => {
    expect(Object.keys(coreTrees).sort()).toEqual(Object.keys(contract.TREES).sort());
    for (const tree of Object.keys(contract.TREES)) {
      expect(coreTrees[tree as keyof typeof coreTrees].segments).toEqual(
        contract.TREES[tree].segments,
      );
    }
  });

  it("gives every TREES key a FOLDERS home so ensureStructure owns the writable tree", () => {
    for (const tree of Object.keys(contract.TREES)) {
      expect(contract.FOLDERS[tree], tree).toBeTruthy();
    }
  });

  it("ensureStructure creates exactly what verifyWorkspace requires", () => {
    const target = mkdtempSync(join(tmpdir(), "friday-contract-"));
    paths.setRoot(target);
    paths.ensureStructure(target);
    paths.setRoot(null);
    const report = workspace.verifyWorkspace(target);
    expect(report.missing).toEqual([]);
    for (const relative of contract.requiredFolders()) {
      expect(existsSync(join(target, ...relative.split("/")))).toBe(true);
    }
    expect(existsSync(join(target, "tools", "filesystem"))).toBe(true);
    expect(existsSync(join(target, "skills", "core"))).toBe(true);
  });

  it("keeps TREES segments (including tools/filesystem) on the one folder contract", () => {
    expect(contract.requiredFolders()).toContain("tools/filesystem");
    expect(contract.requiredFolders()).toContain("skills/core");
    expect(contract.requiredFolders()).toContain("tools/manifests");
    expect(contract.SOURCE_LAYOUT.trees.capabilities.folders).toEqual(
      contract.capabilityLayoutFolders(),
    );
    expect(contract.SOURCE_LAYOUT.trees.capabilities.folders).toContain("tools/filesystem");
  });

  it("repairs TREES segments under a live alias instead of a second store", () => {
    const target = mkdtempSync(join(tmpdir(), "friday-alias-"));
    mkdirSync(join(target, "Tools"));
    workspace.repairWorkspace(target, { files: false });
    expect(existsSync(join(target, "Tools", "filesystem"))).toBe(true);
    // NTFS folds Tools and tools into one directory, so the live alias is the
    // stored casing. A second store shows up as a second directory entry.
    const toolDirs = readdirSync(target)
      .filter((name) => name.toLowerCase() === "tools")
      .sort();
    expect(toolDirs).toEqual(["Tools"]);
  });

  it("does not treat the Git kernel/ tree as the backend data folder during repair", () => {
    const target = mkdtempSync(join(tmpdir(), "friday-repair-kernel-"));
    mkdirSync(join(target, "kernel"));
    writeFileSync(join(target, "kernel", "main.py"), "print('kernel')\n");
    writeFileSync(join(target, "kernel", "requirements.txt"), "fastapi>=0.115\n");
    workspace.repairWorkspace(target, { files: false });
    expect(existsSync(join(target, "backend", "api"))).toBe(true);
    expect(existsSync(join(target, "kernel", "api"))).toBe(false);
    expect(existsSync(join(target, "kernel", "main.py"))).toBe(true);
  });

  it("declares no second folder or tree registry in the resolvers", () => {
    for (const file of ["electron/friday-paths.cjs", "electron/workspace.cjs"]) {
      expect(readFileSync(join(root, file), "utf8")).toContain("friday-contract.cjs");
    }
    expect(readFileSync(join(root, "electron/capabilities.cjs"), "utf8")).toContain(
      "friday-contract.cjs",
    );
  });

  it("treats a capability with a missing entry file as not installed", () => {
    const report = capabilities.list({ appRoot: root, workspaceRoot: null });
    expect(report.items.length).toBeGreaterThan(0);
    for (const item of report.items) {
      expect(typeof item.installed).toBe("boolean");
      if (item.installed) expect(item.problems).toEqual([]);
    }
  });
});
