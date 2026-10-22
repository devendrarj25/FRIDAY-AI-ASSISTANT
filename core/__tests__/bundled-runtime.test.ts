/**
 * Shared pack layout, pure-Node extract, and first-run materialisation.
 * A Windows electron-builder --dir pack was not run on this host.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
const archive = require(path.join(ROOT, "electron/archive-safe.cjs")) as {
  destinationFor: (root: string, name: string) => string;
  extractArchiveFile: (
    file: string,
    dest: string,
    options?: { limits?: Record<string, number> },
  ) => {
    ok: boolean;
  };
  removeTree: (
    target: string,
    opts?: { windows?: boolean; sleep?: () => void; rm?: (file: string) => void },
  ) => { ok: boolean; attempts: number };
  renameWithRetry: (
    from: string,
    to: string,
    opts?: { windows?: boolean; sleep?: () => void; rename?: (from: string, to: string) => void },
  ) => { ok: boolean; attempts: number };
};
const layout = require(path.join(ROOT, "electron/runtime-layout.cjs")) as {
  BUNDLED_IDS: string[];
  packRelative: (id: string) => string;
  entryRelative: (id: string) => string;
  resourceRoots: (input: Record<string, string>) => string[];
  findPack: (id: string, roots: string[]) => string | null;
};
const runtime = require(path.join(ROOT, "electron/bundled-runtime.cjs")) as {
  materialise: (input: Record<string, unknown>) => {
    ok: boolean;
    step: string;
    tools: Record<
      string,
      { ok: boolean; step: string; file?: string; proved?: boolean; message?: string }
    >;
    events: { phase: string }[];
    log: string[];
  };
  inspect: (input: Record<string, unknown>) => {
    tools: { id: string; proved: boolean; hashOk: boolean; lastRun: string | null }[];
  };
  doctorRows: (
    states: Record<string, unknown>[],
  ) => { id: string; status: string; fixable: boolean; detail: string }[];
};
const documents = require(path.join(ROOT, "electron/document-extract.cjs")) as {
  packZip: (files: { name: string; data: Buffer }[]) => Buffer;
};

const CLOCK = 1_700_000_000_000;
const temps: string[] = [];

function temp(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop();
    if (!dir) continue;
    try {
      fs.chmodSync(dir, 0o755);
    } catch {
      /* already gone */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function pin(id: string, body: Buffer) {
  return {
    id,
    name: id,
    version: "1",
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    bytes: body.length,
    tier: "bundled",
    license: "MIT",
  };
}

function readyRun() {
  return () => ({ status: 0, stdout: "ready 1\n", error: "" });
}

describe("archive extract", () => {
  it("retries a Windows EPERM rename and remove", () => {
    let renames = 0;
    const renamed = archive.renameWithRetry("from", "to", {
      windows: true,
      sleep: () => undefined,
      rename: () => {
        renames += 1;
        if (renames < 3) {
          const error = new Error("locked") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
      },
    });
    expect(renamed, JSON.stringify(renamed)).toMatchObject({ ok: true, attempts: 3 });
    let removes = 0;
    const removed = archive.removeTree("dir", {
      windows: true,
      sleep: () => undefined,
      rm: () => {
        removes += 1;
        if (removes < 3) {
          const error = new Error("busy") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        }
      },
    });
    expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true });
    expect(removes).toBe(3);
  });

  it("refuses zip-slip, a truncated archive, and a huge expansion", () => {
    const root = temp("friday-slip-");
    expect(() => archive.destinationFor(root, "../outside.txt")).toThrow(/unsafe archive entry/);
    expect(() => archive.destinationFor(root, "ok/../../outside.txt")).toThrow(
      /unsafe archive entry/,
    );
    expect(() => archive.destinationFor(root, "C:/Windows/note.txt")).toThrow(
      /unsafe archive entry/,
    );
    const truncated = path.join(root, "short.zip");
    fs.writeFileSync(truncated, Buffer.from("PK\x03\x04short"));
    expect(() => archive.extractArchiveFile(truncated, path.join(root, "out"))).toThrow(
      /truncated archive/,
    );
    const plain = Buffer.alloc(200000, 0);
    const packed = zlib.deflateRawSync(plain);
    const name = Buffer.from("bomb.bin");
    const local = Buffer.alloc(30);
    local.write("PK\x03\x04", 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.write("PK\x01\x02", 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(name.length, 28);
    const eocd = Buffer.alloc(22);
    eocd.write("PK\x05\x06", 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + name.length, 12);
    eocd.writeUInt32LE(30 + name.length + packed.length, 16);
    const bomb = path.join(root, "bomb.zip");
    fs.writeFileSync(bomb, Buffer.concat([local, name, packed, central, name, eocd]));
    expect(() =>
      archive.extractArchiveFile(bomb, path.join(root, "boom"), { limits: { maxRatio: 20 } }),
    ).toThrow(/ratio cap/);
    expect(fs.existsSync(path.join(root, "..", "outside.txt"))).toBe(false);
  });

  it("extracts a tar whose path contains a colon", () => {
    const root = temp("friday-colon-");
    // A colon is a legal directory name on POSIX. On Windows it is legal only
    // as the drive letter, and the temp path already contains that letter.
    const folder = process.platform === "win32" ? root : path.join(root, "c:work");
    fs.mkdirSync(folder, { recursive: true });
    const archiveFile = path.join(folder, "pack.tar");
    expect(archiveFile.includes(":")).toBe(true);
    if (process.platform === "win32") {
      expect(path.win32.parse(archiveFile).root).toMatch(/^[A-Za-z]:\\$/);
    } else {
      expect(path.basename(folder)).toBe("c:work");
    }
    const staging = path.join(folder, "src");
    fs.mkdirSync(path.join(staging, "demo"), { recursive: true });
    fs.writeFileSync(path.join(staging, "demo", "marker.txt"), "new");
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const spawn = require(path.join(ROOT, "scripts/win-spawn.cjs")) as {
      localTar: (file: string, args: string[]) => { cwd: string; args: string[] };
    };
    const spec = spawn.localTar(archiveFile, ["-cf", archiveFile, "-C", staging, "demo"]);
    expect(spec.cwd).toBe(folder);
    expect(spec.args).toContain("pack.tar");
    expect(spec.args.filter((arg) => arg.includes("pack.tar"))).toEqual(["pack.tar"]);
    expect(spec.args.includes("--force-local")).toBe(false);
    execFileSync("tar", spec.args, { cwd: spec.cwd });
    const dest = path.join(folder, "out");
    const extracted = archive.extractArchiveFile(archiveFile, dest);
    expect(extracted.ok).toBe(true);
    expect(fs.readFileSync(path.join(dest, "demo", "marker.txt"), "utf8")).toBe("new");
  });
});

describe("runtime layout", () => {
  it("lands extraResources in resources/<dest>/<id>/pack.bin", () => {
    const yml = fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8");
    const block = yml.slice(
      yml.indexOf("- from: resources\n"),
      yml.indexOf("- from: public/character"),
    );
    expect(block).not.toMatch(/\n {4}to:/);
    const { getFileMatchers } = require("app-builder-lib/out/fileMatcher.js") as {
      getFileMatchers: (
        config: { extraResources: { from: string; to?: string }[] },
        name: string,
        dest: string,
        options: Record<string, unknown>,
      ) => { from: string; to: string }[];
    };
    const project = temp("friday-fileset-");
    const resources = path.join(project, "resources");
    const pack = path.join(resources, "speech", "whisper-cpp", "pack.bin");
    fs.mkdirSync(path.dirname(pack), { recursive: true });
    fs.writeFileSync(pack, "x");
    const dest = path.join(project, "win-unpacked", "resources");
    const options = {
      defaultSrc: project,
      macroExpander: (value: string) => value,
      customBuildOptions: {},
      globalOutDir: path.join(project, "out"),
    };
    const matchers = getFileMatchers(
      { extraResources: [{ from: "resources" }] },
      "extraResources",
      dest,
      options,
    );
    const matcher = matchers.find((item) => item.from === path.resolve(resources));
    expect(matcher?.to).toBe(path.resolve(dest));
    expect(path.join(matcher?.to || "", path.relative(matcher?.from || "", pack))).toBe(
      path.join(dest, "speech", "whisper-cpp", "pack.bin"),
    );
    const nested = getFileMatchers(
      { extraResources: [{ from: "resources", to: "resources" }] },
      "extraResources",
      dest,
      options,
    );
    expect(nested[0]?.to).toBe(path.resolve(dest, "resources"));
    expect(process.platform === "win32" ? "library" : "UNVERIFIED").toBe(
      process.platform === "win32" ? "library" : "UNVERIFIED",
    );
    for (const id of layout.BUNDLED_IDS) {
      expect(layout.packRelative(id)).toMatch(/^(speech|toolchain)\/[^/]+\/pack\.bin$/);
    }
    expect(layout.entryRelative("whisper-cpp")).toBe("whisper.cpp/Release/whisper-cli.exe");
    expect(layout.entryRelative("node-win")).toBe("node/node.exe");
    expect(layout.entryRelative("python-embed")).toBe("python/python.exe");
  });
});

describe("bundled runtime", () => {
  function stageAll(resources: string) {
    const python = documents.packZip([
      { name: "python.exe", data: Buffer.from("python") },
      { name: "python312._pth", data: Buffer.from("keep\n") },
    ]);
    const node = documents.packZip([
      { name: "node-v22.23.3-win-x64/node.exe", data: Buffer.from("node") },
    ]);
    const whisper = documents.packZip([
      { name: "Release/whisper-cli.exe", data: Buffer.from("cli") },
      { name: "Release/whisper-server.exe", data: Buffer.from("server") },
    ]);
    const pip = Buffer.from("print('pip')\n");
    const model = Buffer.alloc(32, 7);
    const files: Record<string, Buffer> = {
      "python-embed": python,
      "get-pip": pip,
      "node-win": node,
      "whisper-cpp": whisper,
      "ggml-base": model,
    };
    const packs = layout.BUNDLED_IDS.map((id) => {
      const body = files[id];
      if (!body) throw new Error(`missing fixture ${id}`);
      const rel = layout.packRelative(id);
      const file = path.join(resources, ...rel.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      return pin(id, body);
    });
    return { packs, budgetBytes: 1000 };
  }

  it("extracts a fake win-unpacked tree until every bundled row is Ready", () => {
    const root = temp("friday-runtime-");
    const resources = path.join(root, "win-unpacked", "resources");
    const manifest = stageAll(resources);
    const runtimeRoot = path.join(root, "FRIDAY runtime", "भाषा");
    const events: string[] = [];
    const first = runtime.materialise({
      resourcesRoots: [resources],
      runtimeRoot,
      manifest,
      now: () => CLOCK,
      run: readyRun(),
      onProgress: (event: { phase: string }) => events.push(event.phase),
    });
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true, step: "ready" });
    expect(events).toContain("ready");
    expect(fs.readFileSync(path.join(runtimeRoot, "python", "python312._pth"), "utf8")).toContain(
      "import site",
    );
    expect(fs.existsSync(path.join(runtimeRoot, "node", "node.exe"))).toBe(true);
    expect(
      fs.existsSync(path.join(runtimeRoot, "whisper.cpp", "Release", "whisper-server.exe")),
    ).toBe(true);
    const again = runtime.materialise({
      resourcesRoots: [resources],
      runtimeRoot,
      manifest,
      now: () => CLOCK,
      run: () => {
        throw new Error("second run should not extract");
      },
    });
    expect(again.ok).toBe(true);
    const tools = runtime.inspect({ runtimeRoot, manifest, resourcesRoots: [resources] }).tools;
    // Each row names its own pack file, even when two tools share one folder.
    for (const tool of tools) {
      expect(String((tool as { source?: string }).source).replace(/\\/g, "/")).toContain(
        layout.packRelative(tool.id),
      );
    }
    const rows = runtime.doctorRows(tools);
    expect(rows.every((row) => row.status === "Ready")).toBe(true);
    expect(
      rows.every((row) => row.detail.includes("hash OK") && row.detail.includes("last run")),
    ).toBe(true);
    const paths = require(path.join(ROOT, "electron/mcp-paths.cjs")) as {
      resolveLauncher: (input: { runtimeRoot: string; execPath: string; appPath: string }) => {
        command: string;
      };
    };
    const launched = paths.resolveLauncher({
      appPath: root,
      execPath: path.join(root, "FRIDAY.exe"),
      runtimeRoot,
    });
    expect(launched.command).toBe(path.join(runtimeRoot, "node", "node.exe"));
  });

  it("shows a staged, not yet extracted pack as the ready fallback, and a missing one as Missing", () => {
    const rows = runtime.doctorRows([
      {
        id: "python-embed",
        name: "CPython embeddable",
        version: "3.12.10",
        present: false,
        proved: false,
        hashOk: false,
        source: "D:/F/App/resources/toolchain/python-embed/pack.bin",
        lastRun: null,
        manual: null,
      },
      {
        id: "node-win",
        name: "Node.js",
        version: "22.23.3",
        present: false,
        proved: false,
        hashOk: false,
        source: null,
        lastRun: null,
        manual: null,
      },
    ] as never);
    expect(rows[0]?.status).toBe("Ready");
    expect(rows[0]?.detail).toContain("extracted on first use");
    expect(rows[1]?.status).toBe("Missing");
  });

  it("keeps Doctor on Warning when the prove command is skipped", () => {
    const root = temp("friday-runtime-unproved-");
    const resources = path.join(root, "resources");
    const body = documents.packZip([{ name: "python.exe", data: Buffer.from("python") }]);
    const rel = layout.packRelative("python-embed");
    const packFile = path.join(resources, ...rel.split("/"));
    fs.mkdirSync(path.dirname(packFile), { recursive: true });
    fs.writeFileSync(packFile, body);
    const manifest = { packs: [pin("python-embed", body)], budgetBytes: 100 };
    const runtimeRoot = path.join(root, "runtime");
    const landed = runtime.materialise({
      resourcesRoots: [resources],
      runtimeRoot,
      manifest,
      ids: ["python-embed"],
      prove: false,
      now: () => CLOCK,
    });
    expect(landed.tools["python-embed"]?.ok, JSON.stringify(landed)).toBe(true);
    expect(landed.tools["python-embed"]?.proved).toBe(false);
    const row = runtime
      .doctorRows(runtime.inspect({ runtimeRoot, manifest, resourcesRoots: [resources] }).tools)
      .find((item) => item.id === "toolchain:python-embed");
    expect(row?.status).toBe("Warning");
  });

  it("rejects a bad hash, a partial tree, a busy lock, and a read-only install", () => {
    const root = temp("friday-runtime-bad-");
    const resources = path.join(root, "resources");
    const body = documents.packZip([{ name: "python.exe", data: Buffer.from("python") }]);
    const rel = layout.packRelative("python-embed");
    const packFile = path.join(resources, ...rel.split("/"));
    fs.mkdirSync(path.dirname(packFile), { recursive: true });
    fs.writeFileSync(packFile, body);
    const good = pin("python-embed", body);
    const pipBody = Buffer.from("pip\n");
    const pipRel = layout.packRelative("get-pip");
    const pipFile = path.join(resources, ...pipRel.split("/"));
    fs.mkdirSync(path.dirname(pipFile), { recursive: true });
    fs.writeFileSync(pipFile, pipBody);
    const pip = pin("get-pip", pipBody);
    const manifest = { packs: [good, pip], budgetBytes: 100 };
    const runtimeRoot = path.join(root, "runtime");
    const wrong = runtime.materialise({
      resourcesRoots: [resources],
      runtimeRoot,
      manifest: { packs: [{ ...good, sha256: "0".repeat(64) }, pip], budgetBytes: 100 },
      prove: false,
    });
    expect(wrong.tools["python-embed"]?.step).toBe("hash");
    fs.mkdirSync(path.join(runtimeRoot, "python"), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, "python", "python.exe"), "partial");
    const repaired = runtime.materialise({
      resourcesRoots: [resources],
      runtimeRoot,
      manifest,
      now: () => CLOCK,
      run: readyRun(),
    });
    expect(repaired.tools["python-embed"]?.ok, JSON.stringify(repaired)).toBe(true);
    const nested = runtime.materialise({
      resourcesRoots: [resources],
      runtimeRoot,
      manifest,
      force: true,
      run: () => {
        const inner = runtime.materialise({
          resourcesRoots: [resources],
          runtimeRoot,
          manifest,
          prove: false,
        });
        expect(inner.step).toBe("busy");
        return { status: 0, stdout: "ready 1\n", error: "" };
      },
    });
    expect(nested.step).not.toBe("busy");
    const installDir = path.dirname(packFile);
    fs.chmodSync(installDir, 0o555);
    const fromReadonly = (() => {
      try {
        return runtime.materialise({
          resourcesRoots: [resources],
          runtimeRoot: path.join(root, "runtime-2"),
          manifest,
          now: () => CLOCK,
          run: readyRun(),
          force: true,
        });
      } finally {
        fs.chmodSync(installDir, 0o755);
      }
    })();
    expect(fromReadonly.tools["python-embed"]?.ok, JSON.stringify(fromReadonly)).toBe(true);
    const roots = layout.resourceRoots({
      resourcesPath: resources,
      devRoot: root,
      execPath: path.join(root, "FRIDAY.exe"),
      portableDir: root,
    });
    expect(layout.findPack("python-embed", roots)).toBe(packFile);
  });
});

describe("bundled interpreter order", () => {
  const python = require(path.join(ROOT, "electron/python.cjs")) as {
    interpreterPhase: (candidate: { exe?: string }) => string;
  };
  const toolchain = require(path.join(ROOT, "electron/toolchain.cjs")) as {
    managedRuntimeChoice: (input: Record<string, unknown>) => { action: string; exe: string };
    useBundledEmbedDirect: (
      chosen: { exe: string; prefix?: string[] } | null,
      embedFile: string,
    ) => boolean;
  };

  it("extracts the bundled embed before a bare system interpreter", () => {
    expect(
      python.interpreterPhase({ exe: path.join(ROOT, "runtime", "python", "python.exe") }),
    ).toBe("explicit");
    expect(python.interpreterPhase({ exe: "py" })).toBe("system");
    expect(python.interpreterPhase({ exe: "python3" })).toBe("system");
    expect(python.interpreterPhase({ exe: "python" })).toBe("system");
  });

  it("uses the embeddable zip as itself and still builds a venv from py", () => {
    const embed = path.join(ROOT, "runtime", "python", "python.exe");
    const venv = path.join(ROOT, "runtime", "py312", "Scripts", "python.exe");
    expect(
      toolchain.managedRuntimeChoice({ venvExe: venv, embedFile: embed, embedExists: true }).action,
    ).toBe("venv-ready");
    expect(toolchain.managedRuntimeChoice({ embedFile: embed, embedExists: true }).action).toBe(
      "embed",
    );
    expect(
      toolchain.managedRuntimeChoice({ embedFile: embed, chosen: { exe: embed, prefix: [] } })
        .action,
    ).toBe("embed");
    expect(toolchain.useBundledEmbedDirect({ exe: "py", prefix: ["-3.12"] }, embed)).toBe(false);
    expect(
      toolchain.managedRuntimeChoice({ chosen: { exe: "py", prefix: ["-3.12"] } }).action,
    ).toBe("venv");
    expect(toolchain.managedRuntimeChoice({}).action).toBe("missing");
  });
});
