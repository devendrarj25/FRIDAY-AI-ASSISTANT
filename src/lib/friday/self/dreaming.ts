/**
 * FRIDAY · dreaming pass
 *
 * Once a day, in idle time, FRIDAY looks back over what she actually did: the checked successes in her
 * experience log. An approach that worked, was verified, and recurred is written down as one proposed memory
 * ("when asked X, this worked: tools, model, how often"). Nothing is saved on its own: each proposal goes
 * through governance and waits for the owner's dial, so a lucky run cannot become a lesson by itself.
 * Failures are not handled here; `failure-patterns.ts` already mines and files those.
 */

import { experiences, type Experience } from "./task-ledger";
import { governance } from "./governance";
import { memory } from "./memory-engine";
import { routinesNow } from "./routines";

export type Dream = {
  id: string;
  approach: string;
  title: string;
  count: number;
  tools: string[];
  models: string[];
  evidence: string[];
  text: string;
};

const DAY = 24 * 60 * 60 * 1000;
export const DREAM_MIN_RUNS = 3;

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

/** Pure: which recurring, verified successes in the window deserve a memory proposal. */
export function dreamsFrom(rows: readonly Experience[], now: number, windowMs = 7 * DAY): Dream[] {
  const groups = new Map<string, Experience[]>();
  for (const row of rows) {
    if (!row.success || !row.verified) continue;
    if (row.at < now - windowMs || row.at > now) continue;
    if (!row.approach) continue;
    const list = groups.get(row.approach) ?? [];
    list.push(row);
    groups.set(row.approach, list);
  }
  const out: Dream[] = [];
  for (const [approach, list] of groups) {
    if (list.length < DREAM_MIN_RUNS) continue;
    const tools = [...new Set(list.flatMap((row) => row.tools))].slice(0, 6);
    const models = [...new Set(list.flatMap((row) => row.models.map((model) => model.id)))].slice(
      0,
      3,
    );
    const title = list[0]?.title ?? approach;
    out.push({
      id: `dream-${slug(approach)}`,
      approach,
      title,
      count: list.length,
      tools,
      models,
      evidence: list.slice(0, 5).map((row) => row.taskId),
      text: `For "${title}" this approach worked ${list.length} times and was checked${
        tools.length ? `; tools: ${tools.join(", ")}` : ""
      }${models.length ? `; models: ${models.join(", ")}` : ""}.`,
    });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 5);
}

/** File each dream once. The memory is written only after the owner's approval path opens. */
export function fileDreams(list: readonly Dream[]): number {
  let filed = 0;
  for (const dream of list) {
    if (governance.get(dream.id)) continue;
    filed += 1;
    void governance
      .submit({
        id: dream.id,
        kind: "research",
        title: `Remember: ${dream.title}`.slice(0, 100),
        rationale: dream.text,
        risk: "review",
        evidence: dream.evidence.map((id) => `task ${id}`),
        dryRun: async () => ({
          ok: true,
          detail: "one semantic memory will be written, marked as learned",
        }),
        apply: async () => {
          memory.remember({
            tier: "semantic",
            title: `What worked — ${dream.title}`.slice(0, 100),
            text: dream.text,
            tags: ["dreaming", "what-worked"],
            source: "dreaming",
            confidence: 0.6,
            kind: "procedural",
          });
          return { ok: true, detail: "memory written" };
        },
      })
      .catch(() => undefined);
  }
  return filed;
}

export function dreamNow(now = Date.now()): { found: number; filed: number } {
  const found = dreamsFrom(experiences.list(500), now);
  const routines = routinesNow(now);
  return { found: found.length + routines.found, filed: fileDreams(found) + routines.filed };
}
