/**
 * <root>/inventory.json writes down where each thing FRIDAY uses is installed,
 * from the real scan and the real folders, and only rewrites when it changed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const inventory = require("../../electron/install-inventory.cjs");
const registry = require("../../electron/root-registry.cjs");

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-inventory-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const tool = (over: Record<string, unknown>) => ({
  id: "x",
  category: "Tool",
  installed: true,
  version: "1.0.0",
  path: null,
  manager: "winget",
  status: "Ready",
  ...over,
});

describe("install homes", () => {
  it("puts pip libraries in the managed environment, tools FRIDAY unpacked in runtime, system installs on the machine", () => {
    const unpacked = path.join(root, "runtime", "node", "node.exe");
    expect(inventory.homeOf(tool({ manager: "pip" }), root)).toBe("friday-python-env");
    expect(inventory.homeOf(tool({ manager: "npm" }), root)).toBe("npm-global");
    expect(inventory.homeOf(tool({ manager: "vendor", path: unpacked }), root)).toBe(
      "friday-runtime",
    );
    expect(inventory.homeOf(tool({ path: "C:\\Program Files\\Git\\cmd\\git.exe" }), root)).toBe(
      "machine",
    );
    // A tool FRIDAY has not unpacked yet would be unpacked into runtime, not scattered.
    expect(inventory.homeOf(tool({ manager: "vendor", installed: false, path: null }), root)).toBe(
      "friday-runtime",
    );
  });

  it("never names the program folder as a home", () => {
    expect(Object.keys(inventory.HOMES).some((home) => /app/i.test(home))).toBe(false);
  });
});

describe("inventory.json", () => {
  const scan = {
    at: 1_700_000_000_000,
    tools: [
      tool({ id: "Git", path: "C:\\Program Files\\Git\\cmd\\git.exe", version: "2.50.0" }),
      tool({ id: "FFmpeg", version: "9.0" }),
      tool({ id: "faster-whisper", manager: "pip", version: "1.2.0" }),
      tool({ id: "Rust", installed: false, version: null, status: "Missing" }),
      tool({ id: "Git alias", aliasOf: "Git" }),
    ],
  };

  it("lists tools with their home, flags updates and skips duplicate alias rows", () => {
    fs.mkdirSync(path.join(root, "models", "qwen2.5-1.5b-instruct"), { recursive: true });
    fs.mkdirSync(path.join(root, "cache", "stt", "small"), { recursive: true });
    const built = inventory.buildInventory(root, {
      tools: scan.tools,
      latest: { Git: "2.51.0", FFmpeg: { version: "9.0" } },
      version: "1.1.4.5",
      at: scan.at,
    });
    const byId = Object.fromEntries(built.items.map((row: { id: string }) => [row.id, row]));
    expect(byId["Git"].home).toBe("machine");
    expect(byId["Git"].updateAvailable).toBe(true);
    expect(byId["Git"].removedByDeleteAllData).toBe(false);
    expect(byId["FFmpeg"].updateAvailable).toBe(false);
    expect(byId["faster-whisper"].home).toBe("friday-python-env");
    expect(byId["faster-whisper"].removedByDeleteAllData).toBe(true);
    expect(byId["Rust"].installed).toBe(false);
    expect(byId["Git alias"]).toBeUndefined();
    expect(byId["qwen2.5-1.5b-instruct"].home).toBe("friday-models");
    expect(byId["stt-small"].home).toBe("friday-speech");
    expect(built.totals.updatesAvailable).toBe(1);
    expect(built.totals.byHome["machine"]).toBe(2);
  });

  it("writes once, and rewrites only when something changed", () => {
    const first = inventory.writeInventory(root, scan, { version: "1.1.4.5" });
    expect(first.written).toBe(true);
    expect(inventory.readInventory(root).items.length).toBeGreaterThan(0);
    const later = { ...scan, at: scan.at + 60_000 };
    expect(inventory.writeInventory(root, later, { version: "1.1.4.5" }).written).toBe(false);
    fs.mkdirSync(path.join(root, "models", "new-model"), { recursive: true });
    expect(inventory.writeInventory(root, scan, { version: "1.1.4.5" }).written).toBe(true);
  });

  it("does nothing without a root or a scan", () => {
    expect(inventory.writeInventory("", scan).written).toBe(false);
    expect(inventory.writeInventory(root, null).written).toBe(false);
    expect(fs.existsSync(path.join(root, inventory.FILE))).toBe(false);
  });

  it("is one of the root's own descriptors and is wired to the scan", () => {
    expect(registry.DESCRIPTOR_FILES).toContain(inventory.FILE);
    const main = fs.readFileSync(path.join(__dirname, "..", "..", "electron", "main.cjs"), "utf8");
    expect(main).toContain("recordInventory(scan)");
    expect(main).toContain("recordInventory(toolchain.lastDetected())");
  });
});
