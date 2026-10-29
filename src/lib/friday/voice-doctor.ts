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
import { currentVoiceHealth } from "./voice-health";

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

type VoiceLayerRow = {
  id: string;
  label: string;
  group: string;
  status: "Ready" | "Error" | "Warning";
  detail: string;
  fixable: false;
  steps?: string[];
};

/** Which voice-check row proves which layer. */
const CHECK_LAYER: Array<[RegExp, VoiceLayer]> = [
  [/^python$/, "interpreter"],
  [/^stt-import$|^tts-import$/, "package"],
  [/^stt-model$/, "model"],
  [/^stt-transcribe$|^hearing-level-/, "inference"],
  [/^tts-voice$/, "tts"],
];

let lastCheckMarks: Partial<Record<VoiceLayer, LayerMark>> = {};

/**
 * Remember the last real voice check (Voice diagnostics → voice check) as
 * layer marks. A layer fails when any of its rows failed.
 */
export function noteVoiceCheck(
  checks: ReadonlyArray<{ id: string; ok: boolean; required?: boolean; detail?: string }>,
): Partial<Record<VoiceLayer, LayerMark>> {
  const marks: Partial<Record<VoiceLayer, LayerMark>> = {};
  for (const check of checks) {
    const layer = CHECK_LAYER.find(([pattern]) => pattern.test(check.id))?.[1];
    if (!layer) continue;
    // A visible skip (no weights, no synthesiser) proves nothing either way.
    if (check.ok && /^skipped/i.test(String(check.detail || ""))) continue;
    if (!check.ok && check.required === false) continue;
    marks[layer] = check.ok && marks[layer] !== "fail" ? "pass" : "fail";
  }
  if (marks.package === "pass") marks.pip = "pass";
  if (marks.model === "pass") marks.worker = "pass";
  lastCheckMarks = marks;
  return marks;
}

/** Marks the running Auto session proves without a separate check. */
export function liveVoiceMarks(
  live: {
    mode: string;
    micReady: boolean;
    sttReady: boolean;
    ttsEngine: string;
    ttsError: string;
    heard: number;
  } | null,
): Partial<Record<VoiceLayer, LayerMark>> {
  if (!live || live.mode !== "auto") return {};
  const marks: Partial<Record<VoiceLayer, LayerMark>> = {};
  if (live.micReady) {
    marks.permission = "pass";
    marks.device = "pass";
    marks.exclusive = "pass";
  }
  if (live.sttReady) marks.worker = "pass";
  if (live.heard > 0) marks.inference = "pass";
  if (live.ttsEngine && live.ttsEngine !== "none" && !live.ttsError) {
    marks.tts = "pass";
    marks.output = "pass";
  }
  return marks;
}

/** The last voice check and the live session together. A failure wins over a pass. */
export function voiceDoctorMarks(): Partial<Record<VoiceLayer, LayerMark>> {
  const merged: Partial<Record<VoiceLayer, LayerMark>> = {
    ...liveVoiceMarks(currentVoiceHealth()),
  };
  for (const [layer, mark] of Object.entries(lastCheckMarks) as Array<[VoiceLayer, LayerMark]>) {
    merged[layer] = mark === "fail" || merged[layer] !== "fail" ? mark : "fail";
  }
  return merged;
}

/**
 * One row per layer that passed or failed. Layers nobody has checked yet are
 * one row that says how to check them, not twelve warnings.
 */
export function voiceLayerChecks(marks?: Partial<Record<VoiceLayer, LayerMark>>): VoiceLayerRow[] {
  const rows: VoiceLayerRow[] = [];
  const unchecked: VoiceLayer[] = [];
  for (const id of VOICE_LAYERS) {
    const mark = marks?.[id] ?? "unknown";
    if (mark === "unknown") {
      unchecked.push(id);
      continue;
    }
    rows.push({
      id: `voice:${id}`,
      label: `Voice ${id}`,
      group: "Voice",
      status: mark === "pass" ? "Ready" : "Error",
      detail:
        mark === "pass"
          ? `${id} passed the last local check.`
          : `${id} failed. Use Fix voice or Install Manager, then retry.`,
      fixable: false,
    });
  }
  if (unchecked.length) {
    rows.push({
      id: "voice:unchecked",
      label: "Voice layers not checked yet",
      group: "Voice",
      status: "Warning",
      detail: `${unchecked.join(", ")} — not checked in this session.`,
      fixable: false,
      steps: [
        "Switch to Auto mode and open Voice diagnostics.",
        "Press voice check. It loads the speech model and tests hearing and speaking on this PC.",
        "Run Setup & Doctor again; each layer then shows PASS or the exact failure.",
      ],
    });
  }
  return rows;
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

export type VoiceProbeCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  optional?: boolean;
  installId?: string;
};

/** One PASS, OPTIONAL, or FAIL line per probe, plus a diagnostics block with secrets removed. */
export function formatVoiceProbeReport(checks: VoiceProbeCheck[]): {
  lines: string[];
  diagnostics: string;
  checks: VoiceProbeCheck[];
} {
  const safe = (Array.isArray(checks) ? checks : []).map((check) => ({
    id: String(check.id || "layer"),
    label: String(check.label || check.id || "layer"),
    ok: Boolean(check.ok),
    optional: Boolean(check.optional),
    installId: String(check.installId || ""),
    detail: redactDiagnostics(check.detail),
  }));
  const lines = safe.map(
    (check) => `${check.optional ? "OPTIONAL" : check.ok ? "PASS" : "FAIL"} ${check.id}`,
  );
  const diagnostics = safe
    .map((check, index) => `${lines[index]} ${check.label}: ${check.detail}`)
    .join("\n");
  return { lines, diagnostics, checks: safe };
}

const VOICE_DEBUG_KEY = "friday.voice.debug";
let frameCount = 0;
let frameWindow = 0;
let frameRate = 0;
let displayFrames = 0;
let displayWindow = 0;
let displayFps = 0;
let longTasks = 0;
let longObserver: { disconnect: () => void } | null = null;

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

/** Display frames, counted only while the voice debug flag is on. */
export function noteDisplayFrame(now = Date.now()): number {
  if (!voiceDebugOn()) return 0;
  armLongTasks();
  if (!displayWindow) displayWindow = now;
  displayFrames += 1;
  const elapsed = now - displayWindow;
  if (elapsed >= 1000) {
    displayFps = Math.round((displayFrames * 1000) / elapsed);
    displayFrames = 0;
    displayWindow = now;
  }
  return displayFps;
}

export function voiceDisplayFps(): number {
  return displayFps;
}

export function voiceLongTasks(): number {
  return longTasks;
}

function armLongTasks(): void {
  if (longObserver || typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      longTasks += list.getEntries().length;
    });
    observer.observe({ type: "longtask", buffered: true });
    longObserver = observer;
  } catch {
    longObserver = { disconnect() {} };
  }
}

export function resetVoiceRenderRate(): void {
  frameCount = 0;
  frameWindow = 0;
  frameRate = 0;
  displayFrames = 0;
  displayWindow = 0;
  displayFps = 0;
  longTasks = 0;
  longObserver?.disconnect();
  longObserver = null;
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
  fps?: number | null;
  longTasks?: number | null;
}): string {
  const errors =
    input.errors
      .slice(-5)
      .map((row) => redactDiagnostics(row))
      .join("; ") || "none";
  const echo = input.echo === null ? "unknown" : input.echo ? "on" : "off";
  const rate = input.renderRate == null ? "" : ` render ${input.renderRate}/s`;
  const perf =
    input.fps == null && input.longTasks == null
      ? ""
      : ` fps ${input.fps ?? 0} long ${input.longTasks ?? 0}`;
  return redactDiagnostics(
    `engine ${input.engine || "none"} voice ${input.voiceId || "none"} lang ${input.lang || "none"} stt ${input.sttModel || "none"} device ${input.deviceId || "default"} ${input.deviceLabel || ""} sample ${input.sampleRate ?? "unknown"} echo ${echo} errors ${errors}${rate}${perf}`,
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
    fps: voiceDebugOn() ? voiceDisplayFps() : null,
    longTasks: voiceDebugOn() ? voiceLongTasks() : null,
  });
}
