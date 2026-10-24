/**
 * Tools FRIDAY unpacked under <root>\runtime are found by the scan (so they are
 * not downloaded again) and are on PATH for the things she starts.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const managed = require_(path.join(root, "electron/managed-path.cjs"));
const toolchain = require_(path.join(root, "electron/toolchain.cjs"));

function fakeRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-managed-"));
  const put = (...parts: string[]) => {
    mkdirSync(path.join(dir, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(path.join(dir, ...parts), "x");
  };
  return { dir, put };
}

describe("managed tool folders", () => {
  it("lists only archive tools that are really there, and not stored installers", () => {
    const { dir, put } = fakeRoot();
    try {
      put("runtime", "MinGit", "cmd", "git.exe");
      put("runtime", "FRIDAY_Python", "python", "python.exe");
      put("runtime", "w64devkit", "w64devkit-x64-2.10.0.7z.exe");
      const tools = [
        { id: "MinGit", archiveBin: "cmd/git.exe" },
        { id: "FRIDAY Python", archiveBin: "python/python.exe" },
        { id: "w64devkit", archiveBin: "w64devkit-x64-2.10.0.7z.exe", storeOnly: true },
        { id: "FRIDAY Node", archiveBin: "node/node.exe" },
      ];
      const dirs = managed.managedBinDirs(dir, tools);
      expect(dirs).toEqual(
        [
          path.join(dir, "runtime", "MinGit", "cmd"),
          path.join(dir, "runtime", "FRIDAY_Python", "python"),
        ]
          .concat([])
          .slice(0, 2),
      );
      expect(dirs.some((d: string) => d.includes("w64devkit"))).toBe(false);
      expect(dirs.some((d: string) => d.includes("FRIDAY_Node"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends to PATH after the system entries and never twice", () => {
    const sep = path.delimiter;
    const out = managed.withManagedPath(["/usr/bin", "/bin"].join(sep), ["/r/git", "/usr/bin"]);
    expect(out.split(sep)).toEqual(["/usr/bin", "/bin", "/r/git"]);
    expect(managed.withManagedPath(out, ["/r/git"])).toBe(out);
  });

  it("writes the list for the kernel and leaves the registry alone", () => {
    const { dir, put } = fakeRoot();
    try {
      put("runtime", "gh", "bin", "gh.exe");
      const env: Record<string, string> = { PATH: "/usr/bin" };
      const result = managed.applyManagedPath(dir, [{ id: "gh", archiveBin: "bin/gh.exe" }], env);
      expect(result.dirs).toEqual([path.join(dir, "runtime", "gh", "bin")]);
      expect(env["PATH"]!.endsWith(path.join(dir, "runtime", "gh", "bin"))).toBe(true);
      const saved = JSON.parse(
        readFileSync(path.join(dir, "runtime", "managed-path.json"), "utf8"),
      );
      expect(saved.dirs).toEqual(result.dirs);
      expect(managed.applyManagedPath("", [], env)).toEqual({ dirs: [], changed: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the scan sees FRIDAY's own installs", () => {
  it("probes archive tools against the root it is given", async () => {
    const { dir, put } = fakeRoot();
    try {
      put("runtime", "MinGit", "cmd", "git.exe");
      const found = await toolchain.detectTools({ force: true, root: dir });
      const git = found.tools.find((t: { id: string }) => t.id === "MinGit");
      expect(git.installed).toBe(true);
      expect(git.path).toBe(path.join(dir, "runtime", "MinGit", "cmd", "git.exe"));
      const without = await toolchain.detectTools({ force: true, root: path.join(dir, "empty") });
      expect(without.tools.find((t: { id: string }) => t.id === "MinGit").installed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("defaults to the FRIDAY root so no caller can forget it", () => {
    const source = readFileSync(path.join(root, "electron/toolchain.cjs"), "utf8");
    expect(source).toContain('const root = rootArg ?? fridayPaths.root() ?? "";');
    expect(source).toContain("probeTool(t, freeze, installedPackages, root)");
  });
});

describe("install markers and pins", () => {
  const installs = require_(path.join(root, "electron/managed-install.cjs"));

  it("finds a tool whose folder carries its version, and knows its version", () => {
    const { dir, put } = fakeRoot();
    try {
      const tool = {
        id: "FRIDAY Node",
        archiveBin: "node-v22.23.3-win-x64/node.exe",
        pinVersion: "22.23.3",
      };
      expect(installs.installedBin(dir, tool)).toBeNull();
      put("runtime", "FRIDAY_Node", "node-v22.24.0-win-x64", "node.exe");
      expect(installs.installedBin(dir, tool)).toBeNull(); // not the pinned path, no marker yet
      installs.writeMarker(dir, tool, {
        version: "22.24.0",
        bin: "node-v22.24.0-win-x64/node.exe",
      });
      const found = installs.installedBin(dir, tool);
      expect(found.version).toBe("22.24.0");
      expect(found.bin).toBe(
        path.join(dir, "runtime", "FRIDAY_Node", "node-v22.24.0-win-x64", "node.exe"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the pinned path for a folder from before markers", () => {
    const { dir, put } = fakeRoot();
    try {
      put("runtime", "MinGit", "cmd", "git.exe");
      const found = installs.installedBin(dir, {
        id: "MinGit",
        archiveBin: "cmd/git.exe",
        pinVersion: "2.56.0.2",
      });
      expect(found.version).toBe("2.56.0.2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every archive tool matches its pack in the manifest (version, hash, mirrors)", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(root, "config/toolchain-manifest.json"), "utf8"),
    );
    const packed = toolchain.TOOLS.filter((t: { packId?: string }) => t.packId);
    expect(packed.length).toBe(11);
    for (const tool of packed) {
      const pack = manifest.packs.find((p: { id: string }) => p.id === tool.packId);
      expect(tool.sha256, tool.id).toBe(pack.sha256);
      expect(tool.pinVersion, tool.id).toBe(pack.version);
      for (const mirror of pack.mirrors || [])
        expect(tool.installerMirrors, tool.id).toContain(mirror);
    }
  });
});
