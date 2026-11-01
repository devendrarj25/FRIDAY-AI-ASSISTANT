/**
 * FRIDAY · what she is doing right now, in plain words.
 *
 * One pure function turns the newest real trace step (its node and its real
 * detail text) into a verb the owner can read: "Searching the web", "Reading
 * report.pdf", "Zipping", "Writing the answer". It never invents work: with no
 * step it returns null, and with an unknown step it falls back to the step's
 * own label. The rules are a table, so a new kind of work is one more row.
 */

import type { TurnTraceStep } from "@/lib/friday/brain/turn-trace";

export type ActivityKind =
  | "searching"
  | "reading"
  | "writing"
  | "zipping"
  | "unzipping"
  | "running"
  | "thinking"
  | "planning"
  | "choosing"
  | "recalling"
  | "checking"
  | "waiting"
  | "answering";

export type LiveActivity = {
  kind: ActivityKind;
  /** Short phrase for a chip: "Searching the web". */
  verb: string;
  /** The thing being worked on, when the detail names one. */
  subject: string;
  /** Mood that fits the work, for the graphic. */
  emotion: string;
};

type Rule = { test: RegExp; kind: ActivityKind; verb: string };

/** Detail text wins over the node, because it says what really happened. */
const DETAIL_RULES: Rule[] = [
  {
    test: /\bweb search\b|\bsearching\b|\bgoogle\b|\bbrowse\b/i,
    kind: "searching",
    verb: "Searching the web",
  },
  { test: /\bunzip|\bextract(ing)?\b|\bunpack/i, kind: "unzipping", verb: "Unzipping" },
  { test: /\bzip(ping)?\b|\barchive\b|\bcompress/i, kind: "zipping", verb: "Zipping" },
  {
    test: /\bread(ing)?\b|\bopen(ing)? (the )?(file|document|pdf)\b|\bparsing\b|\bocr\b/i,
    kind: "reading",
    verb: "Reading",
  },
  {
    test: /\bwrit(e|ing)\b|\bsav(e|ing)\b|\bcreat(e|ing) (a )?file\b|\bexport(ing)?\b/i,
    kind: "writing",
    verb: "Writing",
  },
  {
    test: /\brunning\b|\bexecut(e|ing)\b|\blaunch(ing)?\b|\bconnector\b/i,
    kind: "running",
    verb: "Running",
  },
  {
    test: /\bwaiting for (you|approval)\b|\bapproval\b/i,
    kind: "waiting",
    verb: "Waiting for your approval",
  },
];

const NODE_RULES: Array<{ prefix: string; kind: ActivityKind; verb: string }> = [
  { prefix: "thinking.planner", kind: "planning", verb: "Planning the steps" },
  { prefix: "thinking.context", kind: "recalling", verb: "Gathering context" },
  { prefix: "memory.", kind: "recalling", verb: "Recalling memory" },
  { prefix: "thinking.", kind: "thinking", verb: "Thinking" },
  { prefix: "router.select", kind: "choosing", verb: "Choosing a model" },
  { prefix: "orchestrator.collaboration", kind: "choosing", verb: "Asking several models" },
  { prefix: "orchestrator.report", kind: "answering", verb: "Writing the summary" },
  { prefix: "orchestrator.", kind: "planning", verb: "Coordinating" },
  { prefix: "verify.", kind: "checking", verb: "Checking the answer" },
  { prefix: "agents.skills", kind: "running", verb: "Using a skill" },
  { prefix: "agents.tools", kind: "running", verb: "Picking a tool" },
  { prefix: "agents.", kind: "running", verb: "Asking an agent" },
  { prefix: "execution.", kind: "running", verb: "Running a tool" },
];

const EMOTION: Record<ActivityKind, string> = {
  searching: "Curious",
  reading: "Attentive",
  writing: "Focused",
  zipping: "Concentrating",
  unzipping: "Concentrating",
  running: "Concentrating",
  thinking: "Thoughtful",
  planning: "Focused",
  choosing: "Focused",
  recalling: "Thoughtful",
  checking: "Careful",
  waiting: "Cautious",
  answering: "Content",
};

/** The file, tool or topic a detail names: the last quoted or file-like piece. */
export function subjectOf(detail: string): string {
  const text = String(detail || "");
  const quoted = text.match(/[“"']([^“”"']{2,60})[”"']/);
  if (quoted?.[1]) return quoted[1].trim();
  const file = text.match(
    /[\w.\-:\\/]{1,60}\.(?:pdf|docx?|xlsx?|csv|txt|md|json|zip|png|jpe?g|py|tsx?|cjs|html)\b/i,
  );
  if (file?.[0]) return file[0].trim().split(/[\\/]/).pop() ?? "";
  const named = text.match(
    /\b(?:running|reading|writing|connector|using)\s+([A-Za-z][\w .:-]{1,40})/i,
  );
  return named?.[1]?.trim() ?? "";
}

/**
 * What she is doing now. `streaming` is true once answer text is arriving,
 * which is the one case where a long "router.select" step really means she is
 * writing, not choosing.
 */
export function describeActivity(
  step: Pick<TurnTraceStep, "nodeId" | "detail" | "label"> | null | undefined,
  options: { streaming?: boolean } = {},
): LiveActivity | null {
  if (options.streaming) {
    return {
      kind: "answering",
      verb: "Writing the answer",
      subject: "",
      emotion: EMOTION.answering,
    };
  }
  if (!step) return null;
  const detail = step.detail || "";
  const subject = subjectOf(detail);
  for (const rule of DETAIL_RULES) {
    if (rule.test.test(detail)) {
      const verb =
        subject && rule.kind !== "searching" && rule.kind !== "waiting"
          ? `${rule.verb} ${subject}`
          : rule.verb;
      return { kind: rule.kind, verb, subject, emotion: EMOTION[rule.kind] };
    }
  }
  for (const rule of NODE_RULES) {
    if (step.nodeId.startsWith(rule.prefix)) {
      return { kind: rule.kind, verb: rule.verb, subject, emotion: EMOTION[rule.kind] };
    }
  }
  return { kind: "thinking", verb: step.label || "Working", subject, emotion: EMOTION.thinking };
}

/** "Searching the web… 12s": a long step says how long, so it never looks stuck or fake. */
export function activityLine(activity: LiveActivity, elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  return seconds >= 5 ? `${activity.verb}… ${seconds}s` : `${activity.verb}…`;
}
