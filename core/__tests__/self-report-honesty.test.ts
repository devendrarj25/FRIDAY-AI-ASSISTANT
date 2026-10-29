import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  isProblemCheck,
  optionalDiagramChecks,
  stepsFor,
} from "../../src/lib/friday/doctor-engine";
import { waveCapabilityChecks } from "../../src/lib/friday/failure-guard";
import { systemPlatform } from "../../src/lib/friday/system-map";
import { toolchainDoctorRows } from "../../src/lib/friday/toolchain-manifest";

const require_ = createRequire(import.meta.url);
const archIndex = require_(join(__dirname, "../../electron/architecture-index.cjs")) as {
  SCHEMA: number;
  withoutTemplates: (text: string) => string;
  buildIndex: (root: string) => { totals: { broken: number }; broken: unknown[] };
};

/** The owner's 2026-10-22 Self-Management report: 23 critical, mostly not real. */
describe("Self-Management report", () => {
  it("never counts an optional add-on that is not installed as a problem", () => {
    const rows = [
      ...optionalDiagramChecks(),
      ...toolchainDoctorRows(),
      ...waveCapabilityChecks({}).filter((row) => row.id === "speaker:ecapa"),
    ];
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) {
      expect(row.optional, row.id).toBe(true);
      expect(isProblemCheck(row as never), row.id).toBe(false);
    }
    expect(isProblemCheck({ status: "Missing" })).toBe(true);
  });

  it("does not claim an install it never probed", () => {
    for (const row of optionalDiagramChecks()) {
      expect(row.status).toBe("Missing");
      expect(row.detail).toMatch(/^Optional, not checked yet by Install Manager\./);
    }
  });

  it("tells the owner to press Install, not that a key or driver is needed", () => {
    const steps = stepsFor({
      id: "x",
      label: "Graphviz compiler",
      group: "Diagrams",
      status: "Missing",
      detail: "Optional.",
      fix: "Install Graphviz from Install Manager.",
      fixable: false,
    });
    expect(steps.join(" ")).toContain("Open Install Manager");
    expect(steps.join(" ")).not.toContain("key, driver, account");
  });

  it("says the desktop OS, not the 'browser' placeholder, before the registry loads", () => {
    const placeholder = { platform: "browser", updatedAt: null };
    expect(systemPlatform(placeholder, true, { platform: "Win32" })).toBe("Win32");
    expect(systemPlatform(placeholder, true, null)).toBe("desktop");
    expect(systemPlatform(placeholder, false, null)).toBe("browser");
    expect(systemPlatform({ platform: "win32", updatedAt: 1 }, true, { platform: "x" })).toBe(
      "win32",
    );
  });

  it("indexes this checkout with no broken import", () => {
    expect(archIndex.SCHEMA).toBe(3);
    expect(archIndex.withoutTemplates('a `require("./agent.cjs")` b')).toBe("a `` b");
    const index = archIndex.buildIndex(join(__dirname, "../.."));
    expect(index.broken).toEqual([]);
  });
});
