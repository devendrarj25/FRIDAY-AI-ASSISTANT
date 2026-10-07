/**
 * Phrase matchers for the live wiring visualizer.
 *
 * Kept free of flow-chart / assistant-mode imports so chat and voice can
 * recognise "show me the system wiring" without a module cycle.
 */

const WIRING_SHOW =
  /\b((show|open|display|see)\b.{0,40}\b(system wiring|wiring diagram|wiring (visuali[sz]er|panel)|flow chart|system (flow|diagram))|system wiring|wiring diagram|wiring (visuali[sz]er|panel))\b/i;

const LOCKED_SWITCH_ASK =
  /\b(disable|turn off|bypass|remove|switch off|unlock)\b.{0,80}\b(permission(s| broker)?|privacy( firewall)?|governance|owner approval|billing( firewall)?|tool[- ]authority|approval (gate|code))\b/i;

export function looksLikeWiringQuestion(text: string): boolean {
  return WIRING_SHOW.test(text ?? "");
}

export function looksLikeLockedWiringSwitch(text: string): boolean {
  return LOCKED_SWITCH_ASK.test(text ?? "");
}
