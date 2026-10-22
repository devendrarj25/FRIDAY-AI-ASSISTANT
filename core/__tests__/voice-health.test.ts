import { afterEach, describe, expect, it } from "vitest";
import { baselineRespond, isOwnVoiceQuestion } from "../../src/lib/friday/brain/baseline-responder";
import { inspectSelf } from "../../src/lib/friday/brain/self-diagnosis";
import {
  describeVoiceHealth,
  problemsFromVoiceHealth,
  registerVoiceHealth,
  type VoiceHealth,
} from "../../src/lib/friday/voice-health";

const live = (patch: Partial<VoiceHealth> = {}): VoiceHealth => ({
  mode: "auto",
  listening: true,
  paused: false,
  micReady: true,
  micDetail: "",
  sttReady: true,
  sttModel: "base",
  sttError: "",
  heard: 1,
  dropped: { "no-speech": 0, empty: 21 },
  droppedTotal: 21,
  ttsEngine: "sapi",
  ttsError: "",
  turnLine: "heard ✓ +0ms (8 words) → routed – → model – → reply – → spoken –",
  stoppedAt: { stage: "routed", reason: "not meant for FRIDAY (ambient)" },
  ...patch,
});

let off: (() => void) | null = null;
afterEach(() => {
  off?.();
  off = null;
});

describe("voice health", () => {
  it("names the owner's real failure: most utterances dropped, mostly empty", () => {
    const { problems, facts } = problemsFromVoiceHealth(live());
    const drops = problems.find((row) => row.id === "voice:drops");
    expect(drops?.detail).toBe("heard 1, dropped 21, mostly empty");
    expect(drops?.fix).toMatch(/mic test/);
    expect(facts.join(" ")).toContain("Last spoken turn stopped at routed");
  });

  it("flags a model that is not ready and a mode that never opens the mic", () => {
    const ids = problemsFromVoiceHealth(
      live({ mode: "chat", sttReady: false, sttError: "model-missing", droppedTotal: 0 }),
    ).problems.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining(["voice:not-auto", "voice:stt"]));
    expect(ids).not.toContain("voice:drops");
  });

  it("says plainly when the voice session has not started", () => {
    expect(describeVoiceHealth(null)).toMatch(/has not started/);
    expect(problemsFromVoiceHealth(null)).toEqual({ problems: [], facts: [] });
  });

  it("the self-check carries the voice section once Auto mode registers", () => {
    off = registerVoiceHealth(() => live());
    const report = inspectSelf();
    expect(report.problems.some((row) => row.id === "voice:drops")).toBe(true);
    expect(report.facts.some((line) => line.startsWith("Voice: auto mode"))).toBe(true);
  });
});

describe("a chat question about her own voice", () => {
  const owner = [
    "kya tum check kar sakti ho ki voice me tum baat kyu nahi kar paa rhi?",
    "thik karo na yarr tumare voice mode ko",
    "why can't you hear me?",
    "check your microphone",
  ];

  it("is recognised in Hinglish and English", () => {
    for (const text of owner) expect(isOwnVoiceQuestion(text), text).toBe(true);
    for (const text of [
      "write a voiceover script for my video",
      "send a voice note to mom",
      "what is the weather today",
    ]) {
      expect(isOwnVoiceQuestion(text), text).toBe(false);
    }
  });

  it("is answered from the live session, not handed to a model", async () => {
    off = registerVoiceHealth(() => live());
    const reply = baselineRespond(owner[0]!);
    expect(reply.handled).toBe(true);
    expect(reply.kind).toBe("diagnosis");
    const text = await reply.resolve!();
    expect(text).toContain("Most of what I heard was dropped");
    expect(text).toContain("Last turn: heard ✓");
    expect(text).not.toMatch(/agent/i);
  });
});

describe("Setup & Doctor voice layers", () => {
  it("collapses unchecked layers into one row with real steps", async () => {
    const { voiceLayerChecks } = await import("../../src/lib/friday/voice-doctor");
    const rows = voiceLayerChecks({});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("voice:unchecked");
    expect(rows[0]!.steps?.join(" ")).toMatch(/voice check/);
  });

  it("turns the last voice check and the live session into PASS and FAIL rows", async () => {
    const { noteVoiceCheck, voiceDoctorMarks, voiceLayerChecks } =
      await import("../../src/lib/friday/voice-doctor");
    noteVoiceCheck([
      { id: "python", ok: true },
      { id: "stt-import", ok: true },
      { id: "stt-model", ok: true },
      { id: "stt-transcribe", ok: true, detail: "skipped: model-missing" },
      { id: "hearing-level-0.5", ok: false, required: true, detail: "misheard" },
      { id: "tts-voice", ok: true },
    ]);
    off = registerVoiceHealth(() => live({ heard: 3 }));
    const marks = voiceDoctorMarks();
    expect(marks.interpreter).toBe("pass");
    expect(marks.model).toBe("pass");
    // The failed hearing level wins over the live session's heard lines.
    expect(marks.inference).toBe("fail");
    expect(marks.permission).toBe("pass");
    const rows = voiceLayerChecks(marks);
    expect(rows.find((row) => row.id === "voice:inference")?.status).toBe("Error");
    expect(rows.find((row) => row.id === "voice:interpreter")?.status).toBe("Ready");
    expect(rows.find((row) => row.id === "voice:unchecked")?.detail).toContain("wake");
    noteVoiceCheck([]);
  });
});
