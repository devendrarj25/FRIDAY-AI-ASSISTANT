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
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, "api_key: [blank]");
}
