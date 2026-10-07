/** Screen or camera text joins a turn only when the owner asked. It is not stored. */

export function conversationSight(input: { asked: boolean; handoff: boolean; text: string }): {
  text: string;
  stored: false;
  instruction: false;
} {
  if (!input.asked || input.handoff) return { text: "", stored: false, instruction: false };
  const clean = String(input.text || "")
    .replace(/password\s*[:=]\s*\S+/gi, "")
    .trim()
    .slice(0, 240);
  return { text: clean, stored: false, instruction: false };
}
