import { arcSnapshot } from "./conversation-arc";
import { conversationSight } from "./conversation-sight";
import { buildEvalCorpus, buildVoiceScenarios, gradeCase, gradeVoiceScenario } from "./eval-corpus";
import { voiceBudgets } from "./failure-guard";
import { trackWatch } from "./mic-session";
import { personalOffer } from "./proactive-line";
import { thinkBudget } from "./think-budget";
import { outputReachable } from "./tts-ladder";
import { roomWakeDecision } from "./wake-engine";
import { CLEAN_PC_SCRIPT, freshMachine, walkVoiceFlow } from "./voice-flow";
import { voicePackReport } from "./voice-pack";
import { voiceGate } from "./voice-audio";
import { lastSpeechRoute } from "./voice-library";

export const VOICE_LAYERS = [
  "interpreter",
  "pip",
  "package",
  "model",
  "worker",
  "inference",
  "permission",
  "device",
  "exclusive",
  "wake",
  "tts",
  "output",
] as const;

export type VoiceLayer = (typeof VOICE_LAYERS)[number];
export type LayerMark = "pass" | "fail" | "unknown";

export function voiceLayerChecks(marks?: Partial<Record<VoiceLayer, LayerMark>>): {
  id: string;
  label: string;
  group: string;
  status: "Ready" | "Error" | "Warning";
  detail: string;
  fixable: false;
}[] {
  return VOICE_LAYERS.map((id) => {
    const mark = marks?.[id] ?? "unknown";
    const status = mark === "pass" ? "Ready" : mark === "fail" ? "Error" : "Warning";
    const detail =
      mark === "pass"
        ? `${id} passed the last local check.`
        : mark === "fail"
          ? `${id} failed. Use Fix voice or Install Manager, then retry.`
          : `${id} was not run on a live microphone or a live install.`;
    return {
      id: `voice:${id}`,
      label: `Voice ${id}`,
      group: "Voice",
      status,
      detail,
      fixable: false,
    };
  });
}

export function voiceSelfTestPlan(): string[] {
  return [
    "interpreter",
    "pip",
    "packages",
    "weights",
    "worker",
    "inference",
    "permission",
    "device",
    "exclusive",
    "wake",
    "tts",
    "output",
    "transcribe",
  ];
}

export function ownerAcceptanceSteps(): string[] {
  return [
    "1. Open Doctor and run the voice self-test. Each layer should say pass or the failing cause.",
    "2. Say the wake word, then one sentence, and wait for a spoken reply.",
    "3. Hold a 3-turn conversation.",
    "4. Start talking while FRIDAY is speaking. She should stop and listen.",
    "5. Disconnect the network mid-reply. Speech should move to the offline voice.",
    "6. Unplug the microphone and plug it back in. Listening should return.",
    "7. Sleep the PC and wake it. Listening should return.",
    "8. If a step fails, copy the Voice rows and the on-screen status. Do not send a recording.",
  ];
}

/** Pack paths and the offline case count. No microphone and no network. */
export function voiceReadinessNote(root: string): string {
  const pack = voicePackReport(root, () => false);
  const ids = pack.map((row) => row.id).join(", ");
  const quiet = personalOffer({
    hour: 23,
    quiet: true,
    budgetLeft: 0,
    name: "",
    openLoops: 0,
  });
  const sight = conversationSight({ asked: false, handoff: true, text: "" });
  const steps = thinkBudget("voice").steps;
  const flow = walkVoiceFlow(CLEAN_PC_SCRIPT);
  const scenarios = buildVoiceScenarios();
  const failed = scenarios.filter((item) => gradeVoiceScenario(item).length).length;
  const budgets = voiceBudgets({
    listenMs: 1000,
    audioMs: 200,
    idleCpu: [0.2],
    memoryMb: [100, 110],
  });
  const sample = freshMachine().phase;
  const corpus = buildEvalCorpus();
  const first = corpus[0];
  const graded = first ? gradeCase(first).length : 0;
  const wake = roomWakeDecision([0.01, 0.02, 0.8], 0.8, 0.01);
  const watch = trackWatch({ frames: 10, sameEnergy: 0, handles: 1, crashes: 0 });
  const output = outputReachable({ deviceId: "default", volume: 1 });
  const memory = arcSnapshot().length;
  return `${ids}. Offline cases: ${corpus.length}. Voice steps ${steps}. Flow ${flow.phase}. Scenarios ${scenarios.length - failed}/${scenarios.length}. Budgets ${budgets.filter((row) => row.ok).length}. Sample ${sample}. Grade ${graded}. Wake ${wake.mark}. Watch ${watch.restart ? "restart" : "steady"}. Output ${output.ok ? "ready" : "silent"}. Notes ${memory}.${quiet}${sight.text}`;
}

export function redactDiagnostics(text: string): string {
  return String(text || "")
    .replace(/password\s*[:=]\s*\S+/gi, "password: [blank]")
    .replace(/token\s*[:=]\s*\S+/gi, "token: [blank]")
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, "api_key: [blank]")
    .replace(/\bghp_[A-Za-z0-9_]+\b/g, "[blank]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, "[blank]");
}

export type VoiceProbeCheck = { id: string; label: string; ok: boolean; detail: string };

/** One PASS or FAIL line per probe, plus a diagnostics block with secrets removed. */
export function formatVoiceProbeReport(checks: VoiceProbeCheck[]): {
  lines: string[];
  diagnostics: string;
  checks: VoiceProbeCheck[];
} {
  const safe = (Array.isArray(checks) ? checks : []).map((check) => ({
    id: String(check.id || "layer"),
    label: String(check.label || check.id || "layer"),
    ok: Boolean(check.ok),
    detail: redactDiagnostics(check.detail),
  }));
  const lines = safe.map((check) => `${check.ok ? "PASS" : "FAIL"} ${check.id}`);
  const diagnostics = safe
    .map((check, index) => `${lines[index]} ${check.label}: ${check.detail}`)
    .join("\n");
  return { lines, diagnostics, checks: safe };
}

const VOICE_DEBUG_KEY = "friday.voice.debug";
let frameCount = 0;
let frameWindow = 0;
let frameRate = 0;

/** True only when the owner set friday.voice.debug to 1. No transcript is stored. */
export function voiceDebugOn(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(VOICE_DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

/** Counts voice-screen commits. The rate is reported only while the debug flag is on. */
export function noteVoiceFrame(now = Date.now()): number {
  if (!frameWindow) frameWindow = now;
  frameCount += 1;
  const elapsed = now - frameWindow;
  if (elapsed >= 1000) {
    frameRate = Math.round((frameCount * 1000) / elapsed);
    frameCount = 0;
    frameWindow = now;
  }
  return frameRate;
}

export function voiceRenderRate(): number {
  return frameRate;
}

export function resetVoiceRenderRate(): void {
  frameCount = 0;
  frameWindow = 0;
  frameRate = 0;
}

/** One diagnostics line. No audio, no transcript, no secrets. */
export function formatVoiceRuntimeLine(input: {
  engine: string;
  voiceId: string;
  lang: string;
  sttModel: string;
  deviceId: string;
  deviceLabel: string;
  sampleRate: number | null;
  echo: boolean | null;
  errors: string[];
  renderRate?: number | null;
}): string {
  const errors =
    input.errors
      .slice(-5)
      .map((row) => redactDiagnostics(row))
      .join("; ") || "none";
  const echo = input.echo === null ? "unknown" : input.echo ? "on" : "off";
  const rate = input.renderRate == null ? "" : ` render ${input.renderRate}/s`;
  return redactDiagnostics(
    `engine ${input.engine || "none"} voice ${input.voiceId || "none"} lang ${input.lang || "none"} stt ${input.sttModel || "none"} device ${input.deviceId || "default"} ${input.deviceLabel || ""} sample ${input.sampleRate ?? "unknown"} echo ${echo} errors ${errors}${rate}`,
  );
}

export function liveVoiceRuntimeLine(voice: {
  tts: { engine: string | null; voice: string };
  stt: { model: string | null };
}): string {
  const route = lastSpeechRoute();
  const track = voiceGate.micStream()?.getAudioTracks()[0];
  const settings = (track?.getSettings?.() ?? {}) as { deviceId?: string; sampleRate?: number };
  return formatVoiceRuntimeLine({
    engine: route.engine || voice.tts.engine || "",
    voiceId: route.voiceId || voice.tts.voice || "",
    lang: route.lang,
    sttModel: voice.stt.model || "",
    deviceId: settings.deviceId || "",
    deviceLabel: track?.label || "",
    sampleRate: typeof settings.sampleRate === "number" ? settings.sampleRate : null,
    echo: voiceGate.echoCancellation(),
    errors: voiceGate.recentErrors(),
    renderRate: voiceDebugOn() ? voiceRenderRate() : null,
  });
}
