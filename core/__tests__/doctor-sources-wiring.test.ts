/**
 * The Doctor's source, language, Tesseract and onnxruntime rows, run for real where the OS allows (a fake `tesseract`
 * on PATH, the real scripts as child processes, no network: reachability probing is switched off) and pinned in the
 * source where it cannot be run here (the Windows branches). `npm run doctor` keeps its ten numbered steps and its
 * closing DOCTOR PASS / DOCTOR FAIL lines.
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const posix = process.platform !== "win32";

let bin = "";
const fakeTesseract = (langs: string[]) => {
  const list = `List of available languages in "/x/tessdata/" (${langs.length}):\\n${langs.join("\\n")}\\n`;
  fs.writeFileSync(
    path.join(bin, "tesseract"),
    `${"#!"}/bin/sh\nif [ "$1" = "--list-langs" ]; then printf '${list}'; else echo "tesseract 5.4.0"; fi\n`,
    { mode: 0o755 },
  );
};
const environment = () =>
  spawnSync(process.execPath, [path.join(root, "scripts/check-environment.cjs")], {
    cwd: root,
    encoding: "utf8",
    timeout: 170000,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      // A temp home: a Doctor run must never record this checkout as the FRIDAY home in the real registry.
      FRIDAY_WORKSPACE_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), "friday-home-")),
      FRIDAY_REACH_PROBE: "0",
      FRIDAY_PREFETCH: "1",
      CI: "",
      GITHUB_ACTIONS: "",
    },
  });

beforeAll(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "friday-tess-"));
});
afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

describe.skipIf(!posix)("check-environment: Tesseract languages", () => {
  it("requires nothing extra when eng and hin are installed: both rows pass", () => {
    fakeTesseract(["eng", "hin", "osd"]);
    const out = `${environment().stdout}`;
    expect(out).toMatch(/PASS\s+Tesseract language: English \(eng\)/);
    expect(out).toMatch(/PASS\s+Tesseract language pack: Hindi \(hin\)\s+hin/);
  }, 180_000);

  it("a missing Hindi pack is a SKIPPED note (never MISSING) and says what it costs", () => {
    fakeTesseract(["eng", "osd"]);
    const out = `${environment().stdout}`;
    expect(out).toMatch(/PASS\s+Tesseract language: English \(eng\)/);
    expect(out).toMatch(/SKIPPED\s+Tesseract language pack: Hindi \(hin\)\s+not installed/);
    expect(out).not.toMatch(/MISSING\s+Tesseract language pack: Hindi/);
    expect(out).toContain("skipped: the Hindi pack is a language pack");
  }, 180_000);

  it("without eng the English row is not a pass and names what was found", () => {
    fakeTesseract(["osd"]);
    const out = `${environment().stdout}`;
    expect(out).not.toMatch(/PASS\s+Tesseract language: English/);
    expect(out).toMatch(/(SKIPPED|MISSING)\s+Tesseract language: English \(eng\)\s+not installed/);
    expect(out).toMatch(/Tesseract language: English \(eng\)\s+not installed \(found: osd\)/);
  }, 180_000);
});

describe.skipIf(!posix)("check-environment: sources and the onnxruntime row", () => {
  it("names the sources of the model, runtime and tool rows, in order, 'not checked' when probing is off", () => {
    fakeTesseract(["eng"]);
    const out = `${environment().stdout}`;
    expect(out).toMatch(/sources: huggingface\.co[^\n]*\(not checked: probe off\)/);
    expect(out).toMatch(
      /sources: cdn\.winget\.microsoft\.com > github\.com \(not checked: probe off\)/,
    );
    expect(out).toMatch(/sources: download\.moonshine\.ai \(not checked: probe off\)/);
    // The package and tool indexes are named once for the group, not under every row.
    expect(out).toMatch(
      /^package index: pypi\.org > files\.pythonhosted\.org \(not checked: probe off\)$/m,
    );
  }, 180_000);

  it("has an information row for the onnxruntime build that never fails the run", () => {
    fakeTesseract(["eng"]);
    const out = `${environment().stdout}`;
    expect(out).toMatch(/PASS\s+ONNX Runtime build \(cpu, gpu, directml\)/);
    expect(out).not.toMatch(/(MISSING|SKIPPED)\s+ONNX Runtime build/);
    expect(out).toMatch(
      /note:\s+setup installs the cpu build|note:\s+this PC's plan could not be read/,
    );
  }, 180_000);
});

describe("the wiring that only runs on Windows is in the source", () => {
  const src = read("scripts/check-environment.cjs");

  it("ends with exitCode, not process.exit: a long table must not be cut off in a pipe", () => {
    expect(src).not.toMatch(/process\.exit\(/);
    // One verdict (probes.environmentExitCode): 1 for a blocker only, or a notice under FRIDAY_SETUP_STRICT=1.
    expect(src).toContain("probes.environmentExitCode(checks, { strict, noticesFail })");
    expect(src.match(/process\.exitCode = verdict;/g)).toHaveLength(3);
    expect(src).not.toContain("process.exitCode = 1;");
  });

  it("asks tesseract for its languages and requires eng, with hin as a language pack", () => {
    expect(src).toContain('["--list-langs"]');
    expect(src).toMatch(/name: "Tesseract language: English \(eng\)",\s+required: toolsRequired/);
    expect(src).toMatch(/name: "Tesseract language pack: Hindi \(hin\)",\s+required: false/);
  });

  it("checks the onnxruntime build against the plan's onnxruntime row", () => {
    expect(src).toContain('setupPlanData?.required.find((row) => row.id === "onnxruntime")');
    expect(src).toContain("probes.probeOrt(pythonExecutable)");
  });

  it("shows the three optional voice models by name, each required only when this PC's plan carries it", () => {
    for (const id of ["hindi-light-tts", "hinglish-ear", "hindi-fallback-ear"])
      expect(src).toContain(`"${id}": "Voice model:`);
    expect(src).toMatch(/required: planned && toolsRequired && !job\.optional/);
  });

  it("Moonshine is skipped on this PC only when switched off or without Python, otherwise required", () => {
    expect(src).toContain("required: toolsRequired && !moonshineWhy");
    expect(src).toContain("FRIDAY_PREFETCH_MOONSHINE");
  });

  it("every download row carries hosts: models, Ollama, FFmpeg, Tesseract, CUDA libraries, packages, toolkit", () => {
    for (const needle of [
      "hosts: probes.jobHosts(job)",
      'hosts: jobHostsOf("ollama-setup")',
      'hosts: toolHostsOf("FFmpeg")',
      'hosts: toolHostsOf("Tesseract OCR")',
      "hosts: toolHostsOf(entry.id)",
      "hosts: probes.PYPI_HOSTS",
      'hosts: ["download.moonshine.ai"]',
    ])
      expect(src, needle).toContain(needle);
  });
});

describe("Doctor keeps its shape and shares one reachability cache for the run", () => {
  const doctor = require_("../../scripts/doctor.cjs") as {
    STEPS: { name: string }[];
    runDoctor: (steps: unknown[], log: (line: string) => void) => { ok: boolean };
  };

  it("has ten numbered steps and prints DOCTOR PASS / DOCTOR FAIL", () => {
    expect(doctor.STEPS).toHaveLength(10);
    const lines: string[] = [];
    doctor.runDoctor(
      [
        { name: "one", run: () => ({ status: 0 }) },
        { name: "two", run: () => ({ status: 3 }) },
      ],
      (line) => lines.push(line),
    );
    expect(lines).toContain("[friday] doctor 1/2: one");
    expect(
      lines.some((line) => line.startsWith("DOCTOR FAIL - 1 step(s) did not finish: two")),
    ).toBe(true);
    const passed: string[] = [];
    doctor.runDoctor([{ name: "one", run: () => ({ status: 0 }) }], (line) => passed.push(line));
    expect(passed).toContain("DOCTOR PASS - FRIDAY is ready to test, build and run.");
  });

  it("sets FRIDAY_REACH_CACHE for the run and removes the file afterwards", () => {
    const src = read("scripts/doctor.cjs");
    expect(src).toContain("process.env.FRIDAY_REACH_CACHE = reachCache");
    expect(src).toMatch(
      /finally \{\s+if \(reachCache\) fs\.rmSync\(reachCache, \{ force: true \}\);/,
    );
  });

  it("voice-stack gets the plan, the venv python and the reachability probe from its command line", () => {
    const src = read("scripts/voice-stack.cjs");
    expect(src).toContain('require("./prefetch-models.cjs").readPlanSync(process.env)');
    expect(src).toContain("probes.venvPython(process.env)");
    expect(src).toContain("probes.reachSync(hosts)");
  });
});

describe.skipIf(!posix)("voice-stack as a command prints the language rows", () => {
  it("--root names the language layer with one row per language and role", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-lang-cli-"));
    try {
      const run = spawnSync(
        process.execPath,
        [path.join(root, "scripts/voice-stack.cjs"), "--root", dir],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 170000,
          env: {
            ...process.env,
            FRIDAY_REACH_PROBE: "0",
            FRIDAY_PREFETCH: "1",
            CI: "",
            GITHUB_ACTIONS: "",
          },
        },
      );
      const out = `${run.stdout}`;
      expect(out).toContain("[language]");
      for (const name of [
        "hindi ears (STT)",
        "english ears (STT)",
        "hinglish ears (STT)",
        "hindi light TTS",
        "hindi fallback ear",
      ])
        expect(out, name).toContain(name);
      expect(out).toMatch(/not checked: probe off/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
