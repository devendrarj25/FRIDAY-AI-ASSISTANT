import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(__dirname, "../..");
const require_ = createRequire(import.meta.url);
const paths = require_(join(root, "electron/friday-paths.cjs"));

/**
 * The renderer keeps a fast browser copy of every namespace, but that copy
 * lives with Chromium's profile — outside the FRIDAY folder. The root stamps
 * itself so a cache from a deleted or different root can never act as a second
 * store.
 */
describe("storage identity", () => {
  beforeEach(() => paths.setRoot(null));

  it("writes one stable identity inside the selected root", () => {
    const home = mkdtempSync(join(tmpdir(), "friday-identity-"));
    paths.setRoot(home);
    const first = paths.storageIdentity({ create: true });
    expect(first.id).toBeTruthy();
    expect(resolve(first.root)).toBe(resolve(home));
    expect(existsSync(paths.storageIdentityFile())).toBe(true);
    expect(paths.storageIdentity({ create: true }).id).toBe(first.id);
    paths.setRoot(null);
  });

  it("issues a new identity when the root is deleted and recreated", () => {
    const home = mkdtempSync(join(tmpdir(), "friday-identity-"));
    paths.setRoot(home);
    const first = paths.storageIdentity({ create: true });
    rmSync(home, { recursive: true, force: true });
    const second = paths.storageIdentity({ create: true });
    expect(second.id).not.toBe(first.id);
    paths.setRoot(null);
  });

  it("issues a different identity for a different folder", () => {
    const a = mkdtempSync(join(tmpdir(), "friday-identity-a-"));
    const b = mkdtempSync(join(tmpdir(), "friday-identity-b-"));
    paths.setRoot(a);
    const first = paths.storageIdentity({ create: true });
    paths.setRoot(b);
    const second = paths.storageIdentity({ create: true });
    expect(second.id).not.toBe(first.id);
    paths.setRoot(null);
  });

  it("never writes an identity outside a selected root", () => {
    paths.setRoot(null);
    const record = paths.storageIdentity({ create: true });
    expect(record.root).toBeFalsy();
  });
});
