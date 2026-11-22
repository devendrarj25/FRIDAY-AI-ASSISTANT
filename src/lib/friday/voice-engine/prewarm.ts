/**
 * FRIDAY · warm every stage once, right after the microphone opens in Auto mode.
 *
 * The first spoken turn of a session used to pay for loading and compiling every engine. This orchestrator runs
 * one cheap pass of each engine the saved settings select, so the first real turn meets warm ones: the local voice
 * makes three words (discarded, never a cached clip), the speech engine decodes one second of silence, Smart Turn
 * scores that silence, the Brain's kernel connection is opened, and a few short acknowledgement lines are made into
 * memory for the acknowledgement phase. It plays nothing, opens no microphone and makes no cloud call, and it is
 * pure: the clock, the delays and every engine call are injected, so it runs with a fake clock and fake engines.
 *
 * Rules: never before the owner's microphone is open and never outside Auto mode; heavy steps are skipped on the
 * Lite profile and on battery; one retry per step; a failure is a note for Voice Doctor, never an error toast and
 * never a block on entering Auto; mute, pause and Stop everything cancel it and drop what it made.
 */

import { ackPrewarmLines } from "./instant-ack";

export const PREWARM_STEPS = ["stt", "brain", "tts", "turn", "acks"] as const;
export type PrewarmStep = (typeof PREWARM_STEPS)[number];

/** Steps that load a model or run an engine on the CPU: skipped on Lite and on battery. */
export const HEAVY_STEPS: readonly PrewarmStep[] = ["stt", "tts", "turn", "acks"];

export type PrewarmState = "done" | "skipped" | "failed" | "cancelled";

export type PrewarmOutcome = {
  step: PrewarmStep;
  state: PrewarmState;
  ms: number;
  attempts: number;
  reason: string;
};

export type PrewarmReport = {
  startedAt: number;
  ms: number;
  outcomes: PrewarmOutcome[];
};

/** What one engine call answers. `skipped` is an honest "nothing to warm" (an optional model that is not installed). */
export type PrewarmResult = { ok: boolean; skipped?: boolean; reason?: string };

export type PrewarmIO = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Run `fire` after `ms`; the returned call cancels it. */
  after: (ms: number, fire: () => void) => () => void;
  /** Load the speech worker and decode one second of silence (a provisional pass: not counted, not recorded). */
  warmListening: () => Promise<PrewarmResult>;
  /** Open the kernel connection. Makes no model call. */
  warmBrain: () => Promise<PrewarmResult>;
  /** Load the local voice and make `text` once; the samples are discarded. */
  warmSpeech: (text: string) => Promise<PrewarmResult>;
  /** Score one second of silence with Smart Turn. */
  warmTurn: () => Promise<PrewarmResult>;
  /** Make one acknowledgement line; the caller keeps the samples. */
  makeAck: (line: AckLine) => Promise<PrewarmResult>;
};

export type PrewarmPlan = {
  /** `voice.prewarm`. */
  enabled: boolean;
  mode: "auto" | "manual" | "chat" | string;
  /** The microphone is open (consent given and the capture started). */
  micOpen: boolean;
  /** Mute, pause or Stop everything is on. */
  held: boolean;
  /**
   * Which engines the saved settings select. `acks` (the instant acknowledgement lines) follows `tts` when absent;
   * the conductor passes it from `voice.instantAck`, so a turned-off setting renders nothing.
   */
  engines: { stt: boolean; brain: boolean; tts: boolean; turn: boolean; acks?: boolean };
  /** Hardware profile Lite, or the PC is on battery. */
  light: boolean;
};

export type AckLine = { id: string; text: string; lang: "en" | "hi" };

/** The short acknowledgement lines made into memory: the instant-acknowledgement catalogue, nothing else. */
export const ACK_LINES: readonly AckLine[] = Object.freeze(ackPrewarmLines());

/** Three words, in a language every voice graph handles, to compile the synthesis graph. Never spoken aloud. */
export const WARM_SPEECH_TEXT = "Good to go";

/** Each engine call is given this long; a step that runs past it fails and is retried once. */
export const STEP_TIMEOUT_MS = 25_000;
/** Several short syntheses in a row need longer than one. */
export const ACKS_TIMEOUT_MS = 60_000;
export const RETRY_DELAY_MS = 1_500;

const STEP_NAME: Record<PrewarmStep, string> = {
  stt: "speech engine",
  brain: "kernel connection",
  tts: "local voice",
  turn: "Smart Turn",
  acks: "acknowledgement lines",
};

/** Why nothing should run at all, or null when the plan may start. */
export function prewarmBlock(plan: PrewarmPlan): string | null {
  if (!plan.enabled) return "Prewarm is turned off in Voice settings";
  if (plan.mode !== "auto") return "only Auto mode warms the voice";
  if (!plan.micOpen) return "the microphone is not open yet";
  if (plan.held) return "muted, paused or stopped";
  return null;
}

/** Which steps run, and why each other one does not. Order is the order they run in. */
export function planSteps(plan: PrewarmPlan): Array<{ step: PrewarmStep; skip: string }> {
  const selected: Record<PrewarmStep, boolean> = {
    stt: plan.engines.stt,
    brain: plan.engines.brain,
    tts: plan.engines.tts,
    turn: plan.engines.turn,
    acks: plan.engines.acks ?? plan.engines.tts,
  };
  return PREWARM_STEPS.map((step) => {
    if (!selected[step])
      return { step, skip: `${STEP_NAME[step]} is not selected in the settings` };
    if (plan.light && HEAVY_STEPS.includes(step)) {
      return { step, skip: "the Lite profile or battery saver is on" };
    }
    return { step, skip: "" };
  });
}

/** The short lines made into memory. A line is kept only while the session that made it lives. */
export class AckMemory<T> {
  private readonly lines = new Map<string, T>();

  put(id: string, value: T): void {
    this.lines.set(id, value);
  }

  get(id: string): T | undefined {
    return this.lines.get(id);
  }

  ids(): string[] {
    return [...this.lines.keys()];
  }

  clear(): void {
    this.lines.clear();
  }
}

export class Prewarm {
  private cancelled = false;
  private running: Promise<PrewarmReport> | null = null;
  private report: PrewarmReport | null = null;

  constructor(
    private readonly io: PrewarmIO,
    private readonly hooks: {
      /** Called once per step, as it ends (the timing stamp, the Voice Doctor note). */
      onStep?: (outcome: PrewarmOutcome) => void;
      /** Called when the pass was cancelled, so what it made can be dropped. */
      onCancel?: () => void;
    } = {},
  ) {}

  last(): PrewarmReport | null {
    return this.report;
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  /** Stop at the next step boundary; an engine call already in flight is allowed to finish and is discarded. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.running) this.hooks.onCancel?.();
  }

  /** Run the pass once for a plan. Never throws, never rejects, and a second call while one runs joins it. */
  run(plan: PrewarmPlan): Promise<PrewarmReport> {
    if (this.running) return this.running;
    this.cancelled = false;
    const pass = this.pass(plan).finally(() => {
      this.running = null;
    });
    this.running = pass;
    return pass;
  }

  private async pass(plan: PrewarmPlan): Promise<PrewarmReport> {
    const startedAt = this.io.now();
    const outcomes: PrewarmOutcome[] = [];
    const finish = (): PrewarmReport => {
      const done = { startedAt, ms: Math.max(0, this.io.now() - startedAt), outcomes };
      this.report = done;
      return done;
    };
    const push = (outcome: PrewarmOutcome) => {
      outcomes.push(outcome);
      try {
        this.hooks.onStep?.(outcome);
      } catch {
        /* a stamp that fails must not stop the warm-up */
      }
    };
    const blocked = prewarmBlock(plan);
    if (blocked) {
      for (const { step } of planSteps(plan)) {
        push({ step, state: "skipped", ms: 0, attempts: 0, reason: blocked });
      }
      return finish();
    }
    for (const { step, skip } of planSteps(plan)) {
      if (this.cancelled) {
        push({ step, state: "cancelled", ms: 0, attempts: 0, reason: "stopped before it ran" });
        continue;
      }
      if (skip) {
        push({ step, state: "skipped", ms: 0, attempts: 0, reason: skip });
        continue;
      }
      push(await this.attempt(step));
    }
    return finish();
  }

  private call(step: PrewarmStep): Promise<PrewarmResult> {
    switch (step) {
      case "stt":
        return this.io.warmListening();
      case "brain":
        return this.io.warmBrain();
      case "tts":
        return this.io.warmSpeech(WARM_SPEECH_TEXT);
      case "turn":
        return this.io.warmTurn();
      case "acks":
        return this.makeAcks();
    }
  }

  private async makeAcks(): Promise<PrewarmResult> {
    let made = 0;
    let reason = "";
    let skipped = "";
    for (const line of ACK_LINES) {
      if (this.cancelled) return { ok: false, reason: "stopped" };
      const result = await this.io.makeAck(line);
      if (result.ok && result.skipped) skipped = result.reason || "nothing to make";
      else if (result.ok) made += 1;
      else reason = result.reason || "an acknowledgement line could not be made";
    }
    if (made > 0) return { ok: true };
    // Nothing could be made: an engine that is not there is skipped, one that failed is a failure.
    return reason ? { ok: false, reason } : { ok: true, skipped: true, reason: skipped };
  }

  /** One engine call with a time limit, and one retry after a short wait. */
  private async attempt(step: PrewarmStep): Promise<PrewarmOutcome> {
    const started = this.io.now();
    let reason = "";
    for (let attempts = 1; attempts <= 2; attempts += 1) {
      const result = await this.guarded(step);
      if (this.cancelled) {
        return {
          step,
          state: "cancelled",
          ms: this.io.now() - started,
          attempts,
          reason: "stopped while it ran",
        };
      }
      if (result.ok) {
        return {
          step,
          state: result.skipped ? "skipped" : "done",
          ms: Math.max(0, this.io.now() - started),
          attempts,
          reason: result.skipped ? result.reason || "nothing to warm" : "",
        };
      }
      reason = result.reason || "no reason given";
      if (attempts === 1) await this.io.sleep(RETRY_DELAY_MS);
      if (this.cancelled) {
        return {
          step,
          state: "cancelled",
          ms: this.io.now() - started,
          attempts,
          reason: "stopped while it ran",
        };
      }
    }
    return {
      step,
      state: "failed",
      ms: Math.max(0, this.io.now() - started),
      attempts: 2,
      reason: reason.replace(/\s+/g, " ").slice(0, 160),
    };
  }

  private async guarded(step: PrewarmStep): Promise<PrewarmResult> {
    let stop: () => void = () => undefined;
    try {
      const limit = new Promise<PrewarmResult>((resolve) => {
        stop = this.io.after(step === "acks" ? ACKS_TIMEOUT_MS : STEP_TIMEOUT_MS, () =>
          resolve({ ok: false, reason: "timed out" }),
        );
      });
      return await Promise.race([this.call(step), limit]);
    } catch (error) {
      return { ok: false, reason: String((error as Error)?.message || error) };
    } finally {
      stop();
    }
  }
}

// ---------------------------------------------------------------- Voice Doctor

let lastReport: PrewarmReport | null = null;

/** The newest finished pass, kept for Voice Doctor. */
export function notePrewarmReport(report: PrewarmReport | null): void {
  lastReport = report;
}

export function lastPrewarmReport(): PrewarmReport | null {
  return lastReport;
}

export type PrewarmDoctorRow = {
  id: string;
  label: string;
  group: string;
  status: "Warning";
  detail: string;
  fixable: false;
  steps: string[];
};

/** One Warning row per step that failed in the last pass. Skipped and cancelled steps are not faults. */
export function prewarmDoctorRows(report: PrewarmReport | null = lastReport): PrewarmDoctorRow[] {
  if (!report) return [];
  return report.outcomes
    .filter((outcome) => outcome.state === "failed")
    .map((outcome) => ({
      id: `voice:prewarm-${outcome.step}`,
      label: `Voice warm-up: ${STEP_NAME[outcome.step]}`,
      group: "Voice",
      status: "Warning" as const,
      detail: `The ${STEP_NAME[outcome.step]} did not warm up (${outcome.reason}). The first turn may be slower; nothing else is affected.`,
      fixable: false as const,
      steps: [
        "Switch Auto mode off and on to try the warm-up again.",
        "Press Fix voice in Voice diagnostics if this keeps happening.",
      ],
    }));
}

/** One short line of the pass for the voice log and the turn trace. */
export function prewarmLine(report: PrewarmReport): string {
  const parts = report.outcomes.map((outcome) => {
    if (outcome.state === "done") return `${outcome.step} ${outcome.ms} ms`;
    if (outcome.state === "failed") return `${outcome.step} failed (${outcome.reason})`;
    return `${outcome.step} ${outcome.state}`;
  });
  return `prewarm ${report.ms} ms: ${parts.join(", ")}`;
}
