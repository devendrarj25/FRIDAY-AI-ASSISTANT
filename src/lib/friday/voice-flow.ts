import { voiceFailureLine } from "./voice-recovery";

export type FlowPhase =
  | "need-python"
  | "need-network"
  | "bootstrap"
  | "venv"
  | "pip"
  | "weights"
  | "worker"
  | "mic-busy"
  | "mic"
  | "wake"
  | "listen"
  | "stt"
  | "brain"
  | "tts"
  | "resume"
  | "failed";

export type FlowState = {
  network: boolean;
  python: boolean;
  venv: boolean;
  pip: boolean;
  packages: boolean;
  weights: boolean;
  worker: boolean;
  mic: "none" | "busy" | "free";
  awake: boolean;
  heard: boolean;
  spoken: boolean;
  phase: FlowPhase;
  line: string;
  crashes: number;
};

export function freshMachine(): FlowState {
  return {
    network: false,
    python: false,
    venv: false,
    pip: false,
    packages: false,
    weights: false,
    worker: false,
    mic: "none",
    awake: false,
    heard: false,
    spoken: false,
    phase: "need-python",
    line: voiceFailureLine("install", 0, "en"),
    crashes: 0,
  };
}

function fail(state: FlowState, cause: string): FlowState {
  return { ...state, phase: "failed", line: voiceFailureLine(cause, state.crashes, "en") };
}

/** One step of a clean-PC voice install. Events are injected. Nothing is downloaded. */
export function advanceFlow(state: FlowState, event: string): FlowState {
  const next: FlowState = { ...state };
  if (event === "disk-full") return fail(next, "install");
  if (event === "permission-denied") return fail(next, "permission");
  if (event === "antivirus") return fail({ ...next, crashes: next.crashes + 1 }, "install");
  if (event === "corrupt-model") {
    next.weights = false;
    return fail(next, "model-failed");
  }
  if (event === "half-cache") {
    next.weights = false;
    next.phase = "weights";
    next.line = voiceFailureLine("downloading", 0, "en");
    return next;
  }
  if (event === "clock-jump") {
    next.line = "The clock jumped. The partial download can resume.";
    return next;
  }
  if (event === "worker-crash") {
    next.worker = false;
    next.crashes += 1;
    if (next.crashes >= 3) return fail(next, "model-failed");
    next.phase = "worker";
    next.line = "The speech worker stopped. It will start again.";
    return next;
  }
  if (event === "network-up") next.network = true;
  if (event === "network-down") {
    next.network = false;
    if (!next.weights) {
      next.phase = "need-network";
      next.line = "The download needs a network. Retry when it returns.";
      return next;
    }
  }
  if (event === "mic-busy") {
    next.mic = "busy";
    next.phase = "mic-busy";
    next.line = voiceFailureLine("busy", 0, "en");
    return next;
  }
  if (event === "mic-free") next.mic = "free";
  if (event === "bootstrap") {
    if (!next.network) {
      next.phase = "need-network";
      next.line = "The download needs a network. Retry when it returns.";
      return next;
    }
    next.python = true;
    next.venv = true;
    next.pip = true;
    next.phase = "pip";
    next.line = "Python is in the runtime folder.";
    return next;
  }
  if (event === "packages") {
    if (!next.python) return fail(next, "install");
    next.packages = true;
    next.phase = "weights";
    next.line = "Speech packages imported.";
    return next;
  }
  if (event === "weights") {
    if (!next.network && !next.weights) {
      next.phase = "need-network";
      next.line = voiceFailureLine("downloading", 1, "en");
      return next;
    }
    next.weights = true;
    next.worker = true;
    next.phase = "worker";
    next.line = "Speech weights are on disk.";
    return next;
  }
  if (event === "wake") {
    if (next.mic !== "free")
      return { ...next, phase: "mic-busy", line: voiceFailureLine("busy", 1, "en") };
    next.awake = true;
    next.phase = "wake";
    next.line = "Wake matched.";
    return next;
  }
  if (event === "heard") {
    if (!next.awake && next.mic === "free") {
      next.phase = "listen";
      next.line = "Waiting for the wake word.";
      return next;
    }
    next.heard = true;
    next.phase = "stt";
    next.line = "Heard the owner.";
    return next;
  }
  if (event === "brain") {
    if (!next.heard) return next;
    next.phase = "brain";
    next.line = "The turn is in the brain.";
    return next;
  }
  if (event === "tts") {
    if (next.phase !== "brain" && !next.heard) return next;
    next.spoken = true;
    next.phase = "tts";
    next.line = "Speaking.";
    return next;
  }
  if (event === "resume") {
    if (!next.spoken) return next;
    next.phase = "resume";
    next.line = "Listening again.";
    return next;
  }
  if (next.python && next.phase === "need-python") next.phase = "bootstrap";
  return next;
}

export function walkVoiceFlow(events: readonly string[]): FlowState {
  return events.reduce((state, event) => advanceFlow(state, event), freshMachine());
}

export const CLEAN_PC_SCRIPT = [
  "bootstrap",
  "network-up",
  "bootstrap",
  "packages",
  "weights",
  "mic-busy",
  "mic-free",
  "wake",
  "heard",
  "brain",
  "tts",
  "resume",
] as const;
