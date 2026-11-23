import type { SttWorkerCache, VoiceBudget } from "./desktop";
import type { EchoLiveDiagnostics } from "./voice-engine/echo-live";
import { figureLine, LatencyMonitor, voiceLatency } from "./voice-engine/latency-monitor";

/** One read-only diagnostics row in the shape the Voice diagnostics list already uses. */
export type DiagnosticsRow = { label: string; value: string; bad?: boolean };

/** The three stored switches these rows report; nothing here changes them. */
export type VoiceSwitches = { instantAck?: boolean; eagerTurn?: boolean; echoReference?: boolean };

const onOff = (value: boolean | undefined): string => (value === true ? "on" : "off");

/** A derived latency figure, or "not used yet" until the stages behind it were really stamped. Never a made-up number. */
export function stampedFigure(metric: string, monitor: LatencyMonitor = voiceLatency): string {
  const line = figureLine(metric, monitor);
  return monitor.summary(metric) ? line : "not used yet";
}

const decibels = (value: number | null): string =>
  value === null || !Number.isFinite(value) ? "no measurement yet" : `${value.toFixed(1)} dB`;

/** The echo reference rows. Empty when the reference is switched off: nothing to report, nothing invented. */
export function echoReferenceRows(diagnostics: EchoLiveDiagnostics): DiagnosticsRow[] {
  if (!diagnostics.enabled) return [];
  return [
    {
      label: "echo reference (reduction measured by the local canceller)",
      value: decibels(diagnostics.reductionDb),
    },
    {
      label: "echo reference delay",
      value:
        diagnostics.delayMs === null || !Number.isFinite(diagnostics.delayMs)
          ? "no measurement yet"
          : `${Math.round(diagnostics.delayMs)} ms`,
    },
    {
      label: "echo reference frames (cancelled / passed unchanged)",
      value: `${diagnostics.cancelledFrames} cancelled · ${diagnostics.passedFrames} passed`,
    },
    { label: "echo reference shadow check", value: diagnostics.shadowReason || "not run yet" },
    {
      label: "echo reference scope",
      value:
        "exists only while raw-sample playback (voice.pcmPlayback) is used; unverified on the owner's PC",
    },
  ];
}

/** Instant acknowledgement and early start: the stored setting, then what the latency monitor really stamped. */
export function earlyStartRows(
  switches: VoiceSwitches,
  monitor: LatencyMonitor = voiceLatency,
): DiagnosticsRow[] {
  return [
    {
      label: "instant acknowledgement (setting · armed to audible)",
      value: `${onOff(switches.instantAck)} · ${stampedFigure("ackArmedToAudible", monitor)}`,
    },
    {
      label: "early start (setting · started to resolved)",
      value: `${onOff(switches.eagerTurn)} · ${stampedFigure("eagerOverlap", monitor)}`,
    },
    { label: "echo reference (setting)", value: onOff(switches.echoReference) },
  ];
}

/** What the speech-worker rows know: still reading, could not read, no desktop app, or the answers (each may be absent). */
export type SpeechWorkerView =
  | { phase: "loading" }
  | { phase: "offline" }
  | { phase: "error"; message: string }
  | { phase: "ready"; cache: SttWorkerCache | null; budget: VoiceBudget | null };

const seconds = (value: number): string => {
  if (value < 90) return `${Math.round(value)} s`;
  return `${Math.round(value / 60)} min`;
};

/** The one profile line: profile name, speech size and device, resident cap, and the memory speech may use. */
export function voiceBudgetProfileLine(budget: VoiceBudget): string {
  const gb = Number.isFinite(budget.speechBudgetGb)
    ? `${budget.speechBudgetGb} GB`
    : "unknown memory";
  return `${budget.profile} profile · speech ${budget.sttSize} (${budget.sttDevice}) · at most ${budget.maxResidentModels} resident · up to ${gb} for speech`;
}

/**
 * The speech worker's cache and this PC's budget as read-only rows. Loading, offline and error each say so on every row
 * instead of showing a number; a worker that is not running (or an older one that reports nothing) says that.
 */
export function speechWorkerRows(view: SpeechWorkerView): DiagnosticsRow[] {
  const labels = {
    models: "speech models loaded",
    load: "speech model load time",
    idle: "speech idle time · unloads",
    memory: "speech memory pressure",
    fallbacks: "speech fallbacks",
    budget: "speech budget (this PC)",
  };
  const all = (value: string, bad = false): DiagnosticsRow[] =>
    Object.values(labels).map((label) => ({ label, value, ...(bad ? { bad: true } : {}) }));
  if (view.phase === "loading") return all("reading the speech worker…");
  if (view.phase === "offline") return all("shown in the installed FRIDAY app");
  if (view.phase === "error") {
    return all(
      `could not read the speech worker: ${view.message || "no answer"}. Use refresh to retry`,
      true,
    );
  }
  const { cache, budget } = view;
  const budgetRow: DiagnosticsRow = {
    label: labels.budget,
    value: budget ? voiceBudgetProfileLine(budget) : "this PC's speech budget is not available",
    ...(budget ? {} : { bad: true }),
  };
  if (!cache) {
    const none = "no speech worker is running yet; it starts on the first turn";
    return [
      { label: labels.models, value: none },
      { label: labels.load, value: none },
      { label: labels.idle, value: none },
      { label: labels.memory, value: none },
      { label: labels.fallbacks, value: none },
      budgetRow,
    ];
  }
  const kinds = Object.entries(cache.fallbacks.byKind).map(([kind, count]) => `${kind} ${count}`);
  const level = cache.memory.level;
  const memory = cache.memory.known
    ? `${level} · ${cache.memory.availableMb ?? "?"} MB free of ${cache.memory.totalMb ?? "?"} MB`
    : "unknown (this PC could not be read)";
  return [
    {
      label: labels.models,
      value: cache.loadedModels.length
        ? cache.loadedModels.map((row) => `${row.name} (${row.engine})`).join(", ")
        : "none loaded (they load on the next turn)",
    },
    {
      label: labels.load,
      value: cache.loadedModels.length
        ? cache.loadedModels
            .map((row) => `${row.name} ${row.loadMs === null ? "not timed" : `${row.loadMs} ms`}`)
            .join(", ")
        : "nothing loaded",
    },
    {
      label: labels.idle,
      value: `${cache.idleSec === null ? "nothing loaded" : `idle ${seconds(cache.idleSec)}`} · ${cache.unloadCount} unload(s)`,
    },
    { label: labels.memory, value: memory, ...(level === "ok" ? {} : { bad: true }) },
    {
      label: labels.fallbacks,
      value: cache.fallbacks.total ? `${cache.fallbacks.total} (${kinds.join(", ")})` : "none",
    },
    budgetRow,
  ];
}
