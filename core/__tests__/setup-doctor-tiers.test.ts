/**
 * Doctor, the environment check and the build run in two tiers: a BLOCKER (what the build cannot run without) fails,
 * everything else the setup downloads is a NOTICE (printed, recorded for FRIDAY > Install Manager / Models, exit 0).
 * Pure: temp folders, injected spawns and probes, no network, no hardware, no date.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasCommand } from "./helpers/environment";
import { writeCommandStub } from "./helpers/platform-command";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const probes = require_(path.join(root, "scripts/doctor-probes.cjs"));
const doctor = require_(path.join(root, "scripts/doctor.cjs"));
const pipeline = require_(path.join(root, "scripts/build-pipeline.cjs"));
const stack = require_(path.join(root, "scripts/voice-stack.cjs"));
const prefetchModels = require_(path.join(root, "scripts/prefetch-models.cjs"));
const notices = require_(path.join(root, "scripts/setup-notices.cjs"));

const made: string[] = [];
function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-tiers-"));
  made.push(dir);
  return dir;
}
afterEach(() => {
  while (made.length) rmSync(made.pop() as string, { recursive: true, force: true });
});

type Check = { name: string; ok: boolean; required: boolean; blocker?: boolean };
const row = (name: string, ok: boolean, required: boolean, blocker?: boolean): Check => ({
  name,
  ok,
  required,
  ...(blocker === undefined ? {} : { blocker }),
});

describe("the environment check: which rows are blockers", () => {
  const source = read("scripts/check-environment.cjs");

  it("the blocker row set is a fixed list", () => {
    const names = [...source.matchAll(/name: "([^"]+)",\s*blocker: true,/g)].map((m) => m[1]);
    expect(names).toEqual([
      "Node.js",
      "npm",
      "Python .venv (FRIDAY runtime)",
      "Python",
      "pip (in .venv)",
      "Python core imports",
      "SQLite (python sqlite3 module)",
      "Electron package + dependencies",
      "Build tools (vite, electron-builder)",
      "Electron binary",
      "Electron binary runnable",
      "Installer tools (NSIS)",
    ]);
    // A kernel package stops the build; a voice or capability package is a notice.
    expect(source).toContain("blocker: !voice && !capability,");
    // No tool, model, voice or toolkit row is a blocker.
    expect(source).not.toMatch(/noticeId: [^\n]+\n\s*blocker: true/);
    expect(source).not.toMatch(/name: "(FFmpeg|Tesseract OCR|Git|PowerShell)",\s*blocker/);
  });

  it("a failed model, tool or voice row is a NOTICE: exit 0; a blocker is exit 1; strict makes a notice fail again", () => {
    const blocker = row("Node.js", false, true, true);
    const model = row("Speech model: small", false, true);
    const tool = row("FFmpeg", false, true);
    const optional = row("Tesseract language pack: Hindi (hin)", false, false);
    const fine = row("npm", true, true, true);
    const {
      blockers,
      notices: soft,
      warned,
    } = probes.classifyChecks([blocker, model, tool, optional, fine]);
    expect(blockers.map((c: Check) => c.name)).toEqual(["Node.js"]);
    expect(soft.map((c: Check) => c.name)).toEqual(["Speech model: small", "FFmpeg"]);
    expect(warned.map((c: Check) => c.name)).toEqual(["Tesseract language pack: Hindi (hin)"]);

    expect(probes.environmentExitCode([model, tool, optional, fine])).toBe(0);
    expect(probes.environmentExitCode([blocker, model])).toBe(1);
    expect(probes.environmentExitCode([model, tool], { noticesFail: true })).toBe(1);
    expect(probes.environmentExitCode([optional], { noticesFail: true })).toBe(0);
    expect(probes.environmentExitCode([optional], { strict: true })).toBe(1);
    expect(probes.environmentExitCode([fine], { strict: true, noticesFail: true })).toBe(0);
  });

  it.runIf(process.platform !== "win32" && hasCommand("sh"))(
    "a tool that is too old prints a NOTICE row, is recorded with its repair, and is not in the blocker list",
    () => {
      const dir = temp();
      const bin = path.join(dir, "bin");
      const gitScript = path.join(dir, "git-stub.cjs");
      writeFileSync(gitScript, 'console.log("git version 1.0.0");\n');
      const stub = writeCommandStub(bin, "git", gitScript);
      const home = path.join(dir, "home");
      mkdirSync(home);
      const run = spawnSync(process.execPath, [path.join(root, "scripts/check-environment.cjs")], {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: stub.pathEnv,
          FRIDAY_WORKSPACE_ROOT: home,
          FRIDAY_REACH_PROBE: "0",
          FRIDAY_OFFLINE: "1",
        },
        timeout: 120_000,
      });
      const out = `${run.stdout}\n${run.stderr}`;
      expect(out).toMatch(/NOTICE\s+Git\s+v1\.0\.0/);
      expect(out).toContain("not a stop");
      const failedBlock = out.includes("FAILED —") ? out.slice(out.indexOf("FAILED —")) : "";
      expect(failedBlock).not.toMatch(/^\s+\* Git$/m);
      const recorded = notices
        .readNotices(home)
        .find((entry: { id: string }) => entry.id === "tool:git");
      expect(recorded).toMatchObject({ kind: "tool", label: "Git", repair: "npm run setup" });
    },
    130_000,
  );
});

describe("Doctor: blocker steps fail the run, notice steps only print NOTICE", () => {
  const ok = () => ({ status: 0 });
  const bad = () => ({ status: 1 });
  const recordIn = (dir: string) => ({
    recordNotice: (entry: object, opts: object) =>
      notices.recordNotice(entry, { ...opts, root: dir }),
    readNotices: () => notices.readNotices(dir),
    clearNotice: (id: string) => notices.clearNotice(id, { root: dir }),
  });

  it("keeps ten steps and gives every step a tier: the fixed split", () => {
    expect(doctor.STEPS).toHaveLength(10);
    const tiers = Object.fromEntries(
      doctor.STEPS.map((step: { name: string; tier: string }) => [step.name, step.tier]),
    );
    expect(tiers).toEqual({
      dependencies: "blocker",
      "environment check and repair": "blocker",
      "packs that ship inside the EXE": "notice",
      "speech, voice and chat models": "notice",
      "voice files load and speak": "notice",
      "voice stack: runners, models, packages and connections": "notice",
      "runtime folders and database": "blocker",
      "main-process dependencies": "blocker",
      "environment registry": "notice",
      "pinned local runners against the newest release": "notice",
    });
  });

  it("the Windows setup script and Doctor agree which step is a notice and which is a blocker", () => {
    const ps1 = read("scripts/setup-windows.ps1");
    // Doctor step name -> the script that step runs (the stages of npm run setup that run the same script).
    const stepScript: Record<string, string> = {
      "environment check and repair": "check-environment.cjs",
      "packs that ship inside the EXE": "stage-toolchain.cjs",
      "runtime folders and database": "init-runtime.cjs",
    };
    const tierOf = (script: string) => {
      const call = new RegExp(
        `& node\\.exe scripts\\\\${script.replace(".", "\\.")}[^\\r\\n]*\\r?\\n(?:\\s*#[^\\r\\n]*\\r?\\n)*\\s*if \\(\\$LASTEXITCODE -ne 0\\) \\{ (Stop-OrNotice|throw)`,
      ).exec(ps1);
      return call ? (call[1] === "throw" ? "blocker" : "notice") : "";
    };
    const doctorTier = (name: string) =>
      doctor.STEPS.find((step: { name: string }) => step.name === name)?.tier;
    for (const [name, script] of Object.entries(stepScript)) {
      const setupTier = tierOf(script);
      expect(setupTier, `${script} must be handled by a stage of setup-windows.ps1`).not.toBe("");
      expect(doctorTier(name), `${name} (${script})`).toBe(setupTier);
    }
    // A notice step records what it stands for under a kind the notice record knows.
    expect(read("scripts/doctor.cjs")).toContain('"packs that ship inside the EXE": "pack"');
  });

  it("only notice steps failing: DOCTOR PASS with the notice summary and the count line", () => {
    const dir = temp();
    const lines: string[] = [];
    const out = doctor.runDoctor(
      [
        { name: "dependencies", run: ok },
        { name: "speech, voice and chat models", run: bad, tier: "notice" },
        { name: "voice files load and speak", run: bad, tier: "notice" },
        { name: "runtime folders and database", run: ok, tier: "blocker" },
      ],
      (line: string) => lines.push(line),
      {},
      recordIn(dir),
    );
    expect(out.ok).toBe(true);
    const text = lines.join("\n");
    expect(text).toContain("NOTICE  speech, voice and chat models (exit 1)");
    expect(text).toContain("NOTICE  voice files load and speak (exit 1)");
    expect(text).not.toContain("DOCTOR FAIL");
    expect(text).toContain("2 item(s) could not be finished here");
    expect(text).toContain(
      "DOCTOR PASS - FRIDAY is ready to build and run. 2 item(s) can be finished later in FRIDAY > Install Manager / Models.",
    );
    expect(notices.readNotices(dir).map((entry: { kind: string }) => entry.kind)).toEqual([
      "model",
      "voice",
    ]);
  });

  it("a blocker failing is DOCTOR FAIL even when notices are open, and a later pass clears its notice", () => {
    const dir = temp();
    const lines: string[] = [];
    const deps = recordIn(dir);
    const out = doctor.runDoctor(
      [
        { name: "dependencies", run: bad, tier: "blocker" },
        { name: "environment registry", run: bad, tier: "notice" },
      ],
      (line: string) => lines.push(line),
      {},
      deps,
    );
    expect(out.ok).toBe(false);
    expect(lines.join("\n")).toContain("DOCTOR FAIL - 1 step(s) did not finish: dependencies");
    expect(notices.readNotices(dir)).toHaveLength(1);
    doctor.runDoctor(
      [{ name: "environment registry", run: ok, tier: "notice" }],
      () => {},
      {},
      deps,
    );
    expect(notices.readNotices(dir)).toHaveLength(0);
  });

  it("FRIDAY_SETUP_STRICT=1 makes a failing notice step fail the run again", () => {
    const lines: string[] = [];
    const out = doctor.runDoctor(
      [{ name: "environment registry", run: bad, tier: "notice" }],
      (line: string) => lines.push(line),
      { FRIDAY_SETUP_STRICT: "1" },
    );
    expect(out.ok).toBe(false);
    expect(lines.join("\n")).toContain("FAIL  environment registry (exit 1)");
  });

  it("a plain step stays a blocker and the old pass line is unchanged", () => {
    expect(doctor.runDoctor([{ name: "a", run: bad }], () => {}).ok).toBe(false);
    const lines: string[] = [];
    doctor.runDoctor([{ name: "a", run: ok }], (line: string) => lines.push(line));
    expect(lines).toContain("DOCTOR PASS - FRIDAY is ready to test, build and run.");
  });

  it("the models step tries the opt-in mirror once when Hugging Face is down, and never when it answers", () => {
    const calls: Array<string | undefined> = [];
    const down = () => ({ "huggingface.co": { state: "down" } });
    const up = () => ({ "huggingface.co": { state: "up" } });
    const run =
      (statuses: number[]) =>
      (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
        calls.push(opts.env["FRIDAY_HF_MIRROR"]);
        return { status: statuses.shift() ?? 0 };
      };
    const logs: string[] = [];
    const log = (line: string) => logs.push(line);
    const base = { env: {}, log };

    // exit 1 first, Hugging Face down: one more try with the mirror, which finishes.
    const first = doctor.models({ ...base, run: run([1, 0]), reach: down, readOpen: () => false });
    expect(first.status).toBe(0);
    expect(calls).toEqual([undefined, "1"]);
    expect(logs.join("\n")).toContain("opt-in mirror");

    // exit 0 with a model notice still open: the mirror is tried too.
    calls.length = 0;
    doctor.models({ ...base, run: run([0, 0]), reach: down, readOpen: () => true });
    expect(calls).toEqual([undefined, "1"]);

    // Hugging Face answers, or nothing is open, or the owner already set the mirror: one pass only.
    calls.length = 0;
    doctor.models({ ...base, run: run([1]), reach: up, readOpen: () => true });
    doctor.models({ ...base, run: run([0]), reach: down, readOpen: () => false });
    doctor.models({
      env: { FRIDAY_HF_MIRROR: "1" },
      log,
      run: run([1]),
      reach: down,
      readOpen: () => true,
    });
    expect(calls).toHaveLength(3);

    // The second pass failing as well keeps the first result.
    const both = doctor.models({ ...base, run: run([1, 1]), reach: down, readOpen: () => true });
    expect(both.status).toBe(1);
  });
});

describe("the build: a notice never throws, a blocker does", () => {
  it("the notice tier is the agent toolkit only; every other script is a blocker", () => {
    expect(Object.keys(pipeline.NOTICE_TIER)).toEqual(["scripts/prefetch-toolkit.cjs"]);
    const source = read("scripts/build-pipeline.cjs");
    for (const call of [
      'runNode("scripts/check-engines.cjs", [], root)',
      'runNode("scripts/ensure-electron.cjs", ["--quiet"], root)',
      'runNode("scripts/init-runtime.cjs", [], root)',
      'runNode("scripts/setup-python.cjs", [], root)',
      'runNode("scripts/check-environment.cjs", ["--fix", "--summary"], root)',
    ]) {
      expect(source).toContain(call);
    }
  });

  it("a toolkit exit is recorded as a notice and the build goes on; a blocker script still throws", () => {
    const dir = temp();
    const logs: string[] = [];
    const failing = {
      run: () => ({ status: 1 }),
      noticeRoot: dir,
      log: (line: string) => logs.push(line),
      env: {},
    };
    expect(() =>
      pipeline.runNode("scripts/prefetch-toolkit.cjs", ["--no-update"], root, failing),
    ).not.toThrow();
    expect(notices.readNotices(dir)).toMatchObject([{ id: "agent-toolkit", kind: "tool" }]);
    expect(logs.join("\n")).toContain("NOTICE Agent toolkit");
    for (const script of [
      "scripts/check-engines.cjs",
      "scripts/ensure-electron.cjs",
      "scripts/init-runtime.cjs",
      "scripts/setup-python.cjs",
      "scripts/check-environment.cjs",
    ]) {
      expect(() => pipeline.runNode(script, [], root, failing), script).toThrow(/failed \(1\)/);
    }
    // A clean exit is not a notice; strict turns the toolkit notice back into a stop.
    const clean = pipeline.runNode("scripts/prefetch-toolkit.cjs", [], root, {
      run: () => ({ status: 0 }),
    });
    expect(clean).toEqual({ notice: false });
    expect(() =>
      pipeline.runNode("scripts/prefetch-toolkit.cjs", [], root, {
        ...failing,
        env: { FRIDAY_SETUP_STRICT: "1" },
      }),
    ).toThrow(/prefetch-toolkit.cjs failed \(1\)/);
  });

  it("FRIDAY BUILD READY lists the notices as NOTICE rows in the shape of the PASS and SKIP rows", () => {
    const options = pipeline.parseArgs(["node", "x", "--caller", "cmd"]);
    const phases = [{ name: "prepare-environment", status: "ok", detail: "environment ready" }];
    const plain = pipeline.readySummary(options, { ok: true, phases }, root);
    expect(plain.join("\n")).not.toContain("NOTICE");
    const lines: string[] = pipeline.readySummary(
      options,
      {
        ok: true,
        phases,
        notices: [
          {
            id: "hinglish-ear",
            label: "Voice model: Hinglish ear",
            reason: "download did not finish",
          },
          { id: "agent-toolkit", label: "Agent toolkit", reason: "ended with exit 1" },
        ],
      },
      root,
    );
    const pass = lines.find((line) => line.startsWith("PASS ")) as string;
    const note = lines.find((line) => line.startsWith("NOTICE")) as string;
    expect(note).toBe("NOTICE Voice model: Hinglis download did not finish");
    // PASS, SKIP and NOTICE rows put their text in the same column.
    expect(note.indexOf("download")).toBe(pass.indexOf("environment ready"));
    expect(lines.filter((line) => line.startsWith("NOTICE"))).toHaveLength(2);
    expect(lines.join("\n")).toContain(
      "2 item(s) can be finished later in FRIDAY > Install Manager / Models.",
    );
    expect(lines.join("\n")).toContain("FRIDAY BUILD READY");
  });
});

describe("one notice id per item: `<kind>:<id>`, recorded by one script and cleared by another", () => {
  const modelNoticeId = (id: string) => prefetchModels.noticeOf({ id }).id;
  const idOf = (check: object) => probes.noticeIdOf(check, { modelNoticeId });

  it("a toolkit failure (tool:FFmpeg) and the later environment check use the same id", () => {
    const toolkit = require_(path.join(root, "scripts/prefetch-toolkit.cjs"));
    const dir = temp();
    toolkit.recordToolNotices([{ id: "FFmpeg", ok: false, error: "no network" }], {
      root: dir,
      log: () => {},
    });
    expect(notices.readNotices(dir).map((entry: { id: string }) => entry.id)).toEqual([
      "tool:FFmpeg",
    ]);
    const check = { name: "FFmpeg", noticeId: "FFmpeg", group: "toolchain", required: true };
    expect(idOf(check)).toBe("tool:FFmpeg");
    expect(idOf({ ...check, name: "Git", noticeId: "Git", group: "agent-toolkit" })).toBe(
      "tool:Git",
    );
    notices.clearNotice(idOf(check), { root: dir });
    expect(notices.readNotices(dir)).toEqual([]);
  });

  it("a model or voice file from the environment check matches what the model step records", () => {
    const dir = temp();
    prefetchModels.recordRowNotices(
      [
        { id: "hindi-ear", ok: false, error: "x" },
        { id: "qwen3-4b", ok: false, error: "x" },
      ],
      { root: dir, log: () => {} },
    );
    const recorded = notices.readNotices(dir).map((entry: { id: string }) => entry.id);
    expect(recorded).toEqual(["voice:hindi-ear", "model:qwen3-4b"]);
    for (const job of ["hindi-ear", "qwen3-4b"]) {
      expect(recorded).toContain(idOf({ name: job, noticeId: job, group: "local-models" }));
    }
  });

  it("a row with no job id gets `<kind>:<slug of its name>`, and the old bare id is listed to be cleared", () => {
    const check = { name: "Python package: Pillow", group: "python-packages", required: true };
    expect(idOf(check)).toBe("package:python-package-pillow");
    expect(probes.legacyNoticeIds(check)).toEqual(["python-package-pillow"]);
    expect(
      probes.legacyNoticeIds({ name: "FFmpeg", noticeId: "FFmpeg", group: "toolchain" }),
    ).toEqual(["FFmpeg", "ffmpeg"]);
  });

  it("the voice stack records `voice:<job>` for a missing file and clears it once the file is there", () => {
    const dir = temp();
    const warn = [{ layer: "disk", name: "hindi-ear", state: "WARN", detail: "missing; x" }];
    for (const entry of stack.noticeEntries(warn)) notices.recordNotice(entry, { root: dir });
    expect(notices.readNotices(dir).map((entry: { id: string }) => entry.id)).toEqual([
      "voice:hindi-ear",
    ]);
    // The model step records the same item under the same id (one line, not two).
    prefetchModels.recordRowNotices([{ id: "hindi-ear", ok: false, error: "x" }], {
      root: dir,
      log: () => {},
    });
    expect(notices.readNotices(dir)).toHaveLength(1);
    const pass = [{ layer: "disk", name: "hindi-ear", state: "PASS", detail: "on disk" }];
    for (const id of stack.noticeClearIds(pass)) notices.clearNotice(id, { root: dir });
    expect(notices.readNotices(dir)).toEqual([]);
  });

  it("a Doctor notice step records `<kind>:doctor-<slug>` and a later pass clears it, the old bare id too", () => {
    const dir = temp();
    const recordLegacy = () =>
      notices.recordNotice(
        { id: "doctor-environment-registry", kind: "runtime", reason: "old", label: "old" },
        { root: dir, print: false },
      );
    recordLegacy();
    const run = (status: number) =>
      doctor.runDoctor(
        [{ name: "environment registry", run: () => ({ status }), tier: "notice" }],
        () => {},
        {},
        {
          recordNotice: (entry: object, opts: object) =>
            notices.recordNotice(entry, { ...opts, root: dir }),
          readNotices: () => notices.readNotices(dir),
          clearNotice: (id: string) => notices.clearNotice(id, { root: dir }),
        },
      );
    run(1);
    expect(notices.readNotices(dir).map((entry: { id: string }) => entry.id)).toContain(
      "runtime:doctor-environment-registry",
    );
    run(0);
    expect(notices.readNotices(dir)).toEqual([]);
  });
});

describe("voice stack: a missing planned item is a WARN notice", () => {
  it("records one notice per missing disk file and per missing package, none for INFO or PASS rows", () => {
    const entries = stack.noticeEntries([
      {
        layer: "disk",
        name: "hindi-ear",
        state: "WARN",
        detail: "missing — run npm run doctor; sources: huggingface.co",
      },
      { layer: "disk", name: "silero-vad", state: "INFO", detail: "optional, not on disk" },
      {
        layer: "language",
        name: "hindi ears (STT)",
        state: "WARN",
        detail: "hindi-ear on disk; package onnxruntime NOT installed in the venv",
      },
      {
        layer: "language",
        name: "hindi light TTS",
        state: "WARN",
        detail: "hindi-light-tts MISSING: planned for this PC, run npm run doctor",
      },
      {
        layer: "language",
        name: "echo canceller (all languages)",
        state: "PASS",
        detail: "package pyaec present",
      },
    ]);
    expect(entries.map((e: { id: string }) => e.id)).toEqual([
      "voice:hindi-ear",
      "package:voice-stack:hindi ears (STT)",
    ]);
    expect(entries[0]).toMatchObject({ kind: "voice", repair: "npm run doctor" });
    expect(entries[1]).toMatchObject({ kind: "package", repair: "npm run setup:python" });
  });

  it("a WARN never makes the standalone check fail: only a FAIL row does", () => {
    const lines: string[] = [];
    const rows = [
      { layer: "disk", name: "hindi-ear", state: "WARN", detail: "missing" },
      { layer: "package", name: "fastapi", state: "PASS", detail: "pinned" },
    ];
    expect(stack.print(rows, (line: string) => lines.push(line))).toBe(0);
    expect(lines.join("\n")).toContain("1 warn (notice:");
    const broken = [{ layer: "wiring", name: "x", state: "FAIL", detail: "broken" }];
    expect(stack.print(broken, () => {})).toBe(1);
  });
});

describe("the reach order and the this-PC rows", () => {
  it("orderSources moves a down host last and never removes one", () => {
    const sources = [
      { url: "https://huggingface.co/a" },
      { url: "https://hf-mirror.com/a" },
      { kind: "hf-repo", repo: "x/y" },
      "cdn.npmmirror.com",
    ];
    const reach = { "huggingface.co": { state: "down" }, "hf-mirror.com": { state: "up" } };
    const ordered = probes.orderSources(sources, reach);
    expect(ordered).toHaveLength(4);
    expect(ordered[0]).toEqual({ url: "https://hf-mirror.com/a" });
    expect(ordered.slice(-2)).toEqual([
      { url: "https://huggingface.co/a" },
      { kind: "hf-repo", repo: "x/y" },
    ]);
    // Unchecked hosts keep their place; an empty or missing reach changes nothing.
    expect(probes.orderSources(sources, {})).toEqual(sources);
    expect(probes.orderSources(sources, { "huggingface.co": { state: "unchecked" } })).toEqual(
      sources,
    );
    expect(probes.orderSources(undefined, reach)).toEqual([]);
    expect(probes.huggingFaceDown(reach)).toBe(true);
    expect(probes.huggingFaceDown({})).toBe(false);
  });

  it("the Visual C++ version row compares with the floor and is skipped without one", () => {
    expect(probes.vcRedistRow("14.38.33135", "")).toBeNull();
    expect(probes.vcRedistRow("14.38.33135", "14.36")).toMatchObject({
      ok: true,
      found: "v14.38.33135",
    });
    expect(probes.vcRedistRow("14.29.30133", "14.36")).toMatchObject({ ok: false });
    expect(probes.vcRedistRow("", "14.36")).toMatchObject({ ok: true, found: "version not read" });
  });

  it("the onnxruntime row warns when the installed flavour differs from the planned one", () => {
    const probe = (flavour: string) => ({
      flavour,
      version: "1.31.1",
      providers: [],
      wheels: [flavour],
    });
    expect(probes.ortMismatch(probe("cpu"), { variant: "cpu" })).toBe("");
    expect(probes.ortMismatch(probe("cpu"), { variant: "directml" })).toBe(
      "planned directml, installed cpu",
    );
    expect(probes.ortMismatch(probe("none"), { variant: "cpu" })).toBe(
      "planned cpu, not installed",
    );
    expect(probes.ortMismatch(null, { variant: "cpu" })).toBe("");
    expect(probes.ortMismatch(probe("cpu"), undefined)).toBe("");
  });

  it("the llama.cpp row says 'planned X, installed Y' and warns only on a different recorded build", () => {
    expect(probes.llamaBackendRow(undefined, null)).toBeNull();
    expect(probes.llamaBackendRow({ backend: "cuda" }, { backend: "cuda" })).toMatchObject({
      ok: true,
      found: "planned cuda, installed cuda",
    });
    expect(probes.llamaBackendRow({ backend: "cuda" }, { backend: "cpu" })).toMatchObject({
      ok: false,
      found: "planned cuda, installed cpu",
    });
    expect(probes.llamaBackendRow({ backend: "vulkan" }, null)?.found).toBe(
      "planned vulkan, not installed yet",
    );
    expect(probes.llamaBackendRow({ backend: "cuda" }, { backend: null })?.ok).toBe(true);
  });

  it("'this PC since setup' needs both fingerprints and warns when they differ", () => {
    expect(probes.setupChangedRow(null, "abc")).toBeNull();
    expect(probes.setupChangedRow({ fingerprint: "abc" }, "")).toBeNull();
    const record = { fingerprint: "abc", at: "2026-11-01T10:00:00Z" };
    expect(probes.setupChangedRow(record, "abc")).toMatchObject({
      ok: true,
      found: "same PC as at setup (2026-11-01)",
    });
    expect(probes.setupChangedRow(record, "xyz")).toMatchObject({
      ok: false,
      found: "this PC changed since setup (2026-11-01)",
    });
  });

  it("doctor header names the real tiers: packs are a notice, the system CA store is on for child steps", () => {
    const source = read("scripts/doctor.cjs");
    const header = source.slice(0, source.indexOf('"use strict"'));
    expect(header).not.toMatch(/the EXE packs\b[^)]*\)\s+is what the build cannot run without/);
    expect(header).toMatch(/NOTICE[\s*]+step \(the EXE packs/);
    const env: Record<string, string> = {};
    doctor.useSystemCa(env);
    expect(env["NODE_USE_SYSTEM_CA"]).toBe("1");
    const own: Record<string, string> = { NODE_USE_SYSTEM_CA: "0" };
    doctor.useSystemCa(own);
    expect(own["NODE_USE_SYSTEM_CA"]).toBe("0");
  });

  it("environment check: a never-blocking Vulkan row for a non-NVIDIA GPU without vulkan-1.dll", () => {
    const source = read("scripts/check-environment.cjs");
    const at = source.indexOf("vulkan-1.dll");
    expect(at).toBeGreaterThan(-1);
    const block = source.slice(at - 600, at + 900);
    expect(block).toContain('vendor !== "nvidia"');
    expect(block).toContain("required: false");
    expect(block).toContain("warn: true");
  });
});
