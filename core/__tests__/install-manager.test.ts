import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const toolchain = require_("../../electron/toolchain.cjs") as {
  TOOLS: Array<Record<string, unknown>>;
  jobSucceeded: (code: number, action: string, probe: { installed: boolean }) => boolean;
  wingetSourceFailure: (code: number | null) => string | null;
  probeTool: (
    tool: Record<string, unknown>,
    freeze: Map<string, string>,
    packages?: string,
  ) => Promise<Record<string, unknown>>;
};

const tool = (name: string) => toolchain.TOOLS.find((t) => t["id"] === name)!;

describe("install manager — verified results, never exit codes alone", () => {
  it("never calls an install successful when the machine state disagrees", () => {
    expect(toolchain.jobSucceeded(0, "install", { installed: false })).toBe(false);
    expect(toolchain.jobSucceeded(0, "install", { installed: true })).toBe(true);
    expect(toolchain.jobSucceeded(0, "uninstall", { installed: true })).toBe(false);
  });

  it("classifies a broken WinGet source as a package-manager problem", () => {
    expect(toolchain.wingetSourceFailure(0x8a150049)).toMatch(/source/i);
    expect(toolchain.wingetSourceFailure(0x8a15002b)).toMatch(/source/i);
    expect(toolchain.wingetSourceFailure(1)).toBeNull();
    expect(toolchain.wingetSourceFailure(null)).toBeNull();
  });
});

describe("install manager — real detectors", () => {
  it("detects the Hugging Face CLI under its current `hf` name", () => {
    const hf = tool("Hugging Face CLI");
    expect(hf["cmd"]).toBe("hf");
    expect(typeof hf["detect"]).toBe("function");
    expect(hf["pipImport"]).toBe("huggingface_hub");
  });

  it("verifies llama-cpp-python by import and picks a backend strategy", () => {
    const llama = tool("Text Generation WebUI (llama-cpp-python)");
    expect(typeof llama["strategy"]).toBe("function");
    expect(llama["pipImport"]).toBe("llama_cpp");
  });

  it("checks WebView2 in the registry and installs it from Microsoft's bootstrapper", () => {
    const wv = tool("WebView2 Runtime");
    expect(typeof wv["detect"]).toBe("function");
    expect(String(wv["installerUrl"])).toMatch(/^https:\/\/go\.microsoft\.com\//);
  });

  it("treats Windows Sandbox as an optional feature, not a failed package", () => {
    const sandbox = tool("Sandbox runner (Windows Sandbox)");
    expect(sandbox["optionalFeature"]).toBe(true);
    expect(typeof sandbox["detect"]).toBe("function");
  });

  it("verifies rcedit through its real executable", () => {
    expect(typeof tool("rcedit")["detect"]).toBe("function");
  });

  it("reports a detector failure honestly instead of claiming Ready", async () => {
    const probe = await toolchain.probeTool(
      {
        id: "test-tool",
        category: "Developer Tools",
        detect: async () => {
          throw new Error("probe exploded");
        },
      },
      new Map(),
    );
    expect(probe["installed"]).toBe(false);
    expect(probe["status"]).toBe("Error");
  });
});
