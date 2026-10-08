import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  ownerAcceptanceSteps,
  speechSelfTest,
  speechTurnPlan,
} from "../../src/lib/friday/speech-core";
import {
  enrollCommand,
  forgetCommand,
  matchCommand,
  resetCommandTemplates,
} from "../../src/lib/friday/speech-command";
import { peakBin } from "../../src/lib/friday/speech-features";
import { sine } from "../../src/lib/friday/speech-dsp";
import { advanceFlow, freshMachine, wordError } from "../../src/lib/friday/speech-eval";
import { normalizeSpoken } from "../../src/lib/friday/speech-normalize";
import { chooseStt } from "../../src/lib/friday/speech-stt";
import { chooseTts, formantSynth, switchMidSentence } from "../../src/lib/friday/speech-tts";
import {
  adviseDependencies,
  ciReport,
  proposeDiff,
  registerSkill,
  scaffold,
} from "../../src/lib/friday/self/own-work";
import {
  bundledBytes,
  isolatedEnv,
  licenseNotices,
  toolchainManifest,
  validateManifest,
} from "../../src/lib/friday/toolchain-manifest";
import {
  failureCause,
  recoveryDelayMs,
  shouldRetryNow,
  voiceFailureLine,
} from "../../src/lib/friday/voice-recovery";

const require_ = createRequire(import.meta.url);
const pack = require_("../../electron/toolchain-pack.cjs") as {
  embedPthText: () => string;
  classifyBootstrapError: (text: string) => string;
  materialisePython: (input: Record<string, unknown>) => {
    ok: boolean;
    step: string;
    cause?: string;
  };
  installChain: (facts: Record<string, boolean>) => { ok: boolean; step: string };
  windowsLongPath: (file: string) => string;
};
const sapi = require_("../../electron/sapi-voice.cjs") as {
  sapiCommand: (text: string) => string[];
  sapiAvailable: (platform?: string) => boolean;
};
const whisperCpp = require_("../../electron/whisper-cpp.cjs") as {
  locateFrom: (roots: string[]) => { cli: string; model: string } | null;
  transcribeArgv: (cli: string, model: string, wav: string) => string[];
  parseWhisperText: (stdout: string) => string;
};
const voiceInstall = require_("../../electron/voice-install.cjs") as {
  bootModel: (input: { requested: string }) => { model: string; upgrade: string | null };
};

describe("wave 6 speech core and toolchain", () => {
  it("accepts the pinned manifest and keeps copyleft out of the installer", () => {
    const manifest = toolchainManifest();
    expect(validateManifest(manifest)).toEqual([]);
    expect(bundledBytes(manifest)).toBe(205084080);
    expect(bundledBytes(manifest)).toBeLessThanOrEqual(manifest.budgetBytes);
    const notices = licenseNotices(manifest);
    expect(notices).toContain("PSF-2.0");
    expect(notices).toContain("GPL-2.0");
    expect(
      readFileSync(path.join(process.cwd(), "resources/toolchain/LICENSE-NOTICES.txt"), "utf8"),
    ).toBe(notices);
    const yml = readFileSync(path.join(process.cwd(), "electron-builder.yml"), "utf8");
    expect(yml).toContain("resources/toolchain/**");
    expect(yml).toContain("resources/speech/**");
    expect(yml).toContain("oneClick: false");
    expect(yml).toContain("include: installer/build/installer.nsh");
  });

  it("builds an isolated env and a resumable python plan with fakes", () => {
    const before = process.env["PATH"];
    const env = isolatedEnv({
      root: os.tmpdir(),
      present: { "python-embed": path.join(os.tmpdir(), "py") },
    });
    expect(process.env["PATH"]).toBe(before);
    expect(env.FRIDAY_TOOLCHAIN).toBe("1");
    expect(pack.embedPthText()).toContain("import site");
    expect(pack.classifyBootstrapError("SmartScreen blocked the file")).toBe("antivirus");
    expect(pack.windowsLongPath(path.join(os.tmpdir(), "py")).includes("\0")).toBe(false);
    const offline = pack.materialisePython({
      root: path.join(os.tmpdir(), "no-net"),
      network: false,
    });
    expect(offline.step).toBe("need-network");
    const bad = pack.materialisePython({
      root: path.join(os.tmpdir(), "bad-hash"),
      network: true,
      download: () => ({ sha256: "00", bytes: 1, path: "x" }),
      extract: () => undefined,
    });
    expect(bad.cause).toBe("corrupt");
    expect(pack.installChain({ python: true, venv: true, pip: false }).step).toBe("pip");
  });

  it("names the speech failure and keeps one size plan", () => {
    expect(failureCause("model download paused")).toBe("downloading");
    expect(voiceFailureLine("permission", 0, "en")).not.toBe(voiceFailureLine("install", 0, "en"));
    expect(voiceFailureLine("busy", 1, "hi").toLowerCase()).not.toContain("python");
    expect(shouldRetryNow("fix-voice")).toBe(true);
    expect(shouldRetryNow("later")).toBe(false);
    expect(recoveryDelayMs(0)).toBe(0);
    expect(recoveryDelayMs(3)).toBe(8000);
    expect(voiceInstall.bootModel({ requested: "auto" }).model).toBe("base");
    const worker = readFileSync(path.join(process.cwd(), "kernel/stt.py"), "utf8");
    expect(worker).toContain('"local_files_only": True');
    expect(worker).not.toContain("def boot_model");
  });

  it("runs the offline speech path from capture through a spoken buffer", () => {
    const layers = speechSelfTest();
    expect(layers.every((layer) => layer.ok)).toBe(true);
    const frame = new Float32Array(32).fill(1);
    expect(peakBin(frame)).toBe(0);
    expect(normalizeSpoken("dhai ghante baad agle somvar")).toContain("two and a half");
    expect(normalizeSpoken("paune chaar")).toContain("quarter to four");
    expect(normalizeSpoken("um hello")).toBe("hello");
    const tone = sine(16000, 440, 0.1);
    resetCommandTemplates();
    enrollCommand("stop", tone);
    expect(matchCommand(tone).name).toBe("stop");
    expect(matchCommand(tone).approvesAction).toBe(false);
    forgetCommand("stop");
    expect(matchCommand(tone).name).toBeNull();
    const choice = chooseStt({
      whisperCpp: true,
      modelReady: true,
      fasterWhisper: true,
      moonshine: true,
      english: true,
      cloudAllowed: true,
      network: true,
      cli: "whisper-cli",
      model: "ggml-base.bin",
      wav: "turn.wav",
    });
    expect(choice.engine).toBe("whisper.cpp");
    expect(choice.downloads).toBe(false);
    expect(choice.localFilesOnly).toBe(true);
    expect(formantSynth("").length).toBe(0);
    expect(formantSynth("namaste").length).toBeGreaterThan(100);
    expect(
      chooseTts({ network: false, privacy: false, supertonicReady: false, windows: false }).quality,
    ).toBe("low-rule");
    expect(switchMidSentence("neural", false, false, true)).toBe("sapi");
    const quiet = freshMachine();
    const up = advanceFlow(quiet, "network-up");
    expect(up.network).toBe(true);
    expect(advanceFlow(up, "disk-full").phase).toBe("fail");
    expect(wordError("hello there", "hello there").wer).toBe(0);
    expect(speechTurnPlan("hello", "hi-IN")).toContain("not-approved");
    expect(ownerAcceptanceSteps().length).toBe(9);
    const command = sapi.sapiCommand('say "hi"');
    expect(command.join(" ")).toContain("System.Speech");
    expect(sapi.sapiAvailable("linux")).toBe(false);
    const missing = whisperCpp.locateFrom([path.join(os.tmpdir(), "no-whisper-pack")]);
    expect(missing).toBeNull();
    const root = path.join(os.tmpdir(), "whisper-pack");
    const cli = path.join(root, "Release", "whisper-cli.exe");
    const model = path.join(root, "ggml-base.bin");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, "");
    fs.writeFileSync(model, "");
    const found = whisperCpp.locateFrom([root]);
    expect(found?.cli).toBe(cli);
    expect(whisperCpp.transcribeArgv(cli, model, "turn.wav")).toEqual([
      cli,
      "-m",
      model,
      "-f",
      "turn.wav",
      "--no-prints",
    ]);
    expect(whisperCpp.parseWhisperText("[00:00.000 --> 00:01.000]  hello there\n")).toBe(
      "hello there",
    );
    const worker = readFileSync(path.join(process.cwd(), "electron/stt.cjs"), "utf8");
    expect(worker).toContain('engine: "whisper.cpp"');
    expect(worker).toContain("needs a wav capture");
  });

  it("refuses a self-edit of protected files and blocks a skill whose tests fail", () => {
    const refused = proposeDiff({
      paths: ["AGENTS.md"],
      diff: "rewrite",
      level: "full",
    });
    expect(refused.allow).toBe("refuse");
    expect(refused.merges).toBe(false);
    expect(refused.pushesMain).toBe(false);
    expect(registerSkill({ name: "demo", testsPass: false, level: "full" }).reason).toBe(
      "tests failed",
    );
    expect(scaffold("python").body).toContain("print");
    expect(scaffold("cpp").file).toBe("main.cpp");
    expect(adviseDependencies(["http-cache-semantics"]).length).toBe(1);
    expect(ciReport([{ name: "lint", ok: false }]).status).toBe("BLOCK");
    const cases = JSON.parse(
      readFileSync(path.join(process.cwd(), "resources/speech/wer-cases.json"), "utf8"),
    ) as Array<{
      heard: string;
      expected: string;
    }>;
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(cases.every((row) => wordError(row.heard, row.expected).wer === 0)).toBe(true);
  });
});
