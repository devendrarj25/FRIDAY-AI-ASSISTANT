/**
 * One spoken turn, stage by stage: heard -> routed -> model -> reply -> spoken.
 *
 * Each stage has a timestamp and, when it failed or was skipped, the plain
 * reason. Silence after a transcript is then a named stage, not a mystery.
 * Counts and reasons only: no transcript text is stored here.
 */

export const TURN_STAGES = ["heard", "routed", "model", "reply", "spoken"] as const;
export type TurnStage = (typeof TURN_STAGES)[number];

export type TurnStageRow = {
  stage: TurnStage;
  at: number;
  ok: boolean;
  /** Empty when the stage went through. */
  reason: string;
  /** Short fact about the stage, such as the model or the speaking engine. */
  detail: string;
};

export type VoiceTurn = { startedAt: number; rows: TurnStageRow[] };

let current: VoiceTurn | null = null;
let last: VoiceTurn | null = null;

/** A new heard transcript starts a new turn. The previous one is kept as `last`. */
export function beginVoiceTurn(now = Date.now()): void {
  if (current) last = current;
  current = { startedAt: now, rows: [] };
}

export function markTurnStage(
  stage: TurnStage,
  ok: boolean,
  reason = "",
  detail = "",
  now = Date.now(),
): void {
  if (!current) beginVoiceTurn(now);
  const turn = current as VoiceTurn;
  const existing = turn.rows.findIndex((row) => row.stage === stage);
  const row: TurnStageRow = { stage, at: now, ok, reason: ok ? "" : reason, detail };
  if (existing >= 0) {
    // A stage that already failed keeps its reason: the later retry must not hide it.
    if (!turn.rows[existing]?.ok && ok) return;
    turn.rows[existing] = row;
  } else {
    turn.rows.push(row);
  }
}

export function voiceTurn(): VoiceTurn | null {
  return current ?? last;
}

export function resetVoiceTurns(): void {
  current = null;
  last = null;
}

/** The first stage that failed, or the first one that never ran after a transcript. */
export function whereItStopped(
  turn: VoiceTurn | null,
): { stage: TurnStage; reason: string } | null {
  if (!turn) return null;
  for (const stage of TURN_STAGES) {
    const row = turn.rows.find((item) => item.stage === stage);
    if (!row) return { stage, reason: "never reached" };
    if (!row.ok) return { stage, reason: row.reason || "failed" };
  }
  return null;
}

export function turnTraceLine(turn: VoiceTurn | null): string {
  if (!turn || !turn.rows.length) return "no turn yet";
  const parts = TURN_STAGES.map((stage) => {
    const row = turn.rows.find((item) => item.stage === stage);
    if (!row) return `${stage} –`;
    const at = `+${Math.max(0, row.at - turn.startedAt)}ms`;
    if (!row.ok) return `${stage} ✗ ${at} (${row.reason || "failed"})`;
    return `${stage} ✓ ${at}${row.detail ? ` (${row.detail})` : ""}`;
  });
  return parts.join(" → ");
}
