import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const toolchain = require_("../../electron/toolchain.cjs") as {
  TOOLS: Array<Record<string, unknown>>;
  repairedWingetSource: unknown;
  ensureManagedPython: unknown;
};
const engines = require_("../../electron/sandbox-engines.cjs") as {
  ENGINES: Array<{ id: string }>;
  RESTART_MESSAGE: string;
};

describe("install queue recovers instead of asking the owner to do it by hand", () => {
  it("routes Windows Sandbox through the restart-aware engine manager", () => {
    const sandbox = toolchain.TOOLS.find((t) => t["id"] === "Sandbox runner (Windows Sandbox)")!;
    expect(sandbox["optionalFeature"]).toBe(true);
    expect(sandbox["engineId"]).toBe("windows-sandbox");
    expect(engines.ENGINES.some((e) => e.id === sandbox["engineId"])).toBe(true);
    expect(engines.RESTART_MESSAGE).toMatch(/restart windows/i);
  });

  it("repairs a refused WinGet source itself", () => {
    expect(typeof toolchain.repairedWingetSource).toBe("function");
  });

  it("can build a managed Python runtime for wheels the system Python lacks", () => {
    expect(typeof toolchain.ensureManagedPython).toBe("function");
    const llama = toolchain.TOOLS.find(
      (t) => t["id"] === "Text Generation WebUI (llama-cpp-python)",
    )!;
    expect(typeof llama["strategy"]).toBe("function");
  });
});
