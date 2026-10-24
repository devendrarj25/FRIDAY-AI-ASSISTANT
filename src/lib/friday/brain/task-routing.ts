/**
 * The Models page "Task routing" table, made real.
 *
 * The owner assigns a model to a kind of job (brain, coding, reasoning, vision,
 * fast). The main-process router only ever saw the chat picker, so those
 * assignments were decoration. This turns the assignment for the job a prompt
 * looks like into router row ids, as a PREFERENCE: the router still applies
 * mode, privacy, both firewalls and health, and a model it rejects is skipped.
 * Only a local or free model is ever offered this way, so a stale assignment
 * can never spend money.
 */
import {
  modelById,
  registryRowMatches,
  type RegistryRowRef,
  type RoutingTask,
} from "../model-catalog";

export const CODE_RE =
  /\b(code|bug|error|refactor|compile|build|typescript|python|script|function)\b/i;
export const REASON_RE =
  /\b(why|plan|design|compare|analyse|analyze|decide|strategy|architecture)\b/i;
export const RESEARCH_RE = /\b(research|summari[sz]e|literature|whitepaper|survey of)\b/i;
export const VISION_RE = /\b(image|screenshot|picture|photo|diagram)\b/i;

export function taskOfPrompt(prompt: string): RoutingTask {
  if (CODE_RE.test(prompt)) return "coding";
  if (REASON_RE.test(prompt)) return "reasoning";
  if (VISION_RE.test(prompt)) return "vision";
  if (RESEARCH_RE.test(prompt)) return "research";
  return "brain";
}

export type TaskRow = RegistryRowRef & {
  type?: string | undefined;
  access?: string | undefined;
  available?: boolean | undefined;
  eligible?: boolean | undefined;
};

/** Router row ids to prefer for this turn, best first. Empty means "no preference". */
export function taskPreference(input: {
  prompt: string;
  surface: "voice" | "chat";
  routing: Partial<Record<RoutingTask, string | null>>;
  rows: readonly TaskRow[];
}): string[] {
  const task = taskOfPrompt(input.prompt);
  // Spoken turns lead with the fast model: a quick reply matters more than depth.
  const order: RoutingTask[] =
    input.surface === "voice" && task === "brain" ? ["fast", "brain"] : [task, "brain"];
  const usable = input.rows.filter(
    (row) =>
      row.available !== false &&
      row.eligible !== false &&
      (row.type === "local" || row.access === "free"),
  );
  const out: string[] = [];
  for (const key of order) {
    const assigned = input.routing[key];
    const spec = assigned ? modelById.get(assigned) : undefined;
    if (!spec) continue;
    const row = usable.find((candidate) => registryRowMatches(spec, candidate));
    if (row && !out.includes(row.id)) out.push(row.id);
  }
  return out;
}
