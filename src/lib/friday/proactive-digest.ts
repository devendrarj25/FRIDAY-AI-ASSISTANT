/**
 * FRIDAY · one calm digest, morning and evening
 *
 * What needs the owner, said once in the morning (05 to 11) and once in the evening (17 to 22), through the
 * notification centre and the existing background poller. It reads only what FRIDAY already holds (the
 * desk, the approval queue, the run ledger, unread alerts) and never contacts anything. It is held back by
 * the same conduct rules as every unsolicited line: Stop everything, Ask-every-time (strict), quiet hours
 * and the owner's switch. A day with nothing to say produces nothing, not a filler line.
 */

import { briefSlot, considerLifeTrigger } from "./assistant-conduct";
import { filesLine, peekPendingFiles, takePendingFiles } from "./folder-watch";
import { notifications } from "./notifications";
import { personalDesk, type DeskTask } from "./personal-desk";
import { readLocalState, writeState } from "./persist";
import { autonomy } from "./self/autonomy";
import { governance } from "./self/governance";
import { ledger } from "./self/task-ledger";
import { prefOn } from "./settings-runtime";

export type DigestInput = {
  now: number;
  tasks: Pick<DeskTask, "title" | "dueAt" | "done">[];
  pendingApprovals: number;
  failedRuns: string[];
  unreadAlerts: number;
  /** New files in shared folders, as one ready line. */
  newFilesLine?: string | null;
};

const HOUR = 3_600_000;

export function buildDigest(input: DigestInput): { lines: string[]; quiet: boolean } {
  const lines: string[] = [];
  const open = input.tasks.filter((task) => !task.done && task.dueAt != null);
  const overdue = open.filter((task) => (task.dueAt as number) <= input.now);
  const soon = open.filter(
    (task) => (task.dueAt as number) > input.now && (task.dueAt as number) <= input.now + 24 * HOUR,
  );
  if (overdue.length) {
    lines.push(
      `Overdue: ${overdue
        .slice(0, 3)
        .map((t) => t.title)
        .join("; ")}${overdue.length > 3 ? ` (+${overdue.length - 3})` : ""}.`,
    );
  }
  if (soon.length) {
    lines.push(
      `Due in the next day: ${soon
        .slice(0, 3)
        .map((t) => t.title)
        .join("; ")}${soon.length > 3 ? ` (+${soon.length - 3})` : ""}.`,
    );
  }
  if (input.pendingApprovals) {
    lines.push(`${input.pendingApprovals} proposal(s) are waiting for your approval.`);
  }
  if (input.failedRuns.length) {
    lines.push(
      `${input.failedRuns.length} run(s) failed since yesterday: ${input.failedRuns.slice(0, 2).join("; ")}.`,
    );
  }
  if (input.unreadAlerts) lines.push(`${input.unreadAlerts} alert(s) you have not opened.`);
  if (input.newFilesLine) lines.push(input.newFilesLine);
  return { lines, quiet: lines.length === 0 };
}

/** The local-day key of a slot, so a slot is offered once a day. */
export function slotKey(now: number, hour = new Date(now).getHours()): string | null {
  const slot = briefSlot(hour);
  if (slot === "none") return null;
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${day}:${slot}`;
}

const KEY = "friday.digest.v1";

let delivered: string[] | null = null;

export function readDelivered(): string[] {
  if (!delivered) {
    const rows = readLocalState<string[]>(KEY);
    delivered = Array.isArray(rows) ? rows : [];
  }
  return delivered;
}

export function resetDigestForTests(): void {
  delivered = [];
  writeState(KEY, []);
}

export type DigestOutcome =
  { delivered: true; key: string; lines: string[] } | { delivered: false; reason: string };

/**
 * Deliver the digest if this is a brief slot not yet used today, the owner's switch is on and the conduct
 * rules allow an unsolicited line. Returns why it did not, so the poller can say so.
 */
export function deliverDigest(now = Date.now()): DigestOutcome {
  if (!prefOn("proactiveDigest", true)) return { delivered: false, reason: "switched off" };
  const key = slotKey(now);
  if (!key) return { delivered: false, reason: "not a brief slot" };
  const done = readDelivered();
  if (done.includes(key)) return { delivered: false, reason: "already offered this slot" };
  const settings = autonomy.getSnapshot();
  const gate = considerLifeTrigger({
    kind: "schedule",
    now,
    offeredAt: [],
    level: settings.approvalLevel,
    halted: settings.halted,
    hour: new Date(now).getHours(),
  });
  if (!gate.offer) return { delivered: false, reason: gate.reason };
  const digest = buildDigest({
    now,
    tasks: personalDesk.list(),
    pendingApprovals: governance.pending().length,
    failedRuns: ledger
      .list()
      .filter((task) => task.status === "failed" && task.startedAt >= now - 24 * HOUR)
      .map((task) => task.title),
    unreadAlerts: notifications.getSnapshot().items.filter((item) => !item.read).length,
    newFilesLine: filesLine(peekPendingFiles()),
  });
  // Marked even when quiet: a day with nothing to say is not asked about again until the next slot.
  delivered = [...done, key].slice(-14);
  writeState(KEY, delivered);
  takePendingFiles();
  if (digest.quiet) return { delivered: false, reason: "nothing to say" };
  const morning = key.endsWith("morning");
  notifications.push({
    id: `digest:${key}`,
    level: "info",
    title: morning ? "Today" : "This evening",
    detail: digest.lines.join(" "),
    source: "Digest",
    route: "/chat",
  });
  return { delivered: true, key, lines: digest.lines };
}
