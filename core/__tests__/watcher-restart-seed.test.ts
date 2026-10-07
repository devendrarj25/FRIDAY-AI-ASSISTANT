import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WorkspaceWatcher } = require("../../electron/watcher.cjs");

let root: string | null = null;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("workspace watcher restart detection", () => {
  it("seeds hashes at start so an unchanged config rewrite raises no restart", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-watch-"));
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    const file = path.join(root, "config", "kernel.yaml");
    fs.writeFileSync(file, "port: 8765\n");

    const events: { restartRequired: boolean }[] = [];
    const watcher = new WorkspaceWatcher((event: { restartRequired: boolean }) =>
      events.push(event),
    );
    watcher.root = root;
    watcher.seedRestartHashes(root);

    // Identical bytes rewritten (FRIDAY re-serialising its own config).
    fs.writeFileSync(file, "port: 8765\n");
    watcher.emit("config", "kernel.yaml", path.join("config", "kernel.yaml"));
    expect(events).toHaveLength(0);

    // Real content change still reports restartRequired.
    fs.writeFileSync(file, "port: 9000\n");
    watcher.emit("config", "kernel.yaml", path.join("config", "kernel.yaml"));
    expect(events).toHaveLength(1);
    expect(events[0]?.restartRequired).toBe(true);

    watcher.stop();
  });

  it("ignores companion-features.json so live republishes do not toast", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isIgnored } = require("../../electron/watcher.cjs") as {
      isIgnored: (relative: string) => boolean;
    };
    expect(isIgnored("config/companion-features.json")).toBe(true);
    expect(isIgnored("config/kernel.yaml")).toBe(false);
  });
});
