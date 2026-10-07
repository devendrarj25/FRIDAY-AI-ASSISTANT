/**
 * BUG 4 — the "config reloaded / companion-features.json" toast kept coming
 * back. The renderer republishes the companion feature list on every capability
 * registry notification, and most of those carry an identical list. The file
 * was written each time (with a fresh timestamp), the workspace watcher saw a
 * changed file, and the toast fired forever.
 *
 * The contract now: an identical publish touches nothing on disk.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const paths = require_("../../electron/friday-paths.cjs") as {
  writeIfChanged: (target: string, body: string) => boolean;
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "friday-companion-"));

const body = (features: string[]) =>
  JSON.stringify({ features, capabilities: [{ id: "ollama", available: true }] }, null, 2);

describe("companion feature registry writes", () => {
  it("writes the first time and leaves the file untouched for an identical publish", async () => {
    const dir = tmp();
    const target = path.join(dir, "companion-features.json");

    expect(paths.writeIfChanged(target, body(["chat", "voice"]))).toBe(true);
    const firstMtime = fs.statSync(target).mtimeMs;

    await new Promise((r) => setTimeout(r, 20));
    // Ten identical republishes, exactly like a burst of registry ticks.
    for (let i = 0; i < 10; i += 1) {
      expect(paths.writeIfChanged(target, body(["chat", "voice"]))).toBe(false);
    }
    // Not rewritten: same mtime means the watcher never fires, so no toast.
    expect(fs.statSync(target).mtimeMs).toBe(firstMtime);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does write when the capability list genuinely changes", () => {
    const dir = tmp();
    const target = path.join(dir, "companion-features.json");
    paths.writeIfChanged(target, body(["chat"]));
    expect(paths.writeIfChanged(target, body(["chat", "voice"]))).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf8")).features).toEqual(["chat", "voice"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stores no volatile timestamp, so identical content stays byte-identical", () => {
    const dir = tmp();
    const target = path.join(dir, "companion-features.json");
    paths.writeIfChanged(target, body(["chat"]));
    const stored = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(stored.at).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
