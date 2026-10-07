/**
 * Import & Build local factory: other-app ZIP/keep/install, FRIDAY source
 * refused for other identity, no fake Windows EXE on Linux, no git push.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const factory = require_(path.resolve(process.cwd(), "electron/import-factory.cjs")) as {
  isFridaySource: (dir: string) => boolean;
  inspectSource: (dir: string) => {
    ok: boolean;
    identity?: string;
    friday?: boolean;
    exeReady?: boolean;
    name?: string;
    error?: string;
  };
  keptDir: (root: string) => string;
  listKept: (root: string) => { name: string; path: string; bytes: number }[];
  keepArtifact: (a: { workspaceRoot: string; file: string }) => {
    ok: boolean;
    path?: string;
    error?: string;
  };
  createZip: (
    sourceDir: string,
    destZip: string,
  ) => Promise<{ ok: boolean; file?: string; error?: string; via?: string }>;
  installArtifact: (file: string) => {
    ok: boolean;
    error?: string;
    launch?: boolean;
    file?: string;
  };
  startBuild: (a: {
    kind?: string;
    name?: string;
    version?: string;
    sourceDir?: string;
    workspaceRoot?: string;
    onProgress?: (e: { status: string; artifact?: string | null; step?: string }) => void;
  }) => { ok: boolean; id?: string; error?: string };
  cancelBuild: (id: string) => { ok: boolean; error?: string };
};

const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-factory-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

function write(dir: string, rel: string, body: string) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function zipNames(file: string): string[] {
  for (const bin of ["python3", "python"]) {
    try {
      const out = execFileSync(
        bin,
        [
          "-c",
          "import zipfile, json, sys; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))",
          file,
        ],
        { encoding: "utf8" },
      );
      return JSON.parse(out) as string[];
    } catch {
      /* try the next interpreter */
    }
  }
  throw new Error("python zipfile is required to inspect factory zips");
}

describe("import factory identity", () => {
  it("detects FRIDAY source only when official markers are all present", () => {
    const friday = temp();
    write(friday, "package.json", JSON.stringify({ name: "friday", version: "1.0.0" }));
    write(friday, "scripts/build-windows.cmd", "@echo off\n");
    write(friday, "electron-builder.yml", "appId: ai.friday.app\n");
    write(friday, "config/friday-version.json", JSON.stringify({ version: "1.0.0.2" }));
    expect(factory.isFridaySource(friday)).toBe(true);
    expect(factory.inspectSource(friday).identity).toBe("friday");

    const other = temp();
    write(other, "package.json", JSON.stringify({ name: "ward-notes", version: "0.4.0" }));
    write(other, "README.md", "hello\n");
    expect(factory.isFridaySource(other)).toBe(false);
    const info = factory.inspectSource(other);
    expect(info.identity).toBe("other");
    expect(info.friday).toBe(false);
    expect(info.exeReady).toBe(false);
    expect(info.name).toBe("ward-notes");
  });
});

describe("import factory zip / keep / install honesty", () => {
  it("zips an other project, keeps a copy, and refuses EXE install on Linux", async () => {
    const workspace = temp();
    const src = temp();
    write(src, "README.md", "other app\n");
    write(src, "src/main.js", "console.log(1)\n");
    const zipPath = path.join(workspace, "out.zip");
    const packed = await factory.createZip(src, zipPath);
    expect(packed.ok, packed.error).toBe(true);
    expect(fs.existsSync(zipPath)).toBe(true);
    expect(fs.statSync(zipPath).size).toBeGreaterThan(20);

    const kept = factory.keepArtifact({ workspaceRoot: workspace, file: zipPath });
    expect(kept.ok, kept.error).toBe(true);
    expect(kept.path).toContain(`${path.join("downloads", "kept-builds")}`);
    expect(factory.listKept(workspace).some((f) => f.path === kept.path)).toBe(true);

    expect(factory.installArtifact(zipPath).ok).toBe(false);
    expect(factory.installArtifact(zipPath).error).toMatch(/Only a \.exe/i);

    const fakeExe = path.join(workspace, "app.exe");
    fs.writeFileSync(fakeExe, "MZ");
    const launched = factory.installArtifact(fakeExe);
    if (process.platform === "win32") {
      expect(launched.ok).toBe(true);
      expect(launched.launch).toBe(true);
      expect(launched.file).toBe(path.resolve(fakeExe));
    } else {
      expect(launched.ok).toBe(false);
      expect(launched.error).toMatch(/Windows/);
    }
  });

  it("refuses other-identity builds of FRIDAY source and other EXE on Linux", async () => {
    const workspace = temp();
    const friday = temp();
    write(friday, "package.json", "{}");
    write(friday, "scripts/build-windows.cmd", "@echo off\n");
    write(friday, "electron-builder.yml", "appId: ai.friday.app\n");
    write(friday, "config/friday-version.json", "{}");
    const refused = factory.startBuild({
      kind: "zip",
      name: "not-friday",
      sourceDir: friday,
      workspaceRoot: workspace,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/FRIDAY's own source/i);

    const other = temp();
    write(other, "README.md", "notes\n");
    const exe = factory.startBuild({
      kind: "exe",
      name: "notes",
      sourceDir: other,
      workspaceRoot: workspace,
    });
    expect(exe.ok).toBe(false);
    expect(exe.error).toMatch(/Windows|ZIP/i);

    const events: { status: string; artifact?: string | null }[] = [];
    const zip = factory.startBuild({
      kind: "zip",
      name: "notes",
      version: "0.1.0",
      sourceDir: other,
      workspaceRoot: workspace,
      onProgress: (e) => events.push(e),
    });
    expect(zip.ok, zip.error).toBe(true);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("factory zip timed out")), 20_000);
      const tick = () => {
        if (events.some((e) => e.status === "done" || e.status === "error")) {
          clearTimeout(timer);
          resolve();
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
    const done = events.find((e) => e.status === "done");
    expect(done, events.at(-1)?.status).toBeTruthy();
    expect(done?.artifact && fs.existsSync(done.artifact)).toBe(true);
    expect(String(done?.artifact)).toMatch(/notes-0\.1\.0/);
    expect(String(done?.artifact)).toContain("kept-builds");

    const names = zipNames(String(done?.artifact));
    expect(names.some((n) => n.replace(/\\/g, "/").includes("notes/README.md"))).toBe(true);
    expect(names.join("\n")).not.toMatch(/\.stage-/);

    const nested = path.join(factory.keptDir(workspace), "notes-0.1.0");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "Notes-Setup.exe"), "MZ");
    expect(factory.listKept(workspace).some((f) => f.name === "Notes-Setup.exe")).toBe(true);
  });

  it("cancel before pump prevents a finished ZIP", async () => {
    const workspace = temp();
    const other = temp();
    write(other, "README.md", "notes\n");
    const events: { status: string }[] = [];
    const zip = factory.startBuild({
      kind: "zip",
      name: "notes",
      version: "0.1.0",
      sourceDir: other,
      workspaceRoot: workspace,
      onProgress: (e) => events.push(e),
    });
    expect(zip.ok, zip.error).toBe(true);
    expect(zip.id).toBeTruthy();
    const cancelled = factory.cancelBuild(String(zip.id));
    expect(cancelled.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events.some((e) => e.status === "done")).toBe(false);
    const leftover = factory.listKept(workspace).filter((f) => f.name.endsWith(".zip"));
    expect(leftover).toEqual([]);
  });
});
