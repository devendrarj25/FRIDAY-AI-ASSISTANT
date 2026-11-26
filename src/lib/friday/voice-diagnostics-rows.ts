import type { GovernorStatus, HardwareFacts, SttWorkerCache, VoiceBudget } from "./desktop";
import type { EchoLiveDiagnostics } from "./voice-engine/echo-live";
import type { VoiceEarsPrefs } from "./preferences";
import { figureLine, LatencyMonitor, voiceLatency } from "./voice-engine/latency-monitor";
import type { WakeGuardSnapshot } from "./wake-guard";

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

/** Hands-free wake gates: the state, the false-wake count, what was blocked and why. Counts only, no audio. */
export function wakeGuardRows(snapshot: WakeGuardSnapshot): DiagnosticsRow[] {
  const { counters } = snapshot;
  const blocked = Object.entries(counters.blocked)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(" · ");
  return [
    {
      label: "hands-free state",
      value: `${snapshot.state}${snapshot.locked ? ` (locked: ${snapshot.locked})` : ""} · hands-free ${onOff(snapshot.handsFree)}`,
    },
    {
      label: "wakes (accepted / false)",
      value: `${counters.accepted} accepted · ${counters.falseWakes} false`,
      bad: counters.falseWakes > 0,
    },
    { label: "wakes blocked", value: blocked || "none" },
    {
      label: "wake threshold raise (room noise) · cooldown",
      value: `+${snapshot.thresholdBoost.toFixed(2)} · ${Math.round(snapshot.cooldownLeftMs / 1000)} s`,
    },
    { label: "forced asleep (mute, pause, stop)", value: String(counters.forcedAsleep) },
  ];
}

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
 * The "GPU speech" row: the upgrade offer (a GPU was found but the CUDA runtime libraries were not confirmed) or the
 * confirmed GPU size. Null when the budget has nothing to say about a GPU. The driver alone never claims CUDA works.
 */
function gpuSpeechRow(budget: VoiceBudget | null): DiagnosticsRow | null {
  if (!budget) return null;
  if (budget.gpuUpgrade) {
    return {
      label: "GPU speech",
      value: `${budget.gpuUpgrade.detail} (FRIDAY never calls CUDA working from the driver alone; only the speech kernel finding the libraries counts)`,
    };
  }
  if (budget.sttDevice === "cuda") {
    return {
      label: "GPU speech",
      value: `on (the speech kernel found cuBLAS 12 and cuDNN 9): ${budget.sttSize} on the GPU`,
    };
  }
  return null;
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
  const gpuRow = gpuSpeechRow(budget);
  const gpuRows: DiagnosticsRow[] = gpuRow ? [gpuRow] : [];
  if (!cache) {
    const none = "no speech worker is running yet; it starts on the first turn";
    return [
      { label: labels.models, value: none },
      { label: labels.load, value: none },
      { label: labels.idle, value: none },
      { label: labels.memory, value: none },
      { label: labels.fallbacks, value: none },
      budgetRow,
      ...gpuRows,
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
    ...gpuRows,
  ];
}

/** What the "This PC" rows know: still reading, no desktop app, could not read, or the measured facts. */
export type PcFactsView =
  | { phase: "loading" }
  | { phase: "offline" }
  | { phase: "error"; message: string }
  | { phase: "ready"; facts: HardwareFacts };

const gbText = (value: number | null): string => (value === null ? "not measured" : `${value} GB`);

/** Why CUDA is or is not ready, from the facts alone (never from a card name). */
export function cudaReasonLine(facts: HardwareFacts): string {
  const nvidia = facts.gpus.find((gpu) => gpu.vendor === "nvidia");
  if (facts.cudaReady) {
    return `yes: the NVIDIA driver${facts.driverVersion ? ` ${facts.driverVersion}` : ""} can run CUDA 12 programs (cuDNN is checked separately)`;
  }
  if (facts.gpus.length === 0) return "no: no GPU was found";
  if (!nvidia) return "no: the GPU is not NVIDIA, so CUDA does not apply";
  if (!nvidia.driver && !facts.driverVersion) return "no: no NVIDIA driver version could be read";
  return `no: the NVIDIA driver ${nvidia.driver ?? facts.driverVersion} does not report CUDA 12 (driver 527 or newer is needed)`;
}

/**
 * The read-only "This PC" group of the Voice diagnostics: GPU, video memory, CUDA, memory, free disk on the model
 * drive, processor class and which probes answered. Loading, offline and error say so on every row; a number that no
 * probe measured says "not measured" and is never made up.
 */
export function thisPcRows(view: PcFactsView): DiagnosticsRow[] {
  const labels = [
    "this PC: graphics card",
    "this PC: video memory (total · free)",
    "this PC: CUDA ready",
    "this PC: memory (total · free)",
    "this PC: free disk on the model drive",
    "this PC: processor class",
    "this PC: probes that answered",
  ];
  const all = (value: string, bad = false): DiagnosticsRow[] =>
    labels.map((label) => ({ label, value, ...(bad ? { bad: true } : {}) }));
  if (view.phase === "loading") return all("reading this PC…");
  if (view.phase === "offline") return all("shown in the installed FRIDAY app");
  if (view.phase === "error") {
    return all(
      `could not read this PC: ${view.message || "no answer"}. Use refresh this PC to retry`,
      true,
    );
  }
  const facts = view.facts;
  const gpuName = facts.gpuName || (facts.gpuVendor ? `${facts.gpuVendor} graphics` : "");
  const probes = facts.sources.length
    ? facts.sources.join(" · ")
    : "none (nothing could be measured)";
  return [
    { label: labels[0] ?? "", value: gpuName || "no GPU found", ...(gpuName ? {} : { bad: true }) },
    {
      label: labels[1] ?? "",
      value: `${gbText(facts.vramGb)} · ${gbText(facts.vramFreeGb)}`,
    },
    { label: labels[2] ?? "", value: cudaReasonLine(facts) },
    { label: labels[3] ?? "", value: `${gbText(facts.ramGb)} · ${gbText(facts.ramFreeGb)}` },
    {
      label: labels[4] ?? "",
      value: gbText(facts.diskFreeGb),
      ...(facts.diskFreeGb !== null && facts.diskFreeGb < 5 ? { bad: true } : {}),
    },
    { label: labels[5] ?? "", value: facts.cpuClass ?? "–" },
    { label: labels[6] ?? "", value: probes, ...(facts.sources.length ? {} : { bad: true }) },
  ];
}

/** What the "Resources" rows know: still reading, no desktop app, could not read, or the governor's status. */
export type ResourceView =
  | { phase: "loading" }
  | { phase: "offline" }
  | { phase: "error"; message: string }
  | { phase: "ready"; status: GovernorStatus };

const mbText = (mb: number): string => `${(Math.round((mb / 1024) * 10) / 10).toString()} GB`;

const POWER_LINES: Record<GovernorStatus["power"]["stress"], string> = {
  none: "plugged in, no speed limit",
  battery: "on battery: smaller models are preferred and prefetch waits",
  saver: "battery saver: smaller models are preferred and background work waits",
  thermal: "the PC is slowing itself down (heat): smaller models, background work waits",
};

/**
 * The read-only "Resources" group of the Voice diagnostics (electron/resource-governor.cjs `status`): memory and
 * video memory pressure, what holds a lease, the job queues, the main process lag and the last things the
 * governor did. Loading, offline and error say so on every row.
 */
export function resourceRows(view: ResourceView): DiagnosticsRow[] {
  const labels = [
    "resources: memory (free · level)",
    "resources: video memory (free · level)",
    "resources: leases held",
    "resources: jobs (running/cap · waiting)",
    "resources: main process lag",
    "resources: power",
    "resources: last action",
  ];
  const all = (value: string, bad = false): DiagnosticsRow[] =>
    labels.map((label) => ({ label, value, ...(bad ? { bad: true } : {}) }));
  if (view.phase === "loading") return all("reading resources…");
  if (view.phase === "offline") return all("shown in the installed FRIDAY app");
  if (view.phase === "error") {
    return all(
      `could not read resources: ${view.message || "no answer"}. Use refresh resources to retry`,
      true,
    );
  }
  const s = view.status;
  const memory = s.memory
    ? `${mbText(s.memory.freeMb)} of ${mbText(s.memory.totalMb)} · ${s.memory.level}`
    : "not measured";
  const vram = s.vram
    ? `${mbText(s.vram.freeMb)} of ${mbText(s.vram.totalMb)} · ${s.vram.level}`
    : "not measured (no NVIDIA reading)";
  const leases = s.leases.length
    ? s.leases
        .slice(0, 6)
        .map((l) => `${l.owner} (${l.priority}, ${l.state})`)
        .join(" · ") + (s.queued.length ? ` · ${s.queued.length} waiting` : "")
    : s.queued.length
      ? `none held · ${s.queued.length} waiting`
      : "none held";
  const jobs = Object.entries(s.jobs)
    .map(([name, lane]) => `${name} ${lane.running}/${lane.cap} · ${lane.queued} waiting`)
    .join(" · ");
  const last = s.actions.at(-1);
  return [
    {
      label: labels[0] ?? "",
      value: memory,
      ...(s.memory && s.memory.level !== "ok" ? { bad: true } : {}),
    },
    {
      label: labels[1] ?? "",
      value: vram,
      ...(s.vram && s.vram.level !== "ok" ? { bad: true } : {}),
    },
    { label: labels[2] ?? "", value: leases },
    {
      label: labels[3] ?? "",
      value: jobs || "none",
      ...(Object.values(s.jobs).some((lane) => lane.saturated) ? { bad: true } : {}),
    },
    {
      label: labels[4] ?? "",
      value: s.lag.paused
        ? `p99 ${s.lag.p99Ms} ms, longest ${s.lag.maxMs} ms: background work is paused`
        : `p99 ${s.lag.p99Ms} ms, longest ${s.lag.maxMs} ms`,
      ...(s.lag.paused ? { bad: true } : {}),
    },
    { label: labels[5] ?? "", value: POWER_LINES[s.power.stress] ?? POWER_LINES.none },
    {
      label: labels[6] ?? "",
      value: s.notice ?? (last ? `${last.kind}: ${last.detail}` : "nothing yet"),
      ...(s.notice ? { bad: true } : {}),
    },
  ];
}

/**
 * What the listening front end measured, injected by whatever runs it (the capture path and the streaming ear).
 * Every part may be missing: a part that is `null` or absent was not measured, and its row says so.
 */
export type EarsStats = {
  vad?: { engine: "silero" | "energy"; p: number | null; speechMs: number | null } | null;
  turn?: { lastEndMs: number | null; eager: number; resumed: number } | null;
  frontEnd?: {
    clipRate: number;
    peakDbfs: number;
    rmsDbfs: number;
    agcGainDb: number;
    hpf: boolean;
    decimator: "fir" | "boxcar";
  } | null;
  denoise?: { engine: string; keepRatio: number | null } | null;
  scene?: { kind: "speech" | "music" | "tv" | "noise"; score: number } | null;
};

/** `ok` and `off` are fine, `absent` was not measured, `bad` is a measured problem. */
export type EarsRowState = "ok" | "off" | "absent" | "bad";
export type EarsRow = DiagnosticsRow & { id: string; state: EarsRowState };

const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

const absent = (why: string): string => `absent: ${why}`;

/** A clip rate at or above this share of samples in a second counts as clipping (a lead value, not measured on this PC). */
export const CLIP_WARN_RATE = 0.001;

/**
 * The six "ears" Doctor rows: the stored setting, then what was really measured. A setting that is on but has no
 * measurement says "absent" and why; nothing is made up. A row never claims the sound was improved.
 */
export function earsRows(prefs: VoiceEarsPrefs, stats: EarsStats | null | undefined): EarsRow[] {
  const s = stats ?? {};
  const row = (id: string, label: string, state: EarsRowState, value: string): EarsRow => ({
    id,
    label,
    value,
    state,
    ...(state === "bad" ? { bad: true } : {}),
  });

  const vad = s.vad;
  const vadSetting = `${prefs.vad} · start ${prefs.vadStart} · end ${prefs.vadEnd} · min ${prefs.minSpeechMs} ms`;
  const vadRow = vad
    ? row(
        "ears-vad",
        "ears: speech detector",
        "ok",
        `${vadSetting} · running ${vad.engine}${finite(vad.p) ? ` · speech chance ${vad.p.toFixed(2)}` : ""}`,
      )
    : row(
        "ears-vad",
        "ears: speech detector",
        "absent",
        `${vadSetting} · ${absent("no detector has reported yet (it runs while the streaming ear listens)")}`,
      );

  const turn = s.turn;
  const turnSetting = `${prefs.eagerness} patience · early start ${onOff(prefs.eagerTurn)}`;
  const turnRow = turn
    ? row(
        "ears-turn",
        "ears: turn taking",
        "ok",
        `${turnSetting} · last end after ${finite(turn.lastEndMs) ? `${Math.round(turn.lastEndMs)} ms` : "not timed"} · ${turn.eager} early, ${turn.resumed} resumed`,
      )
    : row(
        "ears-turn",
        "ears: turn taking",
        "absent",
        `${turnSetting} · ${absent("no turn has been timed yet")}`,
      );

  const fe = s.frontEnd;
  const clipSetting = `warning ${onOff(prefs.clipWarn)}`;
  let clipRow: EarsRow;
  if (!fe) {
    clipRow = row(
      "ears-clip",
      "ears: clipping",
      prefs.clipWarn ? "absent" : "off",
      prefs.clipWarn
        ? `${clipSetting} · ${absent("the microphone level has not been measured yet")}`
        : `${clipSetting} · not measured`,
    );
  } else {
    const clipping = prefs.clipWarn && fe.clipRate >= CLIP_WARN_RATE;
    clipRow = row(
      "ears-clip",
      "ears: clipping",
      clipping ? "bad" : "ok",
      `${clipSetting} · ${(fe.clipRate * 100).toFixed(2)}% of samples at the top · peak ${fe.peakDbfs.toFixed(1)} dBFS${clipping ? " · too loud: lower the microphone volume in Windows" : ""}`,
    );
  }

  const agcSetting = `${prefs.agc === "browser" ? "browser leveller" : prefs.agc === "own" ? "FRIDAY leveller" : "no leveller"} · high-pass ${onOff(prefs.hpf)}`;
  let agcRow: EarsRow;
  if (prefs.agc === "off") {
    agcRow = row("ears-agc", "ears: volume leveller", "off", `${agcSetting} · nothing to measure`);
  } else if (prefs.agc === "browser") {
    agcRow = row(
      "ears-agc",
      "ears: volume leveller",
      "ok",
      `${agcSetting} · done by the browser; its gain is not measured by FRIDAY`,
    );
  } else if (fe) {
    agcRow = row(
      "ears-agc",
      "ears: volume leveller",
      "ok",
      `${agcSetting} · gain ${fe.agcGainDb.toFixed(1)} dB · level ${fe.rmsDbfs.toFixed(1)} dBFS · resampler ${fe.decimator}`,
    );
  } else {
    agcRow = row(
      "ears-agc",
      "ears: volume leveller",
      "absent",
      `${agcSetting} · ${absent("the leveller has not reported a gain yet")}`,
    );
  }

  const dn = s.denoise;
  let denoiseRow: EarsRow;
  if (prefs.denoise === "off") {
    denoiseRow = row(
      "ears-denoise",
      "ears: noise clean-up copy",
      "off",
      "off · speech is heard from the plain sound",
    );
  } else if (dn) {
    denoiseRow = row(
      "ears-denoise",
      "ears: noise clean-up copy",
      "ok",
      `${prefs.denoise} · running ${dn.engine}${finite(dn.keepRatio) ? ` · kept ${(dn.keepRatio * 100).toFixed(0)}% of the sound` : ""} · whether it helps on your voice is not measured`,
    );
  } else {
    denoiseRow = row(
      "ears-denoise",
      "ears: noise clean-up copy",
      "absent",
      `${prefs.denoise} · ${absent("the clean-up model has not reported (it may not be downloaded)")}`,
    );
  }

  const sc = s.scene;
  const sceneSetting = `room ${prefs.scene} · other voices ${prefs.otherVoice}`;
  let sceneRow: EarsRow;
  if (prefs.scene === "off") {
    sceneRow = row(
      "ears-scene",
      "ears: room and voice score",
      "off",
      `${sceneSetting} · not scored`,
    );
  } else if (sc) {
    sceneRow = row(
      "ears-scene",
      "ears: room and voice score",
      "ok",
      `${sceneSetting} · sounds like ${sc.kind} (score ${sc.score.toFixed(2)}); a score only, it never approves anything`,
    );
  } else {
    sceneRow = row(
      "ears-scene",
      "ears: room and voice score",
      "absent",
      `${sceneSetting} · ${absent("no room score has been made yet")}`,
    );
  }

  return [vadRow, turnRow, clipRow, agcRow, denoiseRow, sceneRow];
}
