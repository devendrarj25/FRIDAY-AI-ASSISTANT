/**
 * Boot progress: how far start-up really is, and when the boot screen may leave.
 *
 * The main process names the stages once (`electron/boot-plan.cjs`) and then reports a step for each piece of work
 * it finishes. Everything here is a pure function of that plan and those steps, so the screen shows the real state
 * (never a made-up timer) and a test can read every rule.
 */

export type BootMode = "first-run" | "restart" | "sign-in" | "start";

export type BootStage = {
  id: string;
  label: string;
  weight: number;
  /** Skipped when the owner has not chosen a FRIDAY folder yet. */
  needsWorkspace?: boolean;
};

export type BootPlan = {
  mode: BootMode;
  title: string;
  detail: string;
  stages: BootStage[];
};

export type BootStepLike = {
  label: string;
  status: "ok" | "warn" | "missing";
  detail?: string;
  at: number;
  stage?: string | null;
};

export type StageState = "done" | "warn" | "missing" | "active" | "waiting" | "skipped";

export type StageRow = { id: string; label: string; state: StageState; detail?: string };

export type BootProgress = {
  /** What is really finished, 0 to 100. */
  percent: number;
  stages: StageRow[];
  /** The stage being worked on now (or "Ready"). */
  currentLabel: string;
  currentDetail: string;
  /** The "FRIDAY ready" step arrived. */
  ready: boolean;
  /** …and it said everything required is up. */
  readyOk: boolean;
  /** Why FRIDAY is not fully ready, when `ready` is true and `readyOk` is false. */
  blockers: string;
  /** The share of the bar (in percent points) the active stage may still add while it works. */
  headroom: number;
};

const toState = (status: BootStepLike["status"]): StageState =>
  status === "ok" ? "done" : status === "warn" ? "warn" : "missing";

export function computeBootProgress(plan: BootPlan, steps: BootStepLike[]): BootProgress {
  // The latest step of each stage wins (a restart of the kernel reports "Starting services" again).
  const latest = new Map<string, BootStepLike>();
  for (const step of steps) {
    if (!step.stage) continue;
    const seen = latest.get(step.stage);
    if (!seen || step.at >= seen.at) latest.set(step.stage, step);
  }
  const workspaceMissing = latest.get("workspace")?.status === "missing";
  const readyStep = latest.get("ready");
  const ready = Boolean(readyStep);

  const considered = plan.stages.filter((stage) => !(stage.needsWorkspace && workspaceMissing));
  const total = considered.reduce((sum, stage) => sum + stage.weight, 0) || 1;
  let finished = 0;
  let active: BootStage | null = null;
  const rows: StageRow[] = plan.stages.map((stage) => {
    if (stage.needsWorkspace && workspaceMissing) {
      return { id: stage.id, label: stage.label, state: "skipped" as const };
    }
    const step = latest.get(stage.id);
    if (step) {
      finished += stage.weight;
      return {
        id: stage.id,
        label: stage.label,
        state: toState(step.status),
        ...(step.detail ? { detail: step.detail } : {}),
      };
    }
    // Everything the startup flow needs is behind "FRIDAY ready": a stage that never reported is not waited for.
    if (ready) return { id: stage.id, label: stage.label, state: "skipped" as const };
    if (!active) {
      active = stage;
      return { id: stage.id, label: stage.label, state: "active" as const };
    }
    return { id: stage.id, label: stage.label, state: "waiting" as const };
  });

  const percent = ready ? 100 : Math.min(99, Math.round((finished / total) * 100));
  const activeStage = active as BootStage | null;
  const activeShare = activeStage ? (activeStage.weight / total) * 100 : 0;
  const lastDone = [...rows].reverse().find((row) => row.state === "done" || row.state === "warn");
  return {
    percent,
    stages: rows,
    currentLabel: ready ? "Ready" : (activeStage?.label ?? "Finishing"),
    currentDetail: ready
      ? String(readyStep?.detail || "")
      : String(lastDone?.detail || "").slice(0, 120),
    ready,
    readyOk: ready && readyStep?.status !== "missing",
    blockers: ready && readyStep?.status === "missing" ? String(readyStep.detail || "") : "",
    headroom: ready ? 0 : activeShare,
  };
}

/**
 * The bar between two real reports. It never reaches the next stage on its own: a stage that has been running for
 * `msInStage` may show up to 85% of its own share, easing in (about 6 s to the first two thirds), so a long stage
 * still looks alive and a short one is never overtaken by the lie.
 */
export function creepPercent(progress: BootProgress, msInStage: number): number {
  if (progress.ready) return 100;
  const eased = 1 - Math.exp(-Math.max(0, msInStage) / 6000);
  return Math.min(99, progress.percent + progress.headroom * 0.85 * eased);
}

export type BootGate = "wait" | "leave" | "stuck";

export const BOOT_MIN_SHOWN_MS = 700;
export const BOOT_BLOCKED_LINGER_MS = 6000;
export const BOOT_STUCK_MS = 45_000;
export const BOOT_GIVE_UP_MS = 90_000;

/**
 * When the boot screen leaves.
 *  - "leave": FRIDAY reported ready (and it has been on screen long enough not to flash), a blocked start has
 *    shown its reason for a few seconds, or it has been far too long.
 *  - "stuck": slower than usual; the screen offers "continue" and keeps waiting.
 */
export function bootGate(
  progress: BootProgress,
  elapsedMs: number,
  sinceReadyMs: number,
): BootGate {
  if (elapsedMs >= BOOT_GIVE_UP_MS) return "leave";
  if (progress.ready) {
    if (progress.readyOk) return elapsedMs >= BOOT_MIN_SHOWN_MS ? "leave" : "wait";
    return sinceReadyMs >= BOOT_BLOCKED_LINGER_MS ? "leave" : "wait";
  }
  return elapsedMs >= BOOT_STUCK_MS ? "stuck" : "wait";
}
