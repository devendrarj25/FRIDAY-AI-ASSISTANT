/**
 * The Python setup installs every package before it fetches any model. On the owner's PC a chat model
 * whose registry timed out ended the setup with exit 1 BEFORE the capability packages (supertonic,
 * moonshine-voice, pyrnnoise, soundfile, uharfbuzz, py7zr, comtypes) were installed, so Doctor and the
 * build could not repair anything and every run repeated the same failure.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const setup = readFileSync(path.join(root, "scripts/setup-python.cjs"), "utf8");

describe("setup-python order", () => {
  it("installs the kernel and capability packages before it fetches any model", () => {
    const kernel = setup.indexOf("installing kernel requirements from");
    const capability = setup.indexOf("installing capability extras from");
    const models = setup.indexOf("fetchModelsAndProbe();");
    expect(kernel).toBeGreaterThan(-1);
    expect(capability).toBeGreaterThan(kernel);
    expect(models).toBeGreaterThan(capability);
  });

  it("collects a model failure as a notice and in the final report instead of exiting on the spot", () => {
    const start = setup.indexOf("function fetchModelsAndProbe()");
    const end = setup.indexOf("function voiceImportable()");
    const body = setup.slice(start, end);
    expect(body).not.toContain("process.exit(");
    expect(body).toContain('incomplete.push("the speech, voice and chat models are not complete")');
    // The model step is a NOTICE (recorded for the Install Manager), never a stop.
    expect(body).toContain('id: "model:setup"');
    expect(body).toContain('id: "voice:whisper-model"');
    // The final verdict names everything at once. Strict mode (FRIDAY_SETUP_STRICT=1) still fails with exit 1 through
    // exitCode (scripts/leave.cjs); a default run prints the notices and ends well.
    expect(setup).toContain("const mustComplete =");
    expect(setup).toContain("setupNotices.isStrict()");
    const verdict = setup.slice(setup.indexOf("if (blockers.length) {"));
    expect(verdict).toContain("else if (incomplete.length && mustComplete) {");
    expect(verdict).toContain("leave(1)");
    expect(verdict).not.toContain("process.exit(1)");
    expect(verdict).toContain("setupNotices.summaryLines");
  });

  it("never stops on a voice package, a capability package, a model or the GPU libraries; only the real blockers exit 1", () => {
    // The voice packages used to end the setup on Windows; now they are a recorded notice.
    expect(setup).not.toContain("voice runtime packages failed to install");
    expect(setup).not.toContain("edge-tts) are still not importable");
    expect(setup).toContain('id: "package:voice-runtime"');
    expect(setup).toContain("id: `package:${pin.name}`");
    expect(setup).toContain('id: "package:cuda-libs"');
    expect(setup).toContain('id: "model:chroma-minilm"');
    // A notice clears when the item verifies later.
    expect(setup).toContain('noticeCleared("package:voice-runtime")');
    expect(setup).toContain("noticeCleared(`package:${pin.name}`)");
    // The blockers keep their exit 1: no Python, no venv, no core kernel packages, no SQLite, a broken kernel.
    expect(setup).toContain("every official PyPI installation method failed");
    expect(setup).toContain("core kernel packages are still not importable");
    expect(setup).toContain("this Python build cannot use SQLite");
    expect(setup).toContain("blockers.push(");
  });

  it("installs the capability packages one by one when the set fails as a whole", () => {
    const block = setup.slice(setup.indexOf("installing capability extras from"));
    expect(block).toContain("installing each package on its own");
    expect(block).toContain("noUpgrade: true");
    expect(block).toContain("did not install");
  });

  it("saves the package list before a newest-release install and restores it when the kernel stops loading", () => {
    expect(setup).toContain("takeUpgradeSnapshot();");
    expect(setup).toContain("function rollbackUpgrade()");
    expect(setup).toContain("pip-before-upgrade.txt");
    // Both the early import check and the check after the capability packages can roll back.
    expect(setup.match(/rollbackUpgrade\(\)/g)?.length).toBeGreaterThanOrEqual(3);
    // A rolled-back run is never recorded as checked, so the next run asks again.
    expect(setup).toContain("upgradeTried = false;");
  });
});

describe("the GPU ONNX Runtime swap never leaves both wheels or none unrecorded", () => {
  type Call = string;
  /** Runs the real installGpuOnnxRuntime text with stand-in pip, probes and notice record. */
  function swap(failing: { uninstallCpu?: boolean; health?: boolean; restore?: boolean }) {
    const start = setup.indexOf("function installGpuOnnxRuntime()");
    const text = setup.slice(start, setup.indexOf("\ninstallGpuOnnxRuntime();", start));
    const calls: Call[] = [];
    const notices: Array<{ id: string; reason: string }> = [];
    const cleared: string[] = [];
    const logs: string[] = [];
    const pipOf = (args: string[]) => args.slice(args.indexOf("pip") + 1).join(" ");
    const run = (_exe: string, args: string[]) => {
      const line = pipOf(args);
      calls.push(line);
      if (failing.uninstallCpu && /^uninstall --yes .* onnxruntime$/.test(line))
        return { status: 1 };
      if (
        failing.restore &&
        /install --no-index --find-links .*previous.* onnxruntime==/.test(line)
      )
        return { status: 1 };
      return { status: 0 };
    };
    const capture = (_exe: string, args: string[]) =>
      args.some((arg) => arg.includes("CUDAExecutionProvider"))
        ? { status: failing.health ? 3 : 0 }
        : { status: 0, stdout: "cp313" };
    const body = `${text}\nreturn installGpuOnnxRuntime();`;
    new Function(
      "win",
      "thisPcPlan",
      "installedOnnxRuntimes",
      "log",
      "notice",
      "noticeCleared",
      "capture",
      "run",
      "python",
      "CUDA_LIBS_PROBE",
      "pinnedGpuOrtLines",
      "installedPlainOrtVersion",
      "root",
      "path",
      "fs",
      body,
    )(
      true,
      () => ({ required: [{ id: "onnxruntime", variant: "gpu", action: "install" }] }),
      () => ({ gpu: [], plain: true }),
      (line: string) => logs.push(line),
      (entry: { id: string; reason: string }) => notices.push(entry),
      (id: string) => cleared.push(id),
      capture,
      run,
      "python",
      ["-c", "cuda"],
      () => ({
        line: "onnxruntime-gpu==1.0 --hash=sha256:x",
        wheel: { name: "w.whl", bytes: 1024 ** 2 },
      }),
      () => "1.22.0",
      path.join(tmpdir(), "friday-ort-swap"),
      path,
      { rmSync() {}, mkdirSync() {}, writeFileSync() {} },
    );
    return { calls, notices, cleared, logs: logs.join("\n") };
  }

  it("stops when the CPU wheel cannot be removed: no GPU wheel is installed, the CPU build is put back, one notice", () => {
    const out = swap({ uninstallCpu: true });
    // The GPU wheel is installed from the "wheels" folder; that call never happens.
    expect(
      out.calls.filter((line) => /^install --no-index --find-links \S*wheels /.test(line)),
    ).toEqual([]);
    expect(
      out.calls.some((line) =>
        /install --no-index --find-links .*previous.* onnxruntime==1.22.0/.test(line),
      ),
    ).toBe(true);
    expect(out.notices.map((entry) => entry.id)).toEqual(["package:onnxruntime-gpu"]);
    expect(out.logs).toContain("the CPU build stays in use");
  });

  it("records a no-ONNX-Runtime notice and does not claim the CPU build stays when the restore fails too", () => {
    const out = swap({ health: true, restore: true });
    expect(out.notices.map((entry) => entry.id)).toEqual([
      "package:onnxruntime-gpu",
      "package:onnxruntime",
    ]);
    expect(out.notices[1]?.reason).toContain("no ONNX Runtime");
    expect(out.logs).not.toContain("the CPU build stays in use");
  });

  it("a healthy swap clears its notices and records nothing", () => {
    const out = swap({});
    expect(out.notices).toEqual([]);
    expect(out.cleared).toContain("package:onnxruntime-gpu");
  });
});

describe("setup-python notices point at real Install Manager rows only", () => {
  const ids = [...setup.matchAll(/installManagerId: ("[^"]+")/g)].map((match) => match[1]);

  it("names the speech model by its voice row and leaves the pip packages without a row empty", () => {
    expect(setup).toContain('installManagerId: "voice:faster-whisper-small"');
    expect(setup).not.toContain('"stt-small"');
    // `faster-whisper` is the large-v3 model row; the pip package of that name has no row.
    expect(ids).not.toContain('"faster-whisper"');
    const runtime = setup.slice(setup.indexOf('id: "package:voice-runtime"'));
    expect(runtime.slice(0, 260)).not.toContain("installManagerId");
  });
});
