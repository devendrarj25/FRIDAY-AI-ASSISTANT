/**
 * FRIDAY · the week's approvals on one page
 *
 * Reads the governance record (every proposal FRIDAY made, whether it was applied, refused, failed or undone)
 * and says in numbers and plain lines what she asked for, what was allowed on its own, what the owner
 * decided, and what had to be rolled back. It adds nothing to the record and changes nothing in it.
 */

import type { GovItem } from "./governance";

export type AuditSummary = {
  days: number;
  total: number;
  /** Done: applied, verified or completed. */
  done: number;
  /** Of those, how many went through without the owner's click (his dial allowed it). */
  automatic: number;
  refused: number;
  failed: number;
  undone: number;
  waiting: number;
  byKind: Record<string, number>;
  byRisk: Record<string, number>;
  recent: { at: number; title: string; outcome: string; automatic: boolean }[];
};

const DONE = new Set(["applied", "verified", "completed"]);

function outcomeOf(item: GovItem): string {
  if (DONE.has(item.stage)) return item.autoApproved ? "done on its own" : "done after your yes";
  if (item.stage === "rejected") return "refused";
  if (item.stage === "rolled-back") return "undone";
  if (item.stage === "failed") return "failed";
  if (item.stage === "waiting-approval") return "waiting for you";
  return "in progress";
}

export function auditApprovals(items: readonly GovItem[], now: number, days = 7): AuditSummary {
  const since = now - days * 86_400_000;
  const inside = items.filter((item) => item.updatedAt >= since && item.updatedAt <= now);
  const summary: AuditSummary = {
    days,
    total: inside.length,
    done: 0,
    automatic: 0,
    refused: 0,
    failed: 0,
    undone: 0,
    waiting: 0,
    byKind: {},
    byRisk: {},
    recent: [],
  };
  for (const item of inside) {
    summary.byKind[item.kind] = (summary.byKind[item.kind] ?? 0) + 1;
    summary.byRisk[item.risk] = (summary.byRisk[item.risk] ?? 0) + 1;
    if (DONE.has(item.stage)) {
      summary.done += 1;
      if (item.autoApproved) summary.automatic += 1;
    } else if (item.stage === "rejected") summary.refused += 1;
    else if (item.stage === "failed") summary.failed += 1;
    else if (item.stage === "rolled-back") summary.undone += 1;
    else if (item.stage === "waiting-approval") summary.waiting += 1;
  }
  summary.recent = [...inside]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8)
    .map((item) => ({
      at: item.updatedAt,
      title: item.title.slice(0, 90),
      outcome: outcomeOf(item),
      automatic: Boolean(item.autoApproved),
    }));
  return summary;
}

export function describeAudit(summary: AuditSummary): string[] {
  if (!summary.total) return [`Nothing was proposed in the last ${summary.days} days.`];
  const lines = [
    `${summary.total} proposal(s) in ${summary.days} days: ${summary.done} done (${summary.automatic} on their own, ${summary.done - summary.automatic} after your yes), ${summary.refused} refused, ${summary.failed} failed, ${summary.undone} undone, ${summary.waiting} waiting for you.`,
  ];
  const risky = summary.byRisk["risky"] ?? 0;
  if (risky) lines.push(`${risky} of them were marked risky.`);
  if (summary.automatic && summary.automatic === summary.done) {
    lines.push(
      "Everything that was done went through without a click; your autonomy dial allowed it.",
    );
  }
  return lines;
}
