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
import { confirmationVerdict } from "../voice-session";
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
  /\b(delete|remove|erase|format|wipe|uninstall|install|update|upgrade|reinstall|shutdown|shut down|restart|reboot|kill|terminate|stop\s+service|run|execute|launch|build|rebuild|deploy|publish|overwrite|rename|move|copy|write|save\s+file|create\s+file|download|fetch|git\s+(clone|push|reset|clean)|pull\s+model|npm|pip|powershell|cmd|registry|disable|enable\s+service|purchase|buy|pay|subscribe|hata\s*do|hata\s*dena|hatao|mita\s*do|mita\s*dena|mitao|saaf\s*kar|uda\s*do|udao|nikal\s*do|khatam\s*kar|band\s*kar(?:o|na|do)|bhej\s*do|bhejo|kharid(?:o|na)|bharo|payment\s*kar|order\s*(?:kar|karo|kardo|do|de\s*do)|place\s+(?:an?\s+)?order|book\s*kar(?:o|do)?|transfer\s*kar(?:o|do)?)\b/i;

/** A yes answer: only what the one table in voice-session.ts reads as a yes (it reads it lazily, so no import cycle). */
export const AFFIRM: { test(value: string): boolean } = {
  test: (value) => confirmationVerdict(value) === "yes",
};

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

/**
 * Asking for text FRIDAY will write in the chat ("write a python script that prints primes", "draft an email")
 * changes nothing on the machine. Those phrases are set aside before the words above are looked for; "write file",
 * "save file", "run it" and the rest still count.
 */
const GENERATION =
  /\b(?:write|create|make|build|give|draft|compose|generate)\s+(?:me\s+)?(?:an?\s+|the\s+|some\s+)?(?:[\w+#-]+\s+){0,2}(?:script|function|program|snippet|code|class|query|regex|email|mail|letter|poem|essay|story|summary|message|reply|joke|caption|post)\b/gi;

export function isConsequential(text: string): boolean {
  return CONSEQUENTIAL.test(String(text ?? "").replace(GENERATION, " "));
}

/**
 * Typing a password, PIN, OTP or card number for the owner. UAC, a password field and a payment are never read,
 * clicked or typed by FRIDAY, whatever the mode or the autonomy dial says; the owner enters them himself.
 */
const CREDENTIAL_ENTRY =
  /\b(password|passcode|pin|otp|cvv|card\s*number|card\s*details|upi\s*pin)\b.*\b(bhar|daal|dal|type|enter|fill|likh|bhej|share|put|bata)(?:o|na|ni|do|de|dena|iye|kar|karo)?\b|\b(type|enter|fill|put|daal|daalo|bharo|likho)\b.*\b(password|passcode|otp|cvv|card\s*number|card\s*details|upi\s*pin)\b/i;

/** Logging in or filling a payment form for the owner: a password or a card comes next, so it is asked first. */
const LOGIN_OR_PAYMENT =
  /\b(?:log\s*in|login|sign\s*in|signin)\s+(?:to|into|kar|karo|kardo|kar\s*do|me|mein|for)\b|\b(?:fill|enter|type|complete|submit)\b.*\b(?:payment|checkout|billing|bank)\s*(?:form|page|details)\b|\b(?:enter|type|fill|share)\b.*\b(?:bank|card|payment)\s*details\b/i;

/** The same nouns and verbs in Devanagari: a spoken Hindi turn reaches here in Devanagari script. */
const DEVANAGARI_SECRET = /पासवर्ड|पासकोड|ओटीपी|पिन|सीवीवी|कार्ड\s*नंबर|यूपीआई\s*पिन/u;
const DEVANAGARI_ENTRY = /भर|डाल|लिख|टाइप|भेज|बता|एंटर|लॉग\s*इन|लॉगिन|साइन\s*इन/u;
const DEVANAGARI_LOGIN = /(?:लॉग\s*इन|लॉगिन|साइन\s*इन)\s*(?:कर|करो|कर\s*दो)/u;
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff]/g;

/** NFKC (full-width and compatibility forms fold to plain letters), lower case, no zero-width characters. */
function foldCredentialText(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .toLowerCase();
}

/**
 * An early ask only: the hard refusal to read or type a secret field is the kernel's secure-input guard. A
 * question about passwords or a bug in a login page does not match; asking FRIDAY to enter one does.
 */
export function isCredentialEntry(text: string): boolean {
  const folded = foldCredentialText(text);
  if (CREDENTIAL_ENTRY.test(folded) || LOGIN_OR_PAYMENT.test(folded)) return true;
  if (DEVANAGARI_LOGIN.test(folded)) return true;
  return DEVANAGARI_SECRET.test(folded) && DEVANAGARI_ENTRY.test(folded);
}

/** Words that destroy or switch things off. These are confirmed in Auto mode too, however sure FRIDAY is. */
const DESTRUCTIVE =
  /\b(delete|erase|format|wipe|uninstall|shutdown|shut down|reboot|kill|terminate|overwrite|hata\s*do|hata\s*dena|hatao|mita\s*do|mita\s*dena|mitao|saaf\s*kar|uda\s*do|udao|khatam\s*kar)\b/i;

export function isDestructive(text: string): boolean {
  return DESTRUCTIVE.test(String(text ?? ""));
}

/** A spoken/typed command: does it have to be confirmed before dispatch? */
export function commandNeedsApproval(text: string, mode: AssistantModeName = currentMode): boolean {
  if (mode === "manual") return true;
  // Ask every time means every time, as on the voice path.
  if (autonomy.getSnapshot().approvalLevel === "strict") return true;
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
  if (settings.approvalLevel === "strict") return true;
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
