/**
 * FRIDAY · calm notices from the PC reliability report
 *
 * A pure decision: which reliability rows are worth one short line to the owner. A row is raised
 * only when it turns worse than it was, and a row that was already bad when FRIDAY first looked
 * is raised once. The same row is not raised again inside the quiet window, however often the
 * shared poller publishes a report. Nothing here reads the machine or starts a timer.
 */

import type { ReliabilityItem, ReliabilityReport } from "./self-atlas";

export const NOTICE_QUIET_MS = 6 * 60 * 60 * 1000;

const RANK = { unknown: 0, ok: 0, warn: 1, bad: 2 } as const;

export type AtlasNotice = {
  id: string;
  level: "warn" | "error";
  title: string;
  detail: string;
};

export type NoticeMemory = {
  last: Map<string, ReliabilityItem["state"]>;
  raisedAt: Map<string, number>;
};

export const newNoticeMemory = (): NoticeMemory => ({ last: new Map(), raisedAt: new Map() });

/** One short line: what, how bad, where to look. */
const line = (item: ReliabilityItem): string => {
  const apps = item.apps?.length ? ` (${item.apps.map((app) => app.app).join(", ")})` : "";
  return `${item.detail}${apps}`.slice(0, 200);
};

export function atlasNotices(
  report: ReliabilityReport | null,
  memory: NoticeMemory,
  now: number,
): AtlasNotice[] {
  if (!report || !report.supported) return [];
  const out: AtlasNotice[] = [];
  for (const item of report.items) {
    const before = memory.last.get(item.id);
    memory.last.set(item.id, item.state);
    const rank = RANK[item.state];
    if (rank === 0) {
      memory.raisedAt.delete(item.id);
      continue;
    }
    const worse = before === undefined || RANK[before] < rank;
    if (!worse) continue;
    const raised = memory.raisedAt.get(item.id);
    if (raised !== undefined && now - raised < NOTICE_QUIET_MS) continue;
    memory.raisedAt.set(item.id, now);
    out.push({
      id: `reliability:${item.id}:${item.state}`,
      level: item.state === "bad" ? "error" : "warn",
      title: `${item.label}: ${item.state === "bad" ? "needs attention" : "worth a look"}`,
      detail: line(item),
    });
  }
  return out;
}
