/**
 * FRIDAY · notification wiring
 *
 * Connects the notification centre to the real subsystems already running in
 * the app. Everything is subscription-based — no polling, no timers, and each
 * source publishes stable ids so a persistent condition never spams the list.
 *
 * Sources: environment doctor, self-governance approvals, task ledger,
 * autonomous background cycles and network availability.
 */

import { inspectSelf, type SelfProblem, type SelfReport } from "./brain/self-diagnosis";
import { doctor, isProblem, isWarning, type DoctorCheck } from "./doctor-engine";

/** What FRIDAY puts on screen when she needs the owner to understand a fault. */
function describeProblem(problem: SelfProblem): string {
  const lines = [problem.detail];
  const fix = problem.fix ?? problem.knowledge?.steps?.[0];
  if (fix) lines.push("", `Fix: ${fix}`);
  if (problem.knowledge?.source) lines.push(`Source: ${problem.knowledge.source}`);
  return lines.join("\n");
}

import { networkMeter } from "./network";
import { notifications } from "./notifications";
import { autonomousCore } from "./self/autonomous-core";
import { governance } from "./self/governance";
import { systemMap } from "./system-map";
import { installToastMirror } from "./toast-bridge";
import { ledger } from "./self/task-ledger";
import { taskGraph } from "./self/task-graph";

let wired = false;

/** Idempotent — safe to call from every mount. */
export function wireNotifications(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;

  // Every corner popup is also recorded, so nothing is lost when it fades.
  installToastMirror();

  /* ------------------------------------------------------------- doctor */
  doctor.subscribe(() => {
    const checks: DoctorCheck[] = doctor.getSnapshot().checks ?? [];
    for (const check of checks) {
      if (!isProblem(check.status) && !isWarning(check.status)) continue;
      notifications.push({
        id: `doctor:${check.id}:${check.status}`,
        level: isProblem(check.status) ? "error" : "warn",
        title: `${check.label} — ${check.status}`,
        detail: check.detail || check.fix || "Open Setup & Doctor to repair.",
        source: "Doctor",
        route: "/doctor",
      });
    }
  });

  /* --------------------------------------------------------- governance */
  governance.subscribe(() => {
    for (const item of governance.getSnapshot().pending) {
      notifications.push({
        id: `gov:${item.id}:${item.stage}`,
        level: "action",
        title: `Approval needed — ${item.title}`,
        detail: item.rationale,
        source: "Self-management",
        route: "/self-management",
      });
    }
  });

  /* -------------------------------------------------------------- tasks */
  ledger.subscribe(() => {
    const state = ledger.getSnapshot();
    for (const task of state.tasks) {
      if (task.status === "failed" || task.status === "timeout") {
        notifications.push({
          id: `task:${task.id}:${task.status}`,
          level: "error",
          title: `Task failed — ${task.title}`,
          detail: task.error ?? `${task.kind} ended as ${task.status}.`,
          source: "Tasks",
          route: "/tasks",
        });
      }
    }
    for (const approval of state.approvals) {
      notifications.push({
        id: `task-approval:${approval.taskId}`,
        level: "action",
        title: "A task is waiting for your decision",
        detail: approval.question,
        source: "Tasks",
        route: "/tasks",
      });
    }
  });

  /* ------------------------------------------------------- task graph */
  // Long background jobs report themselves here, so a task that finished (or
  // stalled) while the owner was elsewhere is waiting for them when they return.
  taskGraph.subscribe(() => {
    for (const graph of taskGraph.list()) {
      if (graph.announced) continue;
      if (graph.state === "completed") {
        taskGraph.markAnnounced(graph.id);
        notifications.push({
          id: `graph:${graph.id}:done`,
          level: "success",
          title: "Background task finished",
          detail: `${graph.request.slice(0, 160)}\n${graph.nodes.length} subtask(s) completed.`,
          source: "Tasks",
          route: "/tasks",
        });
      } else if (graph.state === "failed" || graph.nodes.some((n) => n.state === "waiting")) {
        taskGraph.markAnnounced(graph.id);
        notifications.push({
          id: `graph:${graph.id}:${graph.state}`,
          level: graph.state === "failed" ? "error" : "action",
          title:
            graph.state === "failed"
              ? "Background task needs you — it failed"
              : "Background task is waiting for you",
          detail: graph.error ?? graph.request.slice(0, 160),
          source: "Tasks",
          route: "/tasks",
        });
      }
    }
  });

  /* ------------------------------------------------------- autonomy log */
  autonomousCore.subscribe(() => {
    const state = autonomousCore.getSnapshot();
    const cycle = state.cycles[0];
    if (cycle && cycle.discovered > 0) {
      notifications.push({
        id: `core:cycle:${cycle.at}`,
        level: "info",
        title: "FRIDAY prepared new improvements",
        detail: cycle.note,
        source: "Autonomous core",
        route: "/self-management",
      });
    }
    for (const check of state.health) {
      if (check.ok) continue;
      notifications.push({
        id: `core:health:${check.id}`,
        level: "warn",
        title: `${check.label} needs attention`,
        detail: check.detail,
        source: "Autonomous core",
        route: "/status",
      });
    }
  });

  /* --------------------------------------------- FRIDAY's own assessment */
  // Her self-diagnosis merges Doctor, system map, models and capabilities into
  // problems she understands, with the fix she would apply. Publishing it here
  // is what lets her raise upgrades, warnings and suggestions herself, and put
  // an explanation card on screen when something is critical.
  let selfTimer: ReturnType<typeof setTimeout> | undefined;
  const publishSelfReport = () => {
    if (selfTimer) clearTimeout(selfTimer);
    // Debounced: several subsystems settle in the same tick after a scan.
    selfTimer = setTimeout(() => {
      let report: SelfReport;
      try {
        report = inspectSelf();
      } catch {
        return;
      }
      if (!report.inspected) return;
      for (const problem of report.problems) {
        const fix = problem.fix ?? problem.knowledge?.steps?.[0];
        const level =
          problem.severity === "critical"
            ? "error"
            : problem.severity === "warning"
              ? "warn"
              : "info";
        notifications.push({
          id: `self:${problem.id}:${problem.severity}`,
          level,
          title: `${problem.area} — ${problem.title}`,
          detail: fix ? `${problem.detail}\nFix: ${fix}` : problem.detail,
          source: "FRIDAY",
          route: "/doctor",
          ...(problem.severity === "critical"
            ? {
                present: {
                  kind: "text" as const,
                  title: problem.title,
                  body: describeProblem(problem),
                  source: "FRIDAY",
                },
              }
            : {}),
        });
      }
    }, 1200);
  };
  doctor.subscribe(publishSelfReport);
  autonomousCore.subscribe(publishSelfReport);
  // Her own subsystem map is the third input to inspectSelf(); without this a
  // component going missing or degraded only surfaced once the doctor happened
  // to re-scan. Now she raises it as soon as she notices it herself.
  systemMap.subscribe(publishSelfReport);

  /* ------------------------------------------------------------ network */
  let wasOnline = true;
  networkMeter.subscribe(() => {
    const online = networkMeter.getSnapshot().online;
    if (online === wasOnline) return;
    wasOnline = online;
    notifications.push({
      id: `network:${online ? "online" : "offline"}:${Date.now()}`,
      level: online ? "success" : "warn",
      title: online ? "Back online" : "Network unavailable",
      detail: online
        ? "Cloud models, research and updates are reachable again."
        : "FRIDAY is running on local models and stored knowledge only.",
      source: "Network",
      route: "/status",
    });
  });
}
