import { conversationSight } from "./conversation-sight";
import { buildEvalCorpus } from "./eval-corpus";
import { personalOffer } from "./proactive-line";
import { thinkBudget } from "./think-budget";
import { voicePackPaths } from "./voice-pack";

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
  "tts",
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
  return ["level", "record-3s", "transcribe", "speak-back"];
}

/** Pack paths and the offline case count. No microphone and no network. */
export function voiceReadinessNote(root: string): string {
  const ids = voicePackPaths(root)
    .map((row) => row.id)
    .join(", ");
  const quiet = personalOffer({
    hour: 23,
    quiet: true,
    budgetLeft: 0,
    name: "",
    openLoops: 0,
  });
  const sight = conversationSight({ asked: false, handoff: true, text: "" });
  const steps = thinkBudget("voice").steps;
  return `${ids}. Offline cases: ${buildEvalCorpus().length}. Voice steps ${steps}.${quiet}${sight.text}`;
}

export function redactDiagnostics(text: string): string {
  return String(text || "")
    .replace(/password\s*[:=]\s*\S+/gi, "password: [blank]")
    .replace(/token\s*[:=]\s*\S+/gi, "token: [blank]")
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, "api_key: [blank]");
}
