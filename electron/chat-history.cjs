/**
 * FRIDAY · conversation history for the model
 *
 * A model only knows what is in the request. Without the earlier turns every
 * message arrives as a stranger's first one, so "yes, do that", "the same
 * one" or "and the other?" mean nothing and the answer reads like a chatbot
 * that forgot you. The desktop sends the recent turns of the one shared
 * thread (Chat and Voice write to the same list) and this file is the single
 * place that checks them before they reach the kernel.
 *
 *   * only the two roles a model understands; `friday` is the assistant;
 *   * each line and the whole window are bounded, newest kept;
 *   * lines that look sensitive are flagged, and the kernel keeps them off
 *     any cloud model (the privacy firewall also covers history);
 *   * the turn being asked now is never repeated inside its own history.
 */

const MAX_TURNS = 24;
const MAX_LINE = 700;
const MAX_TOTAL = 9000;

function role(value) {
  const text = String(value || "").toLowerCase();
  if (text === "user") return "user";
  if (text === "assistant" || text === "friday") return "assistant";
  return "";
}

/** The bounded, ordered history, or []. `prompt` is the turn asked now. */
function sanitiseHistory(raw, prompt = "") {
  if (!Array.isArray(raw)) return [];
  const rows = [];
  for (const item of raw) {
    const who = role(item?.role);
    const text = String(item?.text ?? item?.content ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!who || !text) continue;
    rows.push({
      role: who,
      text: text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1)}…` : text,
      ...(item?.sensitive === true ? { sensitive: true } : {}),
    });
  }
  // The question being asked is sent as the request itself, not as history.
  const asked = String(prompt || "")
    .replace(/\s+/g, " ")
    .trim();
  while (
    rows.length &&
    rows[rows.length - 1].role === "user" &&
    asked &&
    rows[rows.length - 1].text.startsWith(asked.slice(0, MAX_LINE - 1))
  ) {
    rows.pop();
  }
  const recent = rows.slice(-MAX_TURNS);
  let total = 0;
  const kept = [];
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const row = recent[index];
    if (kept.length && total + row.text.length > MAX_TOTAL) break;
    total += row.text.length;
    kept.unshift(row);
  }
  return kept;
}

module.exports = { sanitiseHistory, MAX_TURNS, MAX_LINE, MAX_TOTAL };
