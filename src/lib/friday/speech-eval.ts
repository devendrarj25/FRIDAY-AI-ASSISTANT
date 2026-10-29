export type EngineSample = { id: string; ms: number; ok: boolean };

export function pickEngine(
  samples: EngineSample[],
  previousHardware: string,
  hardware: string,
): { id: string | null; reason: string; rebenchmark: boolean } {
  const rebenchmark = previousHardware !== hardware;
  const viable = samples.filter((sample) => sample.ok && sample.ms >= 0);
  const best = [...viable].sort((a, b) => a.ms - b.ms || a.id.localeCompare(b.id))[0];
  if (!best) return { id: null, reason: "no viable engine", rebenchmark };
  const why = rebenchmark ? "hardware changed" : "fastest viable";
  return { id: best.id, reason: `${why}: ${best.id} at ${best.ms}ms`, rebenchmark };
}

export function wordError(hypothesis: string, reference: string): { wer: number; words: number } {
  const left = hypothesis.toLowerCase().split(/\s+/).filter(Boolean);
  const right = reference.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = left.length + 1;
  const cols = right.length + 1;
  const cost: number[] = new Array(rows * cols).fill(0);
  const at = (r: number, c: number) => r * cols + c;
  for (let r = 0; r < rows; r += 1) cost[at(r, 0)] = r;
  for (let c = 0; c < cols; c += 1) cost[at(0, c)] = c;
  for (let r = 1; r < rows; r += 1) {
    for (let c = 1; c < cols; c += 1) {
      const sub = (left[r - 1] === right[c - 1] ? 0 : 1) + (cost[at(r - 1, c - 1)] ?? 0);
      const del = (cost[at(r - 1, c)] ?? 0) + 1;
      const ins = (cost[at(r, c - 1)] ?? 0) + 1;
      cost[at(r, c)] = Math.min(sub, del, ins);
    }
  }
  const edits = cost[at(left.length, right.length)] ?? 0;
  const words = Math.max(1, right.length);
  return { wer: edits / words, words: right.length };
}

export function voiceBudgets(input: {
  listenMs: number;
  audioMs: number;
  idle: number;
  memoryMb: number;
}): string[] {
  const failures: string[] = [];
  if (input.listenMs > 45000) failures.push("first-listen");
  if (input.audioMs > 1500) failures.push("first-audio");
  if (input.idle > 2) failures.push("idle");
  if (input.memoryMb > 64) failures.push("memory");
  return failures;
}

export type FlowPhase =
  | "need-network"
  | "runtime"
  | "weights"
  | "mic-busy"
  | "listening"
  | "stt"
  | "tts"
  | "resume"
  | "free-board"
  | "fail";

export type FlowEvent =
  | "network-up"
  | "mic-busy"
  | "mic-free"
  | "disk-full"
  | "permission-denied"
  | "antivirus"
  | "corrupt-model"
  | "half-cache"
  | "hash-mismatch"
  | "clock-jump"
  | "worker-crash"
  | "pack-staged"
  | "free-board"
  | "chat-turn"
  | "auto-turn";

export function freshMachine(): { phase: FlowPhase; crashes: number; network: boolean } {
  return { phase: "need-network", crashes: 0, network: false };
}

export function advanceFlow(
  state: { phase: FlowPhase; crashes: number; network: boolean },
  event: FlowEvent,
): { phase: FlowPhase; crashes: number; network: boolean; line: string } {
  const next = { ...state };
  if (event === "network-up") next.network = true;
  if (event === "worker-crash") next.crashes += 1;
  if (
    event === "disk-full" ||
    event === "permission-denied" ||
    event === "antivirus" ||
    event === "corrupt-model" ||
    event === "hash-mismatch"
  ) {
    return { ...next, phase: "fail", line: event };
  }
  if (event === "half-cache" || event === "clock-jump") {
    return { ...next, phase: "weights", line: event };
  }
  if (next.crashes >= 3) return { ...next, phase: "fail", line: "worker-crash" };
  if (event === "pack-staged") return { ...next, phase: "runtime", line: "staged-pack" };
  if (event === "free-board") return { ...next, phase: "free-board", line: "free-board" };
  if (event === "chat-turn" || event === "auto-turn") {
    return { ...next, phase: "resume", line: event };
  }
  if (!next.network && next.phase === "need-network") return { ...next, line: "need-network" };
  if (event === "mic-busy") return { ...next, phase: "mic-busy", line: "microphone is busy" };
  if (event === "mic-free")
    return { ...next, phase: "listening", network: true, line: "listening" };
  const order: FlowPhase[] = [
    "need-network",
    "runtime",
    "weights",
    "listening",
    "stt",
    "tts",
    "resume",
  ];
  const index = order.indexOf(next.phase);
  const phase = order[Math.min(order.length - 1, index + 1)] ?? "resume";
  return { ...next, phase, network: true, line: phase };
}
