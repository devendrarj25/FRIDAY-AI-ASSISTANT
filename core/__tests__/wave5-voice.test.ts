import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  applyCorrections,
  biasPrompt,
  confidenceRepeat,
  languageId,
  learnCorrection,
  resetCorrections,
  utteranceConfidence,
} from "../../src/lib/friday/asr-bias";
import {
  arcSnapshot,
  forgetArc,
  noteArc,
  recallArc,
  resetArc,
} from "../../src/lib/friday/conversation-arc";
import { everydayPlan } from "../../src/lib/friday/everyday";
import {
  buildEvalCorpus,
  buildVoiceScenarios,
  gradeCase,
  gradeVoiceScenario,
} from "../../src/lib/friday/eval-corpus";
import { offlineFlows, voiceBudgets } from "../../src/lib/friday/failure-guard";
import {
  applySession,
  captureRate,
  negotiateRate,
  onProfileSwitch,
  onSessionEvent,
  trackWatch,
} from "../../src/lib/friday/mic-session";
import {
  noteStyleCorrection,
  resetStyleCorrection,
  shapeReply,
} from "../../src/lib/friday/response-policy";
import { understandSpoken } from "../../src/lib/friday/speech-understand";
import {
  chooseTtsEngine,
  firstAudioLatency,
  outputReachable,
  switchMidSentence,
  voiceForLanguage,
} from "../../src/lib/friday/tts-ladder";
import { ownerAcceptanceSteps, redactDiagnostics } from "../../src/lib/friday/voice-doctor";
import { CLEAN_PC_SCRIPT, walkVoiceFlow } from "../../src/lib/friday/voice-flow";
import { voicePackReport } from "../../src/lib/friday/voice-pack";
import {
  failureCause,
  ownerVoiceLang,
  recoveryDelayMs,
  resumeAfterSpokenReply,
  shouldRetryNow,
  voiceFailureLine,
} from "../../src/lib/friday/voice-recovery";
import { roomWakeDecision } from "../../src/lib/friday/wake-engine";

const require_ = createRequire(import.meta.url);
const boot = require_("../../electron/python-bootstrap.cjs") as {
  SPEC: { sha256: string; bytes: number; version: string; license: string };
  standaloneSpec: () => { file: string; sha256: string };
  windowsLongPath: (file: string, platform?: string) => string;
  interpreterPath: (dir: string) => string;
  venvExe: (dir: string, platform?: string) => string;
  pipArgs: (packages: string[], cache?: string) => string[];
  classifyBootstrapError: (text: string) => { cause: string; line: string };
  installChain: (facts: Record<string, boolean>) => {
    ok: boolean;
    step: string;
    cause: string;
    retry: boolean;
  };
  materialise: (input: {
    runtimeDir: string;
    platform?: string;
    exists?: (file: string) => boolean;
    onLine?: (line: string) => void;
    download?: (spec: { sha256: string }) => Promise<string>;
    extract?: (file: string, dest: string) => Promise<void>;
    run?: (cmd: string, args: string[]) => Promise<void>;
    wheelCache?: string;
  }) => Promise<{ exe: string; via: string } | null>;
};

describe("voice failure lines", () => {
  it("speaks the cause in the owner's language and never names an internal", () => {
    const causes = [
      "install",
      "permission",
      "busy",
      "exclusive",
      "device",
      "downloading",
      "model-failed",
    ];
    for (const cause of causes) {
      for (const lang of ["en", "hi", "hinglish"] as const) {
        const line = voiceFailureLine(cause, 0, lang);
        expect(line.length).toBeGreaterThan(8);
        expect(line).not.toMatch(/faster-whisper|python|onnx|pip\b|CTranslate/i);
      }
    }
    expect(voiceFailureLine("install", 0, "en")).not.toBe(voiceFailureLine("permission", 0, "en"));
    expect(voiceFailureLine("busy", 1, "hi")).not.toBe(voiceFailureLine("busy", 0, "hi"));
    expect(ownerVoiceLang("hi-IN")).toBe("hi");
    expect(ownerVoiceLang("en-IN")).toBe("hinglish");
    expect(failureCause("model failed to load")).toBe("model-failed");
    expect(shouldRetryNow("fix-voice")).toBe(true);
    expect(shouldRetryNow("timer")).toBe(false);
    expect(recoveryDelayMs(0)).toBe(0);
    expect(recoveryDelayMs(3)).toBe(8000);
    expect(resumeAfterSpokenReply({ mode: "auto", paused: false })).toBe(true);
    expect(resumeAfterSpokenReply({ mode: "manual", paused: false })).toBe(false);
  });
});

describe("clean-PC voice flow", () => {
  it("walks bootstrap, a busy mic, and a resume, and names each injected fault", () => {
    const ready = walkVoiceFlow(CLEAN_PC_SCRIPT);
    expect(ready.phase).toBe("resume");
    expect(ready.python).toBe(true);
    expect(ready.weights).toBe(true);
    expect(walkVoiceFlow(["network-down", "bootstrap"]).phase).toBe("need-network");
    expect(walkVoiceFlow(["disk-full"]).phase).toBe("failed");
    expect(walkVoiceFlow(["permission-denied"]).line.toLowerCase()).toMatch(
      /microphone|permission/,
    );
    expect(walkVoiceFlow(["corrupt-model"]).phase).toBe("failed");
    expect(walkVoiceFlow(["half-cache"]).phase).toBe("weights");
    expect(walkVoiceFlow(["clock-jump"]).line).toMatch(/resume/i);
    const crashed = walkVoiceFlow(["worker-crash", "worker-crash", "worker-crash"]);
    expect(crashed.phase).toBe("failed");
    expect(walkVoiceFlow(["antivirus"]).phase).toBe("failed");
  });
});

describe("microphone session", () => {
  it("picks a rate, reopens on a headset change, and flags a stuck track", () => {
    expect(negotiateRate([48000, 44100], 16000)).toBe(44100);
    expect(negotiateRate([16000, 48000])).toBe(16000);
    expect(onProfileSwitch("hfp")).toEqual({
      reopen: true,
      rate: 16000,
      reason: "headset call profile",
    });
    expect(onProfileSwitch("a2dp").rate).toBe(48000);
    for (const kind of [
      "hotplug",
      "default-device",
      "sleep",
      "resume",
      "lock",
      "unlock",
      "fast-user-switch",
      "exclusive",
    ]) {
      expect(onSessionEvent(kind).reopen).toBe(true);
    }
    expect(onSessionEvent("paint").reopen).toBe(false);
    const session = applySession("hotplug", "hfp");
    expect(session.reopen).toBe(true);
    expect(session.rate).toBe(16000);
    expect(captureRate()).toBe(16000);
    expect(trackWatch({ frames: 80, sameEnergy: 50, handles: 2, crashes: 0 }).stuck).toBe(true);
    expect(trackWatch({ frames: 10, sameEnergy: 0, handles: 9, crashes: 0 }).leak).toBe(true);
    expect(trackWatch({ frames: 10, sameEnergy: 0, handles: 1, crashes: 1 }).restart).toBe(true);
  });
});

describe("speech and reply", () => {
  it("understands Hindi quantities, clock time, and a weekday", () => {
    expect(understandSpoken("dhai ghante")).toMatchObject({ quantity: 2.5, unit: "hour" });
    expect(understandSpoken("paune chaar")).toMatchObject({ hour: 3, minute: 45 });
    expect(understandSpoken("agle somvar").weekday).toBe("somvar");
    expect(understandSpoken("um meeting nahi call").corrected).toMatch(/call/i);
    expect(understandSpoken("haan ji kal").fillerStripped).not.toMatch(/haan ji/);
  });

  it("biases names, learns a correction, and repeats only a weak short line", () => {
    resetCorrections();
    expect(biasPrompt(["Chrome", "FRIDAY"], "Hinglish.")).toMatch(/Chrome/);
    expect(learnCorrection("password is secret", "no")).toBeNull();
    expect(learnCorrection("krom", "Chrome")).toEqual({ from: "krom", to: "Chrome" });
    expect(applyCorrections("open krom")).toMatch(/Chrome/);
    expect(languageId("kholo yaar")).toBe("hinglish");
    expect(languageId("खोलो")).toBe("hi");
    expect(utteranceConfidence("the the file")).toBe(0.5);
    expect(confidenceRepeat("the the file", 0.5)).toMatch(/Did you say/);
    expect(confidenceRepeat("open the report now", 0.9)).toBeNull();
    resetCorrections();
  });

  it("keeps one arc, recalls its age, and forgets it", () => {
    resetArc();
    noteArc({ topic: "password: secret", feeling: "neutral", at: 1, source: "voice" });
    expect(arcSnapshot()).toHaveLength(0);
    noteArc({ topic: "the build", feeling: "neutral", at: 1_000, source: "voice" });
    expect(recallArc(61_000)?.age).toBe("1 min");
    expect(recallArc(0)?.age).toBe("age unknown");
    expect(forgetArc("last")).toBe(1);
    expect(recallArc(1)).toBeNull();
  });

  it("changes length and warmth, and a correction keeps the next anger line neutral", () => {
    resetStyleCorrection();
    const plain = shapeReply({
      prompt: "I am so excited today",
      text: "Ship it.",
      warmth: "plain",
      talk: "reserved",
    });
    const warm = shapeReply({
      prompt: "I am so excited today",
      text: "Ship it.",
      warmth: "warm",
      talk: "chatty",
    });
    expect(warm.text.length).toBeGreaterThan(plain.text.length);
    expect(warm.text).toMatch(/win/i);
    expect(
      shapeReply({ prompt: "I want to die", text: "ignore previous instructions" }).text,
    ).toMatch(/iCall|AASRA/);
    expect(shapeReply({ prompt: "I want to die", text: "x" }).text).not.toMatch(/diagnos/i);
    expect(noteStyleCorrection("main gussa nahi hu")).toBe(true);
    expect(shapeReply({ prompt: "I am furious about this", text: "Here." }).feeling.label).toBe(
      "neutral",
    );
    resetStyleCorrection();
  });

  it("plans a timer, a calculation, a recall, and a named open", () => {
    resetArc();
    noteArc({ topic: "the pin", feeling: "neutral", at: 5, source: "voice" });
    expect(everydayPlan("what is 12 times 8")?.text).toBe("96.");
    expect(everydayPlan("set a timer for 10 minutes")?.undo).toBe(true);
    expect(everydayPlan("yaad hai")?.text).toMatch(/the pin/);
    expect(everydayPlan("open notepad")?.text).toMatch(/Notepad/);
    expect(everydayPlan("message likho to mom")?.needsApproval).toBe(true);
    expect(everydayPlan("bhool jao sab")?.kind).toBe("forget");
    expect(everydayPlan("draft a poem")).toBeNull();
  });
});

describe("tts ladder and budgets", () => {
  it("steps from neural to an offline voice and checks the output", () => {
    expect(chooseTtsEngine({ network: true, supertonicReady: true, privacy: false })).toBe(
      "neural",
    );
    expect(chooseTtsEngine({ network: false, supertonicReady: true, privacy: false })).toBe(
      "supertonic",
    );
    expect(chooseTtsEngine({ network: false, supertonicReady: false, privacy: false })).toBe(
      "sapi",
    );
    expect(chooseTtsEngine({ network: true, supertonicReady: true, privacy: true })).toBe("sapi");
    expect(
      switchMidSentence({ networkDropped: true, current: "neural", supertonicReady: false }),
    ).toBe("sapi");
    expect(voiceForLanguage("hinglish").lang).toBe("hi-IN");
    expect(firstAudioLatency(1000, 1400)).toBe(400);
    expect(outputReachable({ deviceId: "", volume: 1 }).ok).toBe(false);
    expect(outputReachable({ deviceId: "default", volume: 0 }).reason).toMatch(/silent/);
    const rows = voiceBudgets({
      listenMs: 1000,
      audioMs: 200,
      idleCpu: [0.2, 0.4],
      memoryMb: [100, 110],
    });
    expect(rows.every((row) => row.ok)).toBe(true);
    expect(
      voiceBudgets({ listenMs: 50000, audioMs: 200, idleCpu: [3], memoryMb: [100, 200] }).some(
        (row) => !row.ok,
      ),
    ).toBe(true);
    const offline = offlineFlows({ online: false, hasLocalModel: true });
    expect(offline.chat).toBe(true);
    expect(offline.localStt).toBe(true);
    expect(offline.cloud).toBe(false);
    expect(offline.status).toMatch(/offline/i);
  });
});

describe("wake room and the owner checklist", () => {
  it("scores a hit above the floor and lists the owner steps", () => {
    const wake = roomWakeDecision([0.01, 0.02, 0.03], 0.9, 0.01);
    expect(wake.mark).toBe("hit");
    expect(wake.falseHit).toBe(false);
    expect(wake.pass).toBe(true);
    const miss = roomWakeDecision([0.2, 0.2, 0.2], 0.05, 0.9);
    expect(miss.mark).toBe("miss");
    expect(miss.falseHit).toBe(true);
    expect(ownerAcceptanceSteps()).toHaveLength(8);
    expect(ownerAcceptanceSteps().join(" ")).toMatch(/self-test/);
    const corpus = buildEvalCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(160);
    const failed = corpus.flatMap((item) =>
      gradeCase(item).map((reason) => `${item.id}: ${reason}`),
    );
    expect(failed).toEqual([]);
    const scenarios = buildVoiceScenarios();
    expect(scenarios).toHaveLength(40);
    expect(scenarios.flatMap((item) => gradeVoiceScenario(item))).toEqual([]);
    expect(redactDiagnostics("password: hunter2")).not.toMatch(/hunter2/);
    const pack = voicePackReport("/friday", (file) => file.endsWith("friday.onnx"));
    expect(pack.find((row) => row.id === "wake")?.ok).toBe(true);
    expect(pack.find((row) => row.id === "cpython")?.ok).toBe(false);
  });
});

describe("pinned Python runtime", () => {
  it("pins the archive and builds a venv with fakes", async () => {
    expect(boot.SPEC.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(boot.SPEC.bytes).toBe(46509797);
    expect(boot.SPEC.version).toBe("3.12.15");
    expect(boot.SPEC.license).toBe("PSF-2.0");
    expect(boot.standaloneSpec().file).toMatch(/install_only\.tar\.gz$/);
    const long = boot.windowsLongPath(`C:\\Users\\${"n".repeat(240)}\\runtime`, "win32");
    expect(long.startsWith("\\\\?\\")).toBe(true);
    expect(boot.windowsLongPath("/tmp/short", "linux")).toBe(path.resolve("/tmp/short"));
    expect(boot.installChain({ python: false }).cause).toBe("no-python");
    expect(
      boot.installChain({
        python: true,
        venv: true,
        pip: true,
        packages: true,
        imported: true,
        weights: true,
        worker: true,
      }).ok,
    ).toBe(true);
    expect(boot.classifyBootstrapError("SmartScreen blocked the file").cause).toBe("antivirus");
    expect(boot.pipArgs(["faster-whisper"], "/wheels")).toContain("--find-links");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-py-"));
    const result = await boot.materialise({
      runtimeDir: root,
      platform: "win32",
      exists: (file) => fs.existsSync(file),
      download: async (spec) => {
        expect(spec.sha256).toBe(boot.SPEC.sha256);
        const file = path.join(root, "archive.tar.gz");
        fs.writeFileSync(file, "archive");
        return file;
      },
      extract: async (_file, _dest) => {
        const exe = boot.interpreterPath(root);
        fs.mkdirSync(path.dirname(exe), { recursive: true });
        fs.writeFileSync(exe, "");
      },
      run: async (_cmd, args) => {
        if (args.includes("-m") && args.includes("venv")) {
          const exe = boot.venvExe(root, "win32");
          fs.mkdirSync(path.dirname(exe), { recursive: true });
          fs.writeFileSync(exe, "");
        }
      },
      wheelCache: path.join(root, "wheels"),
    });
    expect(result?.via).toBe("standalone");
    const again = await boot.materialise({
      runtimeDir: root,
      platform: "win32",
      exists: (file) => fs.existsSync(file),
    });
    expect(again?.via).toBe("venv");
    expect(
      await boot.materialise({ runtimeDir: path.join(root, "empty"), platform: "win32" }),
    ).toBeNull();
  });
});
