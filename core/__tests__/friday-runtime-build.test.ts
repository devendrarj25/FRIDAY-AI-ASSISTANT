/**
 * The FRIDAY Runtime engine build (scripts/build-friday-runtime.cjs) is an optional, owner-run job. These checks pin its
 * pure parts and that the locked Windows CMD chain never reaches it. The compile itself is not run here.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

type Record_ = {
  name: string;
  engine: string;
  tag: string;
  commit: string | null;
  wheels: Record<string, { file: string; sha256: string }>;
  builtAt: string | null;
};
const build = require_("../../scripts/build-friday-runtime.cjs") as {
  PINNED_TAG: string;
  SMOKE_PY: string;
  isPinnedTag: (tag: unknown) => boolean;
  platformKey: (platform: string, arch: string) => string;
  buildArgs: (o: {
    buildDir: string;
    platform?: string;
    asRoot?: boolean;
    parallel?: boolean;
  }) => string[];
  buildRecord: (o: Record<string, unknown>) => Record_;
  writeRecord: (file: string, record: Record_, smokePassed: unknown) => void;
  parseArgs: (argv: string[]) => { tag: string; work: string; timeboxMin: number; dryRun: boolean };
};

const SHA = "a".repeat(64);
const COMMIT = "b".repeat(40);
const record = (extra: Record<string, unknown> = {}) =>
  build.buildRecord({
    tag: "v1.32.0",
    commit: COMMIT,
    platform: "linux-x64",
    wheelFile: "/x/dist/onnxruntime-1.32.0-cp313-cp313-linux_x86_64.whl",
    wheelSha256: SHA,
    builtAt: "2026-11-27T00:00:00.000Z",
    ...extra,
  });

describe("the tag is pinned", () => {
  it("accepts only a plain release tag", () => {
    expect(build.isPinnedTag(build.PINNED_TAG)).toBe(true);
    expect(build.isPinnedTag("v1.32.0")).toBe(true);
    for (const bad of [
      "main",
      "latest",
      "",
      "v1.32",
      "1.32.0",
      "v1.32.0-rc1",
      "v1.32.0 --force",
      COMMIT,
      undefined,
    ]) {
      expect(build.isPinnedTag(bad)).toBe(false);
    }
  });

  it("the command line refuses an unpinned tag", () => {
    const result = require_("node:child_process").spawnSync(
      process.execPath,
      [
        path.join(root, "scripts", "build-friday-runtime.cjs"),
        "--tag",
        "main",
        "--work",
        path.join(os.tmpdir(), "x"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing an unpinned tag");
  });

  it("a dry run prints the plan and builds nothing", () => {
    const work = path.join(os.tmpdir(), `friday-runtime-dry-${process.pid}`);
    const result = require_("node:child_process").spawnSync(
      process.execPath,
      [path.join(root, "scripts", "build-friday-runtime.cjs"), "--work", work, "--dry-run"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("onnxruntime v1.32.0");
    expect(fs.existsSync(work)).toBe(false);
  });

  it("the work folder must be outside the repository", () => {
    const result = require_("node:child_process").spawnSync(
      process.execPath,
      [
        path.join(root, "scripts", "build-friday-runtime.cjs"),
        "--work",
        path.join(root, "temporary", "rt"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside the repository");
  });
});

describe("the argument builder", () => {
  it("is the official full CPU wheel build, not a minimal build", () => {
    const args = build.buildArgs({ buildDir: "out", platform: "linux" });
    expect(args[0]).toBe(path.join("tools", "ci_build", "build.py"));
    expect(args.join(" ")).toContain("--build_dir out --config Release");
    for (const flag of ["--build_wheel", "--skip_tests", "--parallel"])
      expect(args).toContain(flag);
    expect(args.some((a) => a.includes("minimal") || a.includes("include_ops"))).toBe(false);
    expect(args).not.toContain("--use_cuda");
  });

  it("uses Visual Studio 2022 on Windows and root permission only when running as root elsewhere", () => {
    const win = build.buildArgs({ buildDir: "out", platform: "win32" });
    expect(win.join(" ")).toContain("--cmake_generator Visual Studio 17 2022");
    expect(win).not.toContain("--allow_running_as_root");
    expect(build.buildArgs({ buildDir: "o", platform: "linux", asRoot: true })).toContain(
      "--allow_running_as_root",
    );
    expect(build.buildArgs({ buildDir: "o", platform: "linux" })).not.toContain(
      "--allow_running_as_root",
    );
    expect(() => build.buildArgs({} as never)).toThrow();
  });

  it("is deterministic", () => {
    const a = build.buildArgs({ buildDir: "out", platform: "linux" });
    expect(build.buildArgs({ buildDir: "out", platform: "linux" })).toEqual(a);
  });

  it("parses the command line and rejects an unknown flag", () => {
    expect(build.parseArgs(["--work", "w", "--timebox-min", "30", "--dry-run"])).toEqual({
      tag: "v1.32.0",
      work: "w",
      timeboxMin: 30,
      dryRun: true,
    });
    expect(() => build.parseArgs(["--shell"])).toThrow(/unknown argument/);
  });
});

describe("the record", () => {
  it("names the engine friday-runtime and keeps the wheel file by base name", () => {
    const r = record();
    expect(r).toEqual({
      name: "friday-runtime",
      engine: "onnxruntime",
      tag: "v1.32.0",
      commit: COMMIT,
      wheels: {
        "linux-x64": { file: "onnxruntime-1.32.0-cp313-cp313-linux_x86_64.whl", sha256: SHA },
      },
      builtAt: "2026-11-27T00:00:00.000Z",
    });
  });

  it("refuses an unpinned tag, a short commit and a bad hash", () => {
    expect(() => record({ tag: "main" })).toThrow(/unpinned tag/);
    expect(() => record({ commit: "abc123" })).toThrow(/40-character/);
    expect(() => record({ wheelSha256: "xyz" })).toThrow(/64 hex/);
    expect(() => record({ builtAt: "" })).toThrow();
  });

  it("adds a platform for the same tag and commit, and drops old wheels for a new commit", () => {
    const linux = record();
    const both = record({
      platform: "win32-x64",
      wheelFile: "C:\\o\\dist\\onnxruntime-1.32.0-win_amd64.whl",
      previous: linux,
    });
    expect(Object.keys(both.wheels).sort()).toEqual(["linux-x64", "win32-x64"]);
    const moved = record({ commit: "c".repeat(40), platform: "win32-x64", previous: linux });
    expect(Object.keys(moved.wheels)).toEqual(["win32-x64"]);
  });

  it("names the platform from the process", () => {
    expect(build.platformKey("win32", "x64")).toBe("win32-x64");
  });

  it("is written only when the smoke test passed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-runtime-"));
    try {
      const file = path.join(dir, "friday-runtime.json");
      for (const bad of [false, undefined, "yes", 1])
        expect(() => build.writeRecord(file, record(), bad)).toThrow(/smoke/);
      expect(fs.existsSync(file)).toBe(false);
      build.writeRecord(file, record(), true);
      expect((JSON.parse(fs.readFileSync(file, "utf8")) as Record_).commit).toBe(COMMIT);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the shipped record is pinned to a release tag and holds only complete wheel entries", () => {
    const shipped = JSON.parse(read("config/friday-runtime.json")) as Record_;
    expect(shipped.name).toBe("friday-runtime");
    expect(build.isPinnedTag(shipped.tag)).toBe(true);
    for (const wheel of Object.values(shipped.wheels)) {
      expect(wheel.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(shipped.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(shipped.builtAt).toBeTruthy();
    }
    if (Object.keys(shipped.wheels).length === 0) expect(shipped.builtAt).toBeNull();
  });
});

describe("the smoke test", () => {
  it("runs the fixture graph on the CPU provider and exits non-zero on a wrong answer", () => {
    expect(build.SMOKE_PY).toContain("CPUExecutionProvider");
    expect(build.SMOKE_PY).toContain("np.maximum(x, 0.0)");
    expect(build.SMOKE_PY).toContain("sys.exit(0 if ok else 1)");
    expect(fs.existsSync(path.join(root, "kernel", "tests", "fixtures", "tiny_relu.onnx"))).toBe(
      true,
    );
  });
});

describe("the locked chain never reaches it", () => {
  const chain = [
    "scripts/setup-windows.ps1",
    "scripts/build-windows.cmd",
    "scripts/build-pipeline.cjs",
    "scripts/doctor.cjs",
    "scripts/check-environment.cjs",
    "scripts/setup-python.cjs",
    "scripts/prefetch-toolkit.cjs",
    "scripts/prefetch-models.cjs",
    "scripts/ensure-electron.cjs",
    "scripts/stage-toolchain.cjs",
    "scripts/electron-pack.cjs",
    "scripts/verify-build.cjs",
    "scripts/live-console.cjs",
    "scripts/console-bar.cjs",
    "scripts/download-board.cjs",
    "electron-builder.yml",
    "package.json",
  ];

  it.each(chain)("%s does not mention the build", (file) => {
    const text = read(file);
    expect(text).not.toContain("build-friday-runtime");
    expect(text).not.toContain("friday-runtime.json");
  });

  it("no workflow runs it", () => {
    const dir = path.join(root, ".github", "workflows");
    for (const name of fs.readdirSync(dir))
      expect(fs.readFileSync(path.join(dir, name), "utf8")).not.toContain("build-friday-runtime");
  });
});
