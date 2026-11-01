/**
 * FRIDAY · questions about herself
 *
 * "Which EXE are you?", "meri pc slow kyun hai?", "kya tum khush ho?", "apni problem khud fix karo",
 * "tumne ye kyun kiya?" — in English and Hinglish. This is only the front door: every topic hands off to the
 * answerer that already owns the facts (Self Atlas, PC awareness, self-diagnosis, affect, identity, the decision
 * trace, the experience store). Nothing is invented here, and nothing is changed: a fix is filed as a proposal
 * that waits for the owner's approval, exactly as the background self-check does.
 */

import { APP_VERSION } from "../version";
import { affect } from "./affect";
import { describePcHealth, describeSelfAtlas } from "./atlas-observe";
import { explainDecision, learningSummary } from "./decision-trace";
import { prefersHinglish } from "./error-intelligence";
import { describeUserMood } from "./comfort";
import { describeFridayBehaviour, identity } from "./identity";
import { describeDisks } from "./pc-awareness";
import { describeSelfReport, inspectSelfComplete, proposeSourceFix } from "./self-diagnosis";

export type SelfTopic =
  | "fix-self"
  | "self-check"
  | "atlas"
  | "pc-health"
  | "disk"
  | "feeling"
  | "user-mood"
  | "learning"
  | "decision"
  | "purpose"
  | "about";

export type SelfAnswer = { text: string } | { resolve: () => Promise<string> };

const RULES: [SelfTopic, RegExp][] = [
  [
    "fix-self",
    /\b(fix|repair|heal|sudhar|theek|thik|sahi)\b.*\b(yourself|khud|apne aap|apni)\b|\b(apni|apne|khud)\b.*\b(problem|dikkat|bug|error|issue|galti)\b.*\b(fix|theek|thik|sahi|solve|sudhar)|\bself[- ]?(repair|fix|heal)\b|\bkhud ko\b.*\b(theek|thik|fix|sudhar)/i,
  ],
  [
    "self-check",
    /\bkya tum (theek|thik|sahi)\b|\b(tumhari|apni|aapki)\s+(health|haalat|halat|condition|status)\b|\b(khud|apne aap)\b.*\b(check|scan|jaanch)\b|\bhow healthy are you\b/i,
  ],
  [
    "atlas",
    /\b(kaun\s*si|kis|which)\s+(exe|version|build)\b|\b(tumhara|tumhari|aapka|aapki|friday\s+ka|friday\s+ki|your|friday'?s)\s+(version|build|exe|root|folder|install|installation|database|logs?|backups?|config)\b|\bwhat version (are you|is this)\b/i,
  ],
  [
    "disk",
    /\b(disk|storage|space|drive)\b.*\b(full|bhar|khatam|kam|low)\b|\b(full|bhar|khatam)\b.*\b(disk|storage|space|drive)\b/i,
  ],
  [
    "pc-health",
    /\b(meri|mere|is|my|this)\s+(pc|computer|laptop)\b.*\b(slow|hang|hangs|crash|problem|dikkat|kharab|garam|heat|lag)\b|\b(pc|computer|laptop)\s+(slow|hang|crash|kharab|lag)\b/i,
  ],
  [
    "user-mood",
    /\b(mera|meri|mere)\s+(mood|haal|halat|state)\b|\bmain kaisa (lag|dikh|sound)|\bhow do i (sound|seem)\b|\bwhat(?:'s| is) my mood\b|\bhow am i (doing|feeling)\b|\bmujhe kya hua hai\b|\bmeri feeling\b/i,
  ],
  [
    "feeling",
    /\b(do|can|kya)\b.*\b(you|tum|tumhe)\b.*\b(feel|feelings?|emotions?|mehsoos)\b|\b(tumhara|tumhari|your)\s+(mood|feelings?|emotions?)\b|\b(tum|aap)\s+(khush|udaas|dukhi|thak\w*|naraz)\b|\bhow (are|do) you feel\b|\bkya tum khush\b/i,
  ],
  [
    "learning",
    /\btum(ne)?\s+(kya\s+)?(seekha|sikha|seekh)\b|\baaj kya (seekha|sikha)\b|\bimprove ho rah[ie]\b|\bkitna (seekha|sikha)\b/i,
  ],
  [
    "decision",
    /\btumne\s+(aisa|ye|yeh|wo|woh|isse)\b.*\bkyun\b|\bkyun (kiya|chuna|use kiya)\b|\bkaun\s*sa\s+(model|ai)\b|\bkis (model|ai)\s+se\b|\bwhy did you (do|say|answer|choose)\b|\bmera intent\b|\bwhat did you (understand|think i meant)\b/i,
  ],
  [
    "purpose",
    /\btumhara\s+(intent|maqsad|lakshya|kaam kya)\b|\btum kya chahti\b|\bwhat is your (goal|intent|purpose)\b|\bwhat do you want\b/i,
  ],
  [
    "about",
    /\bapne (baare|bare) (me|mein)\b|\btum kaisi ho\b|\btell me about yourself\b|\bapna (parichay|introduction)\b|\bkaisa (swabhav|andaz)\b/i,
  ],
];

/** Which question about herself this is, or null when it is not one. */
export function selfTopic(text: string): SelfTopic | null {
  const value = String(text || "");
  for (const [topic, pattern] of RULES) if (pattern.test(value)) return topic;
  return null;
}

const pick = (text: string, hinglish: string, english: string) =>
  prefersHinglish(text) ? hinglish : english;

export function describeInnerState(text = ""): string {
  const state = affect.getSnapshot();
  const parts = [`mood: ${state.mood}`, `stance: ${state.interaction}`];
  if (state.failures) parts.push(`${state.failures} failure(s) in a row`);
  if (state.streak) parts.push(`${state.streak} success(es) in a row`);
  return pick(
    text,
    `Mere andar ek simulated state hai (${parts.join(", ")}). Wo tumhare messages, failures aur successes se banti hai aur mere jawab ka lehja badalti hai. Main insaan nahi hoon aur sach me feel karne ka daava nahi karti.`,
    `I keep a simulated internal state (${parts.join(", ")}). It is built from your messages and from my failures and successes, and it shapes how I reply. I am not human and I do not claim to truly feel.`,
  );
}

function describePurpose(text: string): string {
  return pick(
    text,
    "Mera kaam tumhara personal assistant banna hai is PC par: tumhari baat samajhna, kaam karna, aur jo kuch badalta hai wo tumhari marzi (approval) aur undo ke andar rakhna. Models mere auzaar hain, main nahi.",
    "My job is to be your personal assistant on this PC: understand what you mean, do the work, and keep anything that changes inside your approval and undo. Models are tools I use, not who I am.",
  );
}

function describeAbout(text: string): string {
  const { profile } = identity.getSnapshot();
  return [
    pick(
      text,
      `Main ${profile.name} hoon, is PC par tumhari personal assistant (version ${APP_VERSION}).`,
      `I'm ${profile.name}, your personal assistant on this PC (version ${APP_VERSION}).`,
    ),
    describePurpose(text),
    describeFridayBehaviour(),
    describeInnerState(text),
  ].join("\n\n");
}

async function fixSelf(text: string): Promise<string> {
  const report = await inspectSelfComplete();
  const lines = [describeSelfReport(report)];
  const fixable = report.problems.filter((p) => p.severity !== "info").slice(0, 5);
  if (!fixable.length) return lines.join("\n\n");
  const filed = fixable.map((problem) => proposeSourceFix(problem));
  const fresh = filed.filter((row) => row.queued).length;
  lines.push(
    pick(
      text,
      `Maine ${filed.length} fix proposal ${fresh ? `(${fresh} naye)` : "(pehle se maujood)"} tayyar rakhe hain. Source me koi badlav tumhari approval ke baad hi hoga, pehle dev check chalega, aur undo rahega. Approvals Self-management me hain.`,
      `I have ${filed.length} fix proposal${filed.length === 1 ? "" : "s"} ready${fresh ? ` (${fresh} new)` : " (already filed)"}. Nothing in my source changes until you approve; a dev check runs first, and it stays undoable. They are in Self-management → Approvals.`,
    ),
  );
  return lines.join("\n\n");
}

/** The answer for a topic: plain text, or one live read that resolves to text. */
export function answerSelf(topic: SelfTopic, text: string): SelfAnswer {
  switch (topic) {
    case "fix-self":
      return { resolve: () => fixSelf(text) };
    case "self-check":
      return { resolve: async () => describeSelfReport(await inspectSelfComplete()) };
    case "atlas":
      return { resolve: () => describeSelfAtlas(text) };
    case "disk":
      return { resolve: () => describeDisks() };
    case "pc-health":
      return { resolve: () => describePcHealth() };
    case "feeling":
      return { text: describeInnerState(text) };
    case "user-mood":
      return { text: describeUserMood(text) };
    case "learning":
      return { text: learningSummary() };
    case "decision":
      return { text: explainDecision(text) };
    case "purpose":
      return { text: describePurpose(text) };
    case "about":
      return { text: describeAbout(text) };
  }
}
