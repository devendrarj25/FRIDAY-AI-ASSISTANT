/**
 * The packaged app has two homes: resources/app.asar (the renderer, electron/ and release-engine) and the folders
 * beside it that electron-builder copies as extraResources (kernel, config, docs, ...). Inside the app
 * `__dirname/..` is the archive root, so a module that names `kernel/` from `__dirname` alone finds nothing, and
 * Python cannot read a script out of an archive anyway. These tests pin that every such reach goes through
 * resource-paths first, that everything the code asks for is shipped, and that the owner's own files are not.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const check = require_("../../scripts/packaged-requires.cjs") as {
  checkAsarPaths: (o?: { root?: string }) => Array<{ file: string; folder: string }>;
  checkResourceReferences: (o?: {
    root?: string;
    extraResources?: string[];
  }) => Array<{ file: string; wanted: string }>;
  OUTSIDE_ASAR: Set<string>;
};
const paths = require_("../../electron/resource-paths.cjs") as {
  resolveResourceFile: (name: string) => string | null;
  resolveResourceDir: (name: string) => string | null;
};

const folders: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "friday-pack-"));
  folders.push(dir);
  return dir;
};
const realResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (realResourcesPath) Object.defineProperty(process, "resourcesPath", realResourcesPath);
  else delete (process as unknown as Record<string, unknown>)["resourcesPath"];
});

describe("nothing reaches a folder outside app.asar from __dirname alone", () => {
  it("holds for every module in electron/", () => {
    expect(check.checkAsarPaths({ root })).toEqual([]);
  });

  it("flags a module that does, and accepts one that resolves through resource-paths first", () => {
    const fake = temp();
    mkdirSync(path.join(fake, "electron"));
    writeFileSync(
      path.join(fake, "electron", "bad.cjs"),
      'const path = require("node:path");\nconst S = path.join(__dirname, "..", "kernel", "x.py");\n',
    );
    writeFileSync(
      path.join(fake, "electron", "good.cjs"),
      'const path = require("node:path");\nconst P = require("./resource-paths.cjs").resolveResourceFile("kernel/x.py") || path.join(__dirname, "..", "kernel", "x.py");\n',
    );
    writeFileSync(
      path.join(fake, "electron", "engine.cjs"),
      'const e = require(path.resolve(__dirname, "..", "scripts", "release-engine.cjs"));\n',
    );
    writeFileSync(
      path.join(fake, "electron", "scripts.cjs"),
      'const e = path.join(__dirname, "..", "scripts", "other.cjs");\n',
    );
    const found = check.checkAsarPaths({ root: fake });
    expect(found.map((f) => `${f.file}:${f.folder}`).sort()).toEqual([
      "electron/bad.cjs:kernel",
      "electron/scripts.cjs:scripts",
    ]);
  });

  it("knows the folders electron-builder ships beside the archive", () => {
    for (const folder of ["kernel", "docs", "config", "skills", "resources", "installer"]) {
      expect(check.OUTSIDE_ASAR.has(folder), folder).toBe(true);
    }
    for (const folder of ["electron", "dist-desktop", "node_modules"]) {
      expect(check.OUTSIDE_ASAR.has(folder), folder).toBe(false);
    }
  });
});

describe("everything the code asks resource-paths for is shipped", () => {
  it("holds for the repository's electron-builder.yml", () => {
    expect(check.checkResourceReferences({ root })).toEqual([]);
  });

  it("flags a request for something that is not copied", () => {
    const fake = temp();
    mkdirSync(path.join(fake, "electron"));
    writeFileSync(
      path.join(fake, "electron", "m.cjs"),
      'const a = resolveResourceFile("docs/FRIDAY_MCP.md");\nconst b = resolveResourceFile("docs/OTHER.md");\nconst c = resolveResourceDir("kernel");\n',
    );
    const found = check.checkResourceReferences({
      root: fake,
      extraResources: ["docs/FRIDAY_MCP.md", "kernel"],
    });
    expect(found).toEqual([{ file: "electron/m.cjs", wanted: "docs/OTHER.md" }]);
  });

  it("ships the MCP guide and the build verifies every file the installed app reads from resources/", () => {
    expect(readFileSync(path.join(root, "electron-builder.yml"), "utf8")).toMatch(
      /from: docs\/FRIDAY_MCP\.md\s+to: docs\/FRIDAY_MCP\.md/,
    );
    const verify = readFileSync(path.join(root, "scripts/verify-build.cjs"), "utf8");
    for (const needle of [
      '"document_ocr.py"',
      '"tools.py"',
      '"finetune_lora.py"',
      '"FRIDAY_MCP.md"',
      '"install-extensions.json"',
      "provider-keys.json",
      "install-extensions.user.json",
    ]) {
      expect(verify, needle).toContain(needle);
    }
  });
});

describe("the modules that used to miss the packaged kernel now find it", () => {
  it("resolve kernel scripts and the MCP guide from resources/ when it is there, ahead of the checkout", () => {
    const fake = temp();
    mkdirSync(path.join(fake, "kernel"));
    mkdirSync(path.join(fake, "docs"));
    for (const name of ["document_ocr.py", "tools.py", "voice_runtime.py"]) {
      cpSync(path.join(root, "kernel", name), path.join(fake, "kernel", name));
    }
    cpSync(path.join(root, "docs", "FRIDAY_MCP.md"), path.join(fake, "docs", "FRIDAY_MCP.md"));
    Object.defineProperty(process, "resourcesPath", { value: fake, configurable: true });
    expect(paths.resolveResourceFile("kernel/document_ocr.py")).toBe(
      path.join(fake, "kernel", "document_ocr.py"),
    );
    expect(paths.resolveResourceDir("kernel")).toBe(path.join(fake, "kernel"));
    expect(paths.resolveResourceFile("docs/FRIDAY_MCP.md")).toBe(
      path.join(fake, "docs", "FRIDAY_MCP.md"),
    );
    // The MCP catalog reads the kernel tool table with no root given, as the shared server does.
    const catalog = require_("../../electron/mcp-catalog.cjs") as {
      loadKernelRisk: (root?: string) => Record<string, string>;
    };
    expect(Object.keys(catalog.loadKernelRisk()).length).toBeGreaterThan(20);
  });

  it("the three modules take their paths from resource-paths, not from __dirname alone", () => {
    const read = (file: string) => readFileSync(path.join(root, file), "utf8");
    expect(read("electron/document-extract.cjs")).toContain(
      'resolveResourceFile("kernel/document_ocr.py")',
    );
    expect(read("electron/kernel-tool-run.cjs")).toContain('resolveResourceDir("kernel")');
    expect(read("electron/stt.cjs")).toContain('resolveResourceFile("kernel/voice_runtime.py")');
    expect(read("electron/mcp-catalog.cjs")).toContain('resolveResourceFile("kernel/tools.py")');
    expect(read("electron/mcp-server.cjs")).toContain('resolveResourceFile("docs/FRIDAY_MCP.md")');
  });
});
