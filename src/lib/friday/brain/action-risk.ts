/**
 * FRIDAY · action risk + approval policy (single source of truth).
 *
 * Manual mode — FRIDAY never performs an action without the owner saying yes.
 * Auto mode  — routine, read-only work runs on its own; anything irreversible,
 *              costly, paid or system-level still pauses for approval.
 *
 * The voice path (assistant-mode.ts) and the typed chat path (brain-engine.ts)
 * both read this module, so a command is judged identically no matter how it
 * arrived. Nothing here executes anything — it only classifies and decides.
 */

import { autonomy } from "../self/autonomy";
import { isRoutineTerminalCommand } from "../terminal-command";
import { isRoutineSandboxCommand, extractSandboxRun } from "../sandbox-command";

export type AssistantModeName = "manual" | "auto";

/** Risk tiers, matching the kernel's tool tiers and core/permissions. */
export type ActionRisk = "safe" | "write" | "exec";

/**
 * Words that make a command consequential: anything touching the OS, files,
 * processes, installs, money or the FRIDAY build itself must be confirmed.
 */
export const CONSEQUENTIAL =
  /\b(delete|remove|erase|format|wipe|uninstall|install|update|upgrade|reinstall|shutdown|shut down|restart|reboot|kill|terminate|stop\s+service|run|execute|launch|build|rebuild|deploy|publish|overwrite|rename|move|copy|write|save\s+file|create\s+file|download|fetch|git\s+(clone|push|reset|clean)|pull\s+model|npm|pip|powershell|cmd|registry|disable|enable\s+service|purchase|buy|pay|subscribe)\b/i;

export const AFFIRM =
  /\b(yes|yeah|yep|confirm|confirmed|do it|go ahead|proceed|haan|haa|thik hai|ok|okay)\b/i;
export const DENY = /\b(no|nope|cancel|stop|abort|don'?t|nahi|nahin|reject)\b/i;

/**
 * The live mode. assistant-mode.ts owns the user-facing switch and mirrors it
 * here so the chat pipeline can read it without importing the voice store
 * (which would create an import cycle).
 */
let currentMode: AssistantModeName = "auto";

export function setActionMode(mode: AssistantModeName): void {
  currentMode = mode === "manual" ? "manual" : "auto";
}

export function actionMode(): AssistantModeName {
  return currentMode;
}

export function isConsequential(text: string): boolean {
  return CONSEQUENTIAL.test(text ?? "");
}

/** A spoken/typed command: does it have to be confirmed before dispatch? */
export function commandNeedsApproval(text: string, mode: AssistantModeName = currentMode): boolean {
  if (mode === "manual") return true;
  // Auto Mode runs routine workspace checks/tests without a pause.
  // Installs / deletes / git push still match CONSEQUENTIAL (or exec risk).
  if (isRoutineTerminalCommand(text) || isRoutineSandboxCommand(text)) return false;
  const sandbox = extractSandboxRun(text);
  if (sandbox) return sandbox.risk !== "safe";
  return isConsequential(text);
}

/**
 * A concrete tool/skill invocation: does it have to be confirmed before it
 * runs? Manual mode gates every action; auto mode lets read-only work through.
 */
export function actionNeedsApproval(
  risk: ActionRisk | undefined,
  mode: AssistantModeName = currentMode,
): boolean {
  const settings = autonomy.getSnapshot();
  if (settings.halted) return true;
  if (settings.approvalLevel === "full") return false;
  if (mode === "manual") return true;
  return (risk ?? "exec") !== "safe";
}

/**
 * Brain Personality → "Confirm important changes" on top of the shared
 * policy. Write/exec still always pause in Auto Mode. When the toggle is on,
 * a consequential phrasing of a safe-looking tool also pauses. The toggle
 * cannot skip write/exec.
 */
export function brainActionNeedsApproval(
  risk: ActionRisk | undefined,
  mode: AssistantModeName = currentMode,
  options: { confirmImportant?: boolean; prompt?: string } = {},
): boolean {
  if (actionNeedsApproval(risk, mode)) return true;
  if (!options.confirmImportant) return false;
  if ((risk ?? "exec") !== "safe") return true;
  // "Confirm important changes" must not re-ask for `run npm test` just because
  // the sentence contains "run" / "npm". Installs still pause (exec risk).
  if (
    options.prompt &&
    (isRoutineTerminalCommand(options.prompt) || isRoutineSandboxCommand(options.prompt))
  )
    return false;
  return Boolean(options.prompt && isConsequential(options.prompt));
}

/**
 * Autonomy classes from the Manual/Auto policy. Mode never bypasses a
 * destructive, external, secret, or policy action.
 */
export type AutonomyClass =
  "read" | "reversible" | "background" | "external" | "destructive" | "secret" | "policy";

export function autonomyAllows(
  action: AutonomyClass,
  mode: AssistantModeName,
): "run" | "approve" | "block" {
  if (action === "policy") return "block";
  const settings = autonomy.getSnapshot();
  if (settings.halted) return "block";
  if (settings.approvalLevel === "full") return action === "secret" ? "approve" : "run";
  if (mode === "manual") return "approve";
  if (action === "read" || action === "background") return "run";
  return "approve";
}

/** Why the approval prompt is being shown — used verbatim in chat and voice. */
export function approvalReason(
  risk: ActionRisk | undefined,
  mode: AssistantModeName = currentMode,
): string {
  if (mode === "manual") return "Manual mode: every action needs your approval before it runs.";
  return risk === "exec"
    ? "This can change files, apps or system state."
    : "This writes to your machine.";
}
