/**
 * The FRIDAY Runtime LLM engine build (scripts/build-friday-runtime-llm.cjs) is an optional, owner-run job. These checks
 * pin its pure parts, the smoke test against a stand-in server, and that the locked Windows CMD chain never reaches it.
 * The compile itself is not run here (Windows only, unverified until the owner runs it).
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const SCRIPT = path.join(root, "scripts", "build-friday-runtime-llm.cjs");

type Rec = {
  name: string;
  engine: string;
  tag: string | null;
  commit: string | null;
  variant: string | null;
  toolchain: string | null;
  files: { name: string; sha256: string }[];
  assetName: string | null;
  sha256: string | null;
  builtAt: string | null;
};
type Reply = { status: number; body: Record<string, unknown> | null };
const build = require_("../../scripts/build-friday-runtime-llm.cjs") as {
  PINNED_TAG: string;
  isPinnedTag: (tag: unknown) => boolean;
  assetName: (tag: string, variant: string) => string;
  buildArgs: (o?: Record<string, unknown>) => { configure: string[]; build: string[] };
  planCopies: (names: string[]) => { from: string; to: string }[];
  buildRecord: (o: Record<string, unknown>) => Rec;
  writeRecord: (file: string, record: Rec, smokePassed: unknown) => void;
  assertBuildable: (platform: string) => void;
  smokeVerdict: (h: Reply | null, c: Reply | null, n?: number) => { ok: boolean; reason: string };
  smokeServerArgs: (fixture: string, port: number) => string[];
  smokeCompletionBody: () => Record<string, unknown>;
  parseArgs: (argv: string[]) => Record<string, unknown>;
  runSmoke: (
    exe: string,
    fixture: string,
    options?: { waitMs?: number; leadArgs?: string[] },
  ) => Promise<{ ok: boolean; reason: string }>;
};

const SHA = "a".repeat(64);
const COMMIT = "b".repeat(40);
const record = (extra: Record<string, unknown> = {}) =>
  build.buildRecord({
    tag: "b12230",
    commit: COMMIT,
    variant: "friday-native",
    toolchain: "vs2022",
    files: [
      { name: "ggml-cpu.dll", sha256: "c".repeat(64) },
      { name: "friday-runtime-llm.exe", sha256: SHA },
    ],
    assetSha256: "d".repeat(64),
    builtAt: "2026-11-27T00:00:00.000Z",
    ...extra,
  });

describe("the tag is pinned to the official engine", () => {
  it("is the same tag as the official llama.cpp pin", () => {
    const runners = JSON.parse(read("config/local-runners.json")) as {
      runners: { name?: string; release?: { tag?: string } }[];
    };
    const official = runners.runners.find((p) => p.name === "llama.cpp")?.release?.tag;
    expect(official).toBe(build.PINNED_TAG);
  });

  it("accepts only a plain build tag", () => {
    expect(build.isPinnedTag("b12230")).toBe(true);
    for (const bad of [
      "master",
      "latest",
      "",
      "12230",
      "b12230-rc",
      "b12230 --force",
      COMMIT,
      null,
    ])
      expect(build.isPinnedTag(bad)).toBe(false);
  });

  it("the command line refuses an unpinned tag", () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--tag", "master", "--work", path.join(os.tmpdir(), "x")],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing an unpinned tag");
  });
});

describe("the cmake arguments", () => {
  it("friday-native is a native static CPU server build", () => {
    const { configure, build: compile } = build.buildArgs({
      variant: "friday-native",
      tag: "b12230",
      toolchain: "vs2022",
    });
    for (const flag of [
      "-DGGML_NATIVE=ON",
      "-DGGML_BACKEND_DL=OFF",
      "-DBUILD_SHARED_LIBS=OFF",
      "-DGGML_OPENMP=ON",
      "-DLLAMA_BUILD_TESTS=OFF",
      "-DLLAMA_BUILD_EXAMPLES=OFF",
      "-DLLAMA_BUILD_TOOLS=ON",
      "-DLLAMA_BUILD_SERVER=ON",
      "-DLLAMA_OPENSSL=OFF",
    ])
      expect(configure).toContain(flag);
    expect(configure.join(" ")).toContain("-G Visual Studio 17 2022 -A x64");
    expect(compile).toEqual([
      "--build",
      "build",
      "--config",
      "Release",
      "--target",
      "llama-server",
      "--parallel",
    ]);
  });

  it("friday-portable loads the CPU backend as a plug-in and ships every CPU variant", () => {
    const { configure } = build.buildArgs({ variant: "friday-portable" });
    for (const flag of [
      "-DGGML_NATIVE=OFF",
      "-DGGML_BACKEND_DL=ON",
      "-DGGML_CPU_ALL_VARIANTS=ON",
      "-DBUILD_SHARED_LIBS=ON",
    ])
      expect(configure).toContain(flag);
    expect(configure).not.toContain("-DGGML_NATIVE=ON");
  });

  it("is CPU only: no GPU backend and no network features are switched on", () => {
    for (const variant of ["friday-native", "friday-portable"]) {
      const joined = build.buildArgs({ variant }).configure.join(" ");
      expect(joined).not.toMatch(/CUDA|VULKAN|METAL|HIP|SYCL|CURL/i);
      expect(joined).toContain("-DLLAMA_OPENSSL=OFF");
    }
  });

  it("sets the build type only for a single-config generator, and uses the given folders", () => {
    const vs = build.buildArgs({ toolchain: "vs2022", srcDir: "S", buildDir: "B" }).configure;
    expect(vs.slice(0, 4)).toEqual(["-S", "S", "-B", "B"]);
    expect(vs).not.toContain("-DCMAKE_BUILD_TYPE=Release");
    const ninja = build.buildArgs({ toolchain: "ninja" }).configure;
    expect(ninja).toContain("-DCMAKE_BUILD_TYPE=Release");
    expect(ninja.join(" ")).toContain("-G Ninja");
  });

  it("is deterministic and refuses unknown inputs", () => {
    expect(build.buildArgs({ variant: "friday-portable" })).toEqual(
      build.buildArgs({ variant: "friday-portable" }),
    );
    expect(() => build.buildArgs({ tag: "master" })).toThrow(/unpinned tag/);
    expect(() => build.buildArgs({ variant: "fast" })).toThrow(/unknown variant/);
    expect(() => build.buildArgs({ toolchain: "make; rm -rf /" })).toThrow(/unknown toolchain/);
    expect(() => build.buildArgs({ variant: "__proto__" })).toThrow(/unknown variant/);
  });

  it("parses the command line and rejects an unknown flag", () => {
    expect(
      build.parseArgs(["--work", "w", "--fixture", "f.gguf", "--timebox-min", "30", "--dry-run"]),
    ).toEqual({
      tag: "b12230",
      variant: "friday-native",
      toolchain: "vs2022",
      work: "w",
      fixture: "f.gguf",
      timeboxMin: 30,
      dryRun: true,
    });
    expect(() => build.parseArgs(["--shell"])).toThrow(/unknown argument/);
  });
});

describe("a dry run and the folders", () => {
  it("prints the plan on this machine and builds nothing", () => {
    const work = path.join(os.tmpdir(), `friday-runtime-llm-dry-${process.pid}`);
    const result = spawnSync(process.execPath, [SCRIPT, "--work", work, "--dry-run"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("llama.cpp b12230, friday-native");
    expect(result.stdout).toContain("--target llama-server");
    expect(result.stdout).toContain("friday-runtime-llm-b12230-friday-native-win-x64.zip");
    expect(fs.existsSync(work)).toBe(false);
  });

  it("the work folder must be outside the repository", () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--work", path.join(root, "temporary", "rt"), "--dry-run"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside the repository");
  });

  it("a real build is Windows only", () => {
    expect(() => build.assertBuildable("linux")).toThrow(/Windows only/);
    expect(() => build.assertBuildable("darwin")).toThrow(/Windows only/);
    expect(() => build.assertBuildable("win32")).not.toThrow();
  });
});

describe("the files and the record", () => {
  it("names the asset after the tag and the variant", () => {
    expect(build.assetName("b12230", "friday-native")).toBe(
      "friday-runtime-llm-b12230-friday-native-win-x64.zip",
    );
    expect(build.assetName("b12230", "friday-portable")).toContain("friday-portable-win-x64.zip");
    expect(() => build.assetName("main", "friday-native")).toThrow(/unpinned tag/);
  });

  it("renames the server and keeps every DLL under its own name", () => {
    expect(
      build.planCopies(["ggml-cpu-haswell.dll", "llama-server.exe", "readme.txt", "ggml.DLL"]),
    ).toEqual([
      { from: "llama-server.exe", to: "friday-runtime-llm.exe" },
      { from: "ggml-cpu-haswell.dll", to: "ggml-cpu-haswell.dll" },
      { from: "ggml.DLL", to: "ggml.DLL" },
    ]);
    expect(() => build.planCopies(["ggml.dll"])).toThrow(/llama-server\.exe/);
  });

  it("lists every file with its hash, sorted by name", () => {
    expect(record()).toEqual({
      name: "friday-runtime-llm",
      engine: "llama.cpp",
      tag: "b12230",
      commit: COMMIT,
      variant: "friday-native",
      toolchain: "vs2022",
      files: [
        { name: "friday-runtime-llm.exe", sha256: SHA },
        { name: "ggml-cpu.dll", sha256: "c".repeat(64) },
      ],
      assetName: "friday-runtime-llm-b12230-friday-native-win-x64.zip",
      sha256: "d".repeat(64),
      builtAt: "2026-11-27T00:00:00.000Z",
    });
  });

  it("refuses an unpinned tag, a short commit, a bad hash and a missing engine file", () => {
    expect(() => record({ tag: "main" })).toThrow(/unpinned tag/);
    expect(() => record({ commit: "abc123" })).toThrow(/40-character/);
    expect(() => record({ assetSha256: "xyz" })).toThrow(/64 hex/);
    expect(() => record({ assetSha256: null })).toThrow(/64 hex/);
    expect(() => record({ files: [{ name: "x.dll", sha256: SHA }] })).toThrow(/friday-runtime-llm/);
    expect(() => record({ files: [{ name: "friday-runtime-llm.exe", sha256: "z" }] })).toThrow(
      /64 hex/,
    );
    expect(() => record({ toolchain: "other" })).toThrow(/unknown toolchain/);
    expect(() => record({ builtAt: "" })).toThrow();
  });

  it("is written only when the smoke test passed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-runtime-llm-"));
    try {
      const file = path.join(dir, "friday-runtime-llm.json");
      for (const bad of [false, undefined, "yes", 1])
        expect(() => build.writeRecord(file, record(), bad)).toThrow(/smoke/);
      expect(fs.existsSync(file)).toBe(false);
      build.writeRecord(file, record(), true);
      expect((JSON.parse(fs.readFileSync(file, "utf8")) as Rec).commit).toBe(COMMIT);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the committed record has null fields until an owner build fills it", () => {
    const committed = JSON.parse(read("config/friday-runtime-llm.json")) as Rec;
    expect(committed.name).toBe("friday-runtime-llm");
    expect(committed.engine).toBe("llama.cpp");
    for (const key of ["tag", "commit", "variant", "toolchain", "assetName", "sha256", "builtAt"])
      expect(committed[key as keyof Rec]).toBeNull();
    expect(committed.files).toEqual([]);
  });
});

describe("the smoke test", () => {
  const ok: Reply = { status: 200, body: { status: "ok" } };
  const done = (tokens: unknown, content: unknown = " Paris"): Reply => ({
    status: 200,
    body: { content, tokens_predicted: tokens },
  });

  it("passes on a healthy server and exactly 16 tokens", () => {
    expect(build.smokeVerdict(ok, done(16)).ok).toBe(true);
  });

  it("fails on a sick server, a short answer, an empty text or no answer", () => {
    expect(
      build.smokeVerdict({ status: 503, body: { status: "loading model" } }, done(16)).ok,
    ).toBe(false);
    expect(build.smokeVerdict(null, done(16)).ok).toBe(false);
    expect(build.smokeVerdict(ok, null).ok).toBe(false);
    expect(build.smokeVerdict(ok, { status: 500, body: null }).ok).toBe(false);
    expect(build.smokeVerdict(ok, done(15)).reason).toContain("expected 16 tokens");
    expect(build.smokeVerdict(ok, done(16, "")).ok).toBe(false);
    expect(build.smokeVerdict(ok, done(undefined)).ok).toBe(false);
  });

  it("starts the engine on loopback only, one slot, and asks for a greedy 16-token answer", () => {
    const args = build.smokeServerArgs("m.gguf", 4321);
    expect(args.slice(args.indexOf("--host"), args.indexOf("--host") + 4)).toEqual([
      "--host",
      "127.0.0.1",
      "--port",
      "4321",
    ]);
    expect(args).toContain("m.gguf");
    expect(args[args.indexOf("-np") + 1]).toBe("1");
    expect(build.smokeCompletionBody()).toMatchObject({
      n_predict: 16,
      temperature: 0,
      top_k: 1,
      cache_prompt: false,
    });
  });

  const standIn = (mode: "ok" | "short" | "exit") =>
    [
      `const http = require("node:http");`,
      `const mode = ${JSON.stringify(mode)};`,
      `if (mode === "exit") process.exit(3);`,
      `const port = Number(process.argv[process.argv.indexOf("--port") + 1]);`,
      `http.createServer((req, res) => {`,
      `  res.setHeader("content-type", "application/json");`,
      `  if (req.url === "/health") return res.end(JSON.stringify({ status: "ok" }));`,
      `  req.resume();`,
      `  req.on("end", () => res.end(JSON.stringify({ content: " Paris", tokens_predicted: mode === "ok" ? 16 : 4 })));`,
      `}).listen(port, "127.0.0.1");`,
    ].join("\n");

  it("drives a stand-in server end to end and always stops it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-runtime-llm-smoke-"));
    try {
      const run = (mode: "ok" | "short" | "exit") => {
        const script = path.join(dir, `engine-${mode}.cjs`);
        fs.writeFileSync(script, standIn(mode));
        return build.runSmoke(process.execPath, path.join(dir, "m.gguf"), {
          waitMs: 8000,
          leadArgs: [script],
        });
      };
      expect((await run("ok")).ok).toBe(true);
      expect((await run("short")).reason).toContain("expected 16 tokens");
      expect((await run("exit")).reason).toContain("/health");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);
});

describe("the Windows CMD chain never reaches the engine build", () => {
  it("is not called by setup, doctor or build", () => {
    for (const file of [
      "scripts/setup-windows.ps1",
      "scripts/build-windows.cmd",
      "scripts/build-pipeline.cjs",
      "scripts/doctor.cjs",
      "scripts/check-environment.cjs",
    ])
      expect(read(file)).not.toContain("build-friday-runtime-llm");
  });

  it("names no assistant or tool in the script or the record", () => {
    const text = `${read("scripts/build-friday-runtime-llm.cjs")}\n${read("config/friday-runtime-llm.json")}`;
    expect(text).not.toMatch(/claude|anthropic|openai|copilot|cursor/i);
  });
});
