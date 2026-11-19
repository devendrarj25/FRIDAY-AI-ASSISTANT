/**
 * When FRIDAY is installed inside its own checkout and the registry entry or
 * settings pointer is gone, the build still finds that folder as the home.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const root = createRequire(import.meta.url)("../../scripts/friday-root.cjs") as {
  fromOwnCheckout: (project: string) => string | null;
};

const folders: string[] = [];
const folder = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "friday-checkout-"));
  folders.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("own checkout as the FRIDAY home", () => {
  it("is the home when the app and its database sit in it", () => {
    const dir = folder();
    mkdirSync(path.join(dir, "App"), { recursive: true });
    mkdirSync(path.join(dir, "database"), { recursive: true });
    writeFileSync(path.join(dir, "App", "FRIDAY.exe"), "");
    writeFileSync(path.join(dir, "database", "friday.sqlite3"), "");
    expect(root.fromOwnCheckout(dir)).toBe(dir);
  });

  it("is not guessed from a plain source checkout", () => {
    const dir = folder();
    mkdirSync(path.join(dir, "database"), { recursive: true });
    writeFileSync(path.join(dir, "database", "friday.sqlite3"), "");
    expect(root.fromOwnCheckout(dir)).toBeNull();
    expect(root.fromOwnCheckout(folder())).toBeNull();
  });
});

describe("the folder the setup CMD runs in as the FRIDAY home", () => {
  const api = root as unknown as {
    workspaceRootOrDev: (o: { platform: string; project: string; record: boolean }) => {
      root: string;
      development: boolean;
      fromCheckout?: boolean;
    };
    isUsableHome: (project: string) => boolean;
  };
  const saved = { a: process.env["FRIDAY_WORKSPACE_ROOT"], b: process.env["APPDATA"] };
  beforeEach(() => {
    // No recorded folder: an empty settings location, so the answer does not depend on this machine.
    process.env["APPDATA"] = folder();
  });
  afterEach(() => {
    if (saved.a === undefined) delete process.env["FRIDAY_WORKSPACE_ROOT"];
    else process.env["FRIDAY_WORKSPACE_ROOT"] = saved.a;
    if (saved.b === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = saved.b;
  });

  it("is the home on Windows whatever the folder is called, when no other folder was chosen", () => {
    delete process.env["FRIDAY_WORKSPACE_ROOT"];
    const dir = path.join(folder(), "any name at all");
    mkdirSync(dir);
    const picked = api.workspaceRootOrDev({ platform: "win32", project: dir, record: false });
    expect(picked.root).toBe(dir);
    expect(picked.development).toBe(false);
    expect(picked.fromCheckout).toBe(true);
  });

  it("keeps the development folder off Windows", () => {
    delete process.env["FRIDAY_WORKSPACE_ROOT"];
    const dir = folder();
    const picked = api.workspaceRootOrDev({ platform: "linux", project: dir, record: false });
    expect(picked.development).toBe(true);
    expect(picked.root).toBe(path.join(dir, ".friday-dev"));
  });

  it("an explicit folder always wins over the checkout", () => {
    const other = folder();
    process.env["FRIDAY_WORKSPACE_ROOT"] = other;
    const picked = api.workspaceRootOrDev({ platform: "win32", project: folder(), record: false });
    expect(picked.root).toBe(path.resolve(other));
    expect(picked.fromCheckout).toBeUndefined();
  });

  it("never treats program files, node_modules, a test sandbox or an unwritable folder as a home", () => {
    expect(api.isUsableHome("C:\\Program Files\\FRIDAY")).toBe(false);
    expect(api.isUsableHome("C:\\Program Files (x86)\\FRIDAY")).toBe(false);
    expect(api.isUsableHome("C:\\Windows\\System32")).toBe(false);
    expect(api.isUsableHome("D:\\work\\app\\node_modules\\friday")).toBe(false);
    expect(api.isUsableHome("C:\\Users\\a\\AppData\\Local\\Temp\\friday-readiness-abc123")).toBe(
      false,
    );
    expect(api.isUsableHome(path.join(folder(), "does-not-exist"))).toBe(false);
    expect(api.isUsableHome(folder())).toBe(true);
  });
});
