/**
 * Round 6: installed models are used before anything is fetched, a fetch shows real progress, Fix voice
 * checks and mends her own voice, and her short replies do not repeat. Nothing here touches a microphone,
 * a speaker, the network or the date.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import {
  chooseFresh,
  lastSaid,
  resetAntiRepeat,
  vary,
} from "../../src/lib/friday/brain/anti-repeat";
import { resetSocialLines, socialLine } from "../../src/lib/friday/conversation-style";
import { describeDownload, formatEta } from "../../src/lib/friday/voice-download";
import {
  diagnoseVoice,
  problemLine,
  type SelfCheckInput,
} from "../../src/lib/friday/voice-selfcheck";

const require = createRequire(import.meta.url);
const weights = require("../../electron/voice-weights.cjs") as {
  installedSizes: (root: string, exists: (file: string) => boolean) => string[];
  nearestInstalled: (wanted: string, installed: string[]) => string;
};

const read = (file: string) => readFileSync(file, "utf8");

describe("speech sizes on disk are used before anything is fetched", () => {
  const onDisk = (sizes: string[]) => (file: string) =>
    sizes.some(
      (size) =>
        file.replace(/\\/g, "/").includes(`/cache/stt/${size}/`) &&
        /(config\.json|model\.bin)$/.test(file),
    );

  it("lists the sizes whose weights are really there, smallest first", () => {
    expect(weights.installedSizes("/root", onDisk(["small", "base"]))).toEqual(["base", "small"]);
    expect(weights.installedSizes("", onDisk(["small"]))).toEqual([]);
    expect(weights.installedSizes("/root", () => false)).toEqual([]);
  });

  it("keeps the size asked for when it is installed", () => {
    expect(weights.nearestInstalled("medium", ["base", "small", "medium"])).toBe("medium");
  });

  it("listens with the nearest smaller size while a missing one is fetched", () => {
    expect(weights.nearestInstalled("large-v3", ["base", "small"])).toBe("small");
    expect(weights.nearestInstalled("medium", ["tiny", "base"])).toBe("base");
  });

  it("falls to the smallest larger size when nothing smaller is installed, and to nothing when empty", () => {
    expect(weights.nearestInstalled("tiny", ["small", "medium"])).toBe("small");
    expect(weights.nearestInstalled("small", [])).toBe("");
  });

  it("is wired so a missing size never blocks listening while another is on disk", () => {
    const stt = read("electron/stt.cjs");
    expect(stt).toContain("async function chooseWeights(wanted, onEvent)");
    expect(stt).toContain("const prepared = await chooseWeights(wanted, onEvent);");
    expect(stt).toContain("void fetchInBackground(wanted);");
    expect(stt).toContain("FETCH_RETRY_MS");
    expect(stt).toContain(
      'voiceInstall.bootModel({ requested: explicit || "auto", ...cachedSizes() })',
    );
    const verify = read("electron/voice-verify.cjs");
    expect(verify).toContain("weights.nearestInstalled(size, onDisk)");
  });

  it("does not run pip when the speech packages are already installed and in range", () => {
    const stt = read("electron/stt.cjs");
    expect(stt).toContain("const found = await probePackages(py);");
    expect(stt).toContain("const needed = options.upgrade || !found.satisfied;");
    expect(stt).toContain("https://pypi.org/pypi/faster-whisper/json");
    expect(stt).toContain("skippedInstall: !needed");
  });

  it("sends every speech download through one progress sink that the window listens to", () => {
    const main = read("electron/main.cjs");
    expect(main).toContain("stt.setProgressSink(");
    expect(main).toContain('send("voice:stt-progress"');
    expect(read("electron/preload.cjs")).toContain(
      'ipcRenderer.invoke("voice:stt-install", options)',
    );
  });
});

describe("the download bar tells what is true", () => {
  it("shows size, speed and time left when they are known", () => {
    const row = describeDownload({
      stage: "download",
      model: "medium",
      status: "Downloading speech model medium",
      progress: 41.6,
      gbDone: 0.64,
      gbTotal: 1.53,
      speedMbps: 12.4,
      etaSeconds: 130,
    });
    expect(row).toMatchObject({ stage: "download", model: "medium", percent: 42 });
    expect(row?.detail).toBe("0.64 of 1.53 GB · 12 MB/s · about 2 min left");
  });

  it("shows nothing it was not given", () => {
    const row = describeDownload({ status: "Checking the speech engine" });
    expect(row).toMatchObject({ percent: null, detail: "" });
    expect(describeDownload({ status: "  " })).toBeNull();
    expect(describeDownload(null)).toBeNull();
  });

  it("keeps the percent in range and marks a finished model as 100", () => {
    expect(describeDownload({ status: "x", progress: 140 })?.percent).toBe(100);
    expect(describeDownload({ status: "x", progress: -5 })?.percent).toBe(0);
    expect(describeDownload({ stage: "ready", status: "ready", progress: 100 })?.percent).toBe(100);
    expect(formatEta(20)).toBe("under a minute left");
    expect(formatEta(0)).toBe("");
  });

  it("names the failure and a newer release", () => {
    expect(
      describeDownload({ stage: "failed", status: "did not download", error: "offline" })?.detail,
    ).toBe("offline");
    expect(
      describeDownload({
        stage: "check",
        status: "installed",
        updateAvailable: true,
        latest: "1.3.0",
      })?.detail,
    ).toBe("newer release 1.3.0 is available");
  });

  it("is drawn on the Auto bar from the assistant state", () => {
    expect(read("src/components/friday/AutoMode.tsx")).toContain(
      "<VoiceDownloadBar download={voice.download} />",
    );
    expect(read("src/components/friday/VoiceDownloadBar.tsx")).toContain('role="progressbar"');
  });
});

describe("Fix voice checks her own voice and mends what is broken", () => {
  const good: SelfCheckInput = {
    micReady: true,
    micError: null,
    sttReady: true,
    sttModel: "small",
    sttError: null,
    ttsEngine: "supertonic",
    ttsError: null,
    wakeReady: false,
    wakeEngine: "transcript",
    probes: [{ id: "stt-import", label: "import faster_whisper", ok: true, detail: "ok" }],
  };

  it("finds nothing wrong when everything works, and the wake fallback is not a fault", () => {
    const result = diagnoseVoice(good);
    expect(result.ok).toBe(true);
    expect(result.faults).toEqual([]);
  });

  it("maps each broken part to the fault the heal policy understands, without repeats", () => {
    const result = diagnoseVoice({
      ...good,
      micReady: false,
      micError: "no working microphone",
      sttReady: false,
      sttError: "speech model not verified",
      ttsError: "no speech engine could speak the reply",
      probes: [
        {
          id: "stt-model",
          label: "speech model loads",
          ok: false,
          detail: "speech weights are not on disk",
        },
        { id: "tts", label: "optional voice", ok: false, optional: true, detail: "not installed" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.faults).toEqual(["mic-no-device", "stt-model-missing", "tts-engine-fail"]);
    expect(result.parts.filter((part) => part.id === "engine")).toHaveLength(1);
  });

  it("treats a voice that has not spoken yet as unknown, not broken", () => {
    expect(diagnoseVoice({ ...good, ttsEngine: null }).ok).toBe(true);
    expect(diagnoseVoice({ ...good, ttsEngine: "none" }).ok).toBe(false);
  });

  it("says what is wrong in the owner's language, from the parts that failed", () => {
    const result = diagnoseVoice({ ...good, micReady: false, micError: "no working microphone" });
    expect(problemLine(result, "en", { fixing: true, chance: () => 0 })).toMatch(/the microphone/);
    expect(problemLine(result, "hinglish", { fixing: true, chance: () => 0 })).toMatch(/mic/);
    expect(problemLine(result, "hi", { fixing: true, chance: () => 0 })).toMatch(/माइक/);
    expect(problemLine(result, "en", { fixing: false, chance: () => 0 })).toMatch(
      /can't mend it alone/,
    );
  });

  it("does not use the same wording twice in a row", () => {
    const result = diagnoseVoice({ ...good, ttsError: "no speech engine could speak the reply" });
    const lines = Array.from({ length: 8 }, () => problemLine(result, "en", { fixing: true }));
    for (let i = 1; i < lines.length; i += 1) expect(lines[i]).not.toBe(lines[i - 1]);
    expect(new Set(lines).size).toBeGreaterThanOrEqual(3);
  });

  it("is wired: the button runs the check, Auto runs it once silently, leaving Auto clears it", () => {
    const mode = read("src/lib/friday/assistant-mode.ts");
    expect(mode).toContain("void this.selfCheckVoice(true);");
    expect(mode).toContain("void this.selfCheckVoice(false);");
    expect(mode).toContain("await this.verifyVoiceRuntime({ heal: false })");
    expect(mode).toContain("clearTimeout(this.autoCheckTimer)");
  });
});

describe("short replies do not repeat", () => {
  beforeEach(() => {
    resetAntiRepeat();
    resetSocialLines();
  });

  it("never gives the same line twice in a row, in any situation", () => {
    for (const bucket of [
      "wake",
      "cancelled",
      "expired",
      "checking",
      "allGood",
      "ack",
      "done",
    ] as const) {
      let last = "";
      for (let i = 0; i < 30; i += 1) {
        const line = vary(bucket);
        expect(line).not.toBe(last);
        last = line;
      }
    }
  });

  it("follows the owner's language", () => {
    expect(vary("wake", { register: "hi", chance: () => 0 })).toMatch(/[ऀ-ॿ]/);
    expect(vary("wake", { register: "en", chance: () => 0 })).not.toMatch(/[ऀ-ॿ]/);
    expect(vary("cancelled", { register: "hinglish", chance: () => 0 })).toMatch(
      /Cancel|Theek|Rok/,
    );
  });

  it("remembers the last few so a pool is used up before a line returns", () => {
    const first = Array.from({ length: 5 }, () => vary("wake", { register: "en" }));
    expect(new Set(first).size).toBe(5);
    expect(lastSaid("wake")).toEqual(first);
  });

  it("chooses fresh wording for lines built from facts", () => {
    const pool = ["a", "b", "c"];
    const seen = Array.from({ length: 6 }, () => chooseFresh("k", pool));
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).not.toBe(seen[i - 1]);
  });

  it("greets differently when no clock or salt is given (a fixed default made every launch the same)", () => {
    const lines = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      lines.add(socialLine({ kind: "greeting", prompt: "hello" }).text);
    }
    expect(lines.size).toBeGreaterThan(2);
  });
});
