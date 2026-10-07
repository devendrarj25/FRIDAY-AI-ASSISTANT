// FRIDAY · skill: meeting-notes
// Runs inside the sandbox harness, which calls run(input).
// Pure text processing — deterministic, offline, no network.

const ACTION =
  /\b(will|shall|to do|todo|action|follow[- ]?up|assign(?:ed)?|owner|by (?:mon|tue|wed|thu|fri|sat|sun|\d))/i;
const DECISION = /\b(decided|decision|agreed|approved|rejected|we will go with|final)\b/i;
const QUESTION = /\?\s*$|^\s*(q:|question:|open:)/i;
const OWNER = /\b([A-Z][a-z]{1,20})\b\s+(?:will|to|owns|takes|handles)\b/;
const DATE =
  /\b(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?|mon|tue|wed|thu|fri|sat|sun|today|tomorrow|next week|eod|eow)\b/i;

function sentences(text) {
  return String(text || "")
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

export async function run(input = {}) {
  const lines = sentences(input.text);
  if (!lines.length) return { ok: false, error: "No transcript text was provided." };

  const decisions = [];
  const actions = [];
  const questions = [];
  const notes = [];

  for (const line of lines) {
    if (DECISION.test(line)) decisions.push(line);
    else if (ACTION.test(line))
      actions.push({
        item: line,
        owner: (line.match(OWNER) || [])[1] || null,
        due: (line.match(DATE) || [])[1] || null,
      });
    else if (QUESTION.test(line)) questions.push(line);
    else notes.push(line);
  }

  const markdown = [
    `# ${input.title || "Meeting notes"}`,
    "",
    "## Decisions",
    decisions.length ? decisions.map((d) => `- ${d}`).join("\n") : "- (none recorded)",
    "",
    "## Action items",
    actions.length
      ? actions
          .map(
            (a) =>
              `- [ ] ${a.item}${a.owner ? ` — **${a.owner}**` : ""}${a.due ? ` (due ${a.due})` : ""}`,
          )
          .join("\n")
      : "- (none recorded)",
    "",
    "## Open questions",
    questions.length ? questions.map((q) => `- ${q}`).join("\n") : "- (none recorded)",
    "",
    "## Other notes",
    notes
      .slice(0, 40)
      .map((n) => `- ${n}`)
      .join("\n"),
    "",
  ].join("\n");

  return {
    title: input.title || "Meeting notes",
    counts: {
      lines: lines.length,
      decisions: decisions.length,
      actions: actions.length,
      questions: questions.length,
    },
    decisions,
    actions,
    questions,
    markdown,
  };
}

export default run;
