/**
 * Every Install Manager tool has a real way to be installed, or an explicit,
 * explained reason it does not. Nothing is left as a bare "Manual".
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const toolchain = require_(path.join(root, "electron/toolchain.cjs"));
const vendor = require_(path.join(root, "electron/vendor-sources.cjs"));

type Tool = Record<string, unknown> & { id: string };
const tools = toolchain.TOOLS as Tool[];

/** Installed by something other than the owner's package manager: a vendor wizard or hardware. */
const VENDOR_ONLY = [
  "LocalAI",
  "NVIDIA Driver",
  "Android SDK cmdline-tools",
  "ONNX DirectML",
  "AMD ROCm",
];

describe("install routes", () => {
  it("each tool installs by winget, pip, npm, a pinned or feed installer, another tool, a custom command or a Windows feature", () => {
    const routeless = tools.filter(
      (t) =>
        !(
          t["winget"] ||
          t["pip"] ||
          t["npm"] ||
          t["installerUrl"] ||
          t["builtin"] ||
          t["installVia"] ||
          t["customCommand"] ||
          t["optionalFeature"] ||
          t["release"] ||
          vendor.hasFeed(t.id)
        ),
    );
    expect(routeless.map((t) => t.id).sort()).toEqual([...VENDOR_ONLY].sort());
  });

  it("the ones left to the vendor say why and where to go", () => {
    for (const id of VENDOR_ONLY) {
      const tool = tools.find((t) => t.id === id)!;
      expect(String(tool["manual"] || "").length, id).toBeGreaterThan(20);
      expect(String(tool["url"]), id).toMatch(/^https:\/\//);
    }
  });

  it("a tool installed through another tool points at one that exists and can install", () => {
    const via = tools.filter((t) => t["installVia"]);
    expect(via.map((t) => t.id).sort()).toEqual(["Docker Compose", "Whisper.cpp"]);
    for (const tool of via) {
      const target = toolchain.toolById(tool["installVia"] as string);
      expect(target, tool.id).toBeTruthy();
      expect(target.installVia, `${tool.id} -> ${target.id}`).toBeUndefined();
    }
  });

  it("a component that is part of something else is never uninstalled on its own", () => {
    for (const id of ["npm", "Docker Compose", "Whisper.cpp", "WSL 2", "Playwright browsers"]) {
      expect(tools.find((t) => t.id === id)!["noUninstall"], id).toBe(true);
    }
  });

  it("every feed belongs to a tool in the list", () => {
    const ids = new Set(tools.map((t) => t.id));
    for (const id of vendor.feedIds()) expect(ids.has(id), id).toBe(true);
  });

  it("the Playwright, WSL and npm routes build the documented commands", async () => {
    const find = (id: string) =>
      tools.find((t) => t.id === id) as Tool & { customCommand?: () => Promise<unknown> };
    const wsl = find("WSL 2");
    if (process.platform === "win32") {
      expect(await wsl.customCommand!()).toEqual(["wsl", ["--install", "--no-distribution"]]);
    }
    expect(wsl["elevate"]).toBe(true);
    expect(wsl["restartMayBeNeeded"]).toBe(true);
    expect(find("npm")["npm"]).toBe("npm");
    expect(typeof find("Playwright browsers").customCommand).toBe("function");
    expect(typeof find("Playwright browsers")["detect"]).toBe("function");
  });
});
