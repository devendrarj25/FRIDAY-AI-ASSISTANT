/**
 * The runtimes the project runner starts (Maven, Gradle, Composer, dotnet-script) install unattended: pinned
 * official archives whose SHA-256 was checked against the digest the vendor publishes, a launcher for the PHP
 * archive, and `dotnet tool install` for the C# script runner. Nothing here downloads.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const toolchain = require_("../../electron/toolchain.cjs") as {
  toolById: (id: string) => Record<string, any> | null;
  installerCommand?: (file: string, tool: unknown, root: string) => [string, string[]];
  commandFor?: (tool: unknown, action: string) => Promise<[string, string[]] | null>;
};
const temp: string[] = [];
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const folder = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-runtime-"));
  temp.push(dir);
  return dir;
};

describe("pinned official archives", () => {
  it.each([
    ["Gradle", "services.gradle.org", "gradle-9.9.1/bin/gradle.bat"],
    ["Maven", "archive.apache.org", "apache-maven-3.9.9/bin/mvn.cmd"],
    ["Composer", "getcomposer.org", "composer.bat"],
  ])(
    "%s comes from its vendor over https, with a SHA-256 and the program it unpacks",
    (id, host, bin) => {
      const tool = toolchain.toolById(id)!;
      expect(new URL(tool["installerUrl"]).protocol).toBe("https:");
      expect(new URL(tool["installerUrl"]).hostname).toBe(host);
      expect(tool["sha256"]).toMatch(/^[0-9a-f]{64}$/);
      expect(tool["needBytes"]).toBeGreaterThan(1_000_000);
      expect(tool["archiveBin"]).toBe(bin);
      expect(tool["required"]).toBeFalsy();
    },
  );
});

describe("Composer", () => {
  it("keeps composer.phar beside a launcher that runs it with PHP", () => {
    const root = folder();
    const file = path.join(root, "composer.phar");
    writeFileSync(file, "phar bytes");
    const tool = toolchain.toolById("Composer")!;
    const install = (toolchain as any).installerCommand as (
      f: string,
      t: unknown,
      r: string,
    ) => unknown;
    expect(typeof install).toBe("function");
    const command = install(file, tool, root) as [string, string[]];
    expect(command[1]).toEqual(["-e", "process.exit(0)"]);
    const dest = path.join(root, "runtime", "Composer");
    expect(readFileSync(path.join(dest, "composer.phar"), "utf8")).toBe("phar bytes");
    const bat = readFileSync(path.join(dest, "composer.bat"), "utf8");
    expect(bat).toBe('@echo off\r\nphp "%~dp0composer.phar" %*\r\n');
    expect(existsSync(path.join(dest, "composer.bat"))).toBe(true);
  });
});

describe("dotnet-script", () => {
  it("installs, updates and uninstalls through `dotnet tool`", async () => {
    const tool = toolchain.toolById("dotnet-script")!;
    const command = (toolchain as any).commandFor as (
      t: unknown,
      a: string,
    ) => Promise<[string, string[]]>;
    expect(await command(tool, "install")).toEqual([
      "dotnet",
      ["tool", "install", "--global", "dotnet-script"],
    ]);
    expect(await command(tool, "update")).toEqual([
      "dotnet",
      ["tool", "update", "--global", "dotnet-script"],
    ]);
    expect(await command(tool, "uninstall")).toEqual([
      "dotnet",
      ["tool", "uninstall", "--global", "dotnet-script"],
    ]);
  });

  it("is queued after the .NET SDK and the C# runner is told where to look", () => {
    const catalog = readFileSync(
      path.resolve(__dirname, "../../src/lib/friday/catalog.ts"),
      "utf8",
    );
    expect(catalog).toContain('"dotnet-script": [".NET SDK"]');
    expect(catalog).toContain('Composer: ["PHP"]');
    const manifest = JSON.parse(
      readFileSync(path.resolve(__dirname, "../../config/agent-toolkit.json"), "utf8"),
    );
    const order = manifest.prefetch.map((row: { id: string }) => row.id);
    expect(order.indexOf(".NET SDK")).toBeLessThan(order.indexOf("dotnet-script"));
    expect(order.indexOf("PHP")).toBeLessThan(order.indexOf("Composer"));
    expect(order.indexOf("OpenJDK (Temurin)")).toBeLessThan(order.indexOf("Maven"));
    expect(order.indexOf("OpenJDK (Temurin)")).toBeLessThan(order.indexOf("Gradle"));
  });
});
