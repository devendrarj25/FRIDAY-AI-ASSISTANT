/**
 * Four gaps read from a real `npm run setup` log on a Windows PC (2026-11-19):
 *  - .NET SDK 8.0.428 was kept as "already installed" although .NET 8 is out of support (10 November 2026);
 *  - CMake 4.5.1, unpacked by the first run and recorded to be used first, was not in front of PATH when the
 *    next run looked, so it found 4.4.4 again and downloaded 4.5.1 again;
 *  - installing dotnet-script printed the .NET welcome and telemetry text, sent usage data and created an ASP.NET
 *    Core HTTPS development certificate in the user's certificate store;
 *  - the pip line added the download cache and the unpacked packages, so every package was counted twice.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const toolkit = require_("../../scripts/prefetch-toolkit.cjs");
const manifest = require_("../../config/agent-toolkit.json") as {
  prefetch: Array<{ id: string; minVersion?: string }>;
};
const toolchain = require_("../../electron/toolchain.cjs");
const activity = require_("../../electron/activity.cjs");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe(".NET SDK on the supported line", () => {
  const entries = manifest.prefetch.filter((row) => row.id === ".NET SDK");
  const plan = (version: string | undefined) =>
    toolkit.toolkitPlan({
      detected: { ".NET SDK": { installed: true, version } },
      entries,
    })[0];

  it("installs the supported SDK beside an older one", () => {
    expect(entries[0]!.minVersion).toBe("10.0");
    expect(plan("8.0.428")).toMatchObject({
      action: "install",
      older: "8.0.428",
      minVersion: "10.0",
    });
    expect(plan("9.0.300").action).toBe("install");
  });

  it("keeps an SDK that is on the line, and does not guess when the version is unknown", () => {
    expect(plan("10.0.100").action).toBe("keep");
    expect(plan("11.0.0").action).toBe("keep");
    expect(plan(undefined).action).toBe("keep");
  });

  it("is installed through winget as Microsoft.DotNet.SDK.10, and a failed install keeps the older SDK", async () => {
    expect(toolchain.toolById(".NET SDK").winget).toBe("Microsoft.DotNet.SDK.10");
    const lines: string[] = [];
    const rows = await toolkit.prefetchToolkit("C:/friday", {
      platform: "win32",
      env: { CI: "", GITHUB_ACTIONS: "" },
      ledger: toolkit.memoryLedger(),
      progressLine: () => "",
      log: (line: string) => lines.push(line),
      toolchain: {
        detectTools: async () => ({
          tools: manifest.prefetch.map((row) => ({
            id: row.id,
            installed: true,
            version: row.id === ".NET SDK" ? "8.0.428" : "99.0.0",
          })),
        }),
        wingetUpgrades: async () => ({}),
        toolById: (id: string) => ({ id }),
        latestFor: async () => null,
        runJob: async () => ({ ok: false, error: "winget failed" }),
      },
    });
    const dotnet = rows.find((row: { id: string }) => row.id === ".NET SDK");
    expect(dotnet).toMatchObject({ ok: true, outdated: true });
    expect(lines.join("\n")).toContain("8.0.428 is older than the supported line");
    expect(lines.join("\n")).toContain(".NET SDK 10.0 was not installed; 8.0.428 stays in use");
    expect(lines.join("\n")).not.toContain("FAIL");
  });
});

describe("a copy FRIDAY unpacked herself is in front of PATH from the start of the next run", () => {
  it("applies the managed folders before it detects anything", async () => {
    const order: string[] = [];
    await toolkit.prefetchToolkit("C:/friday", {
      platform: "win32",
      env: { CI: "", GITHUB_ACTIONS: "" },
      ledger: toolkit.memoryLedger(),
      progressLine: () => "",
      log: () => {},
      toolchain: {
        syncExtensions: () => order.push("extensions"),
        applyManagedPath: (r: string) => order.push(`path:${r}`),
        detectTools: async () => {
          order.push("detect");
          return {
            tools: manifest.prefetch.map((row) => ({
              id: row.id,
              installed: true,
              version: "99.0.0",
            })),
          };
        },
        wingetUpgrades: async () => ({}),
        toolById: (id: string) => ({ id }),
        latestFor: async () => null,
        runJob: async () => ({ ok: true }),
      },
    });
    expect(order.indexOf("path:C:/friday")).toBeGreaterThan(-1);
    expect(order.indexOf("path:C:/friday")).toBeLessThan(order.indexOf("detect"));
  });
});

describe("tools run through the .NET command line", () => {
  it("get no banner, no telemetry and no development certificate", () => {
    const env = toolchain.childEnv("dotnet", { KEEP: "1" });
    expect(env).toMatchObject({
      KEEP: "1",
      DOTNET_NOLOGO: "1",
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
      DOTNET_GENERATE_ASPNET_CERTIFICATE: "false",
    });
    expect(toolchain.childEnv("/usr/share/dotnet/dotnet", {})).toHaveProperty("DOTNET_NOLOGO");
    expect(toolchain.childEnv("winget", { KEEP: "1" })).toEqual({ KEEP: "1" });
  });

  it("is the environment every job command is started with", () => {
    expect(read("electron/toolchain.cjs")).toContain("env: childEnv(cmd),");
  });
});

describe("the pip size line", () => {
  it("counts the larger of the cache and the unpacked packages, not both", () => {
    const base = mkdtempSync(path.join(tmpdir(), "friday-pip-"));
    try {
      const cache = path.join(base, "cache");
      const packages = path.join(base, "site-packages");
      mkdirSync(cache);
      mkdirSync(packages);
      writeFileSync(path.join(cache, "wheel"), Buffer.alloc(1000));
      writeFileSync(path.join(packages, "pkg"), Buffer.alloc(3000));
      expect(activity.sizeOfAll([cache, packages])).toBe(4000);
      expect(activity.sizeOfAll([cache, packages], "max")).toBe(3000);
      expect(activity.sizeOfAll([], "max")).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("is what setup:python asks for", () => {
    const python = read("scripts/setup-python.cjs");
    expect(python).toContain('{ combine: "max" }');
    expect(read("scripts/with-activity.cjs")).toContain('combine === "max" ? "max" : "sum"');
  });
});
