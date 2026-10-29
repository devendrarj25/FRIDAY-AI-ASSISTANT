/**
 * When FRIDAY is installed inside its own checkout and the registry entry or
 * settings pointer is gone, the build still finds that folder as the home.
 */
import { afterEach, describe, expect, it } from "vitest";
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
