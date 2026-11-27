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
import { doctor, isProblem, isProblemCheck, isWarning, type DoctorCheck } from "./doctor-engine";

/** What FRIDAY puts on screen when she needs the owner to understand a fault. */
function describeProblem(problem: SelfProblem): string {
  const lines = [problem.detail];
  const fix = problem.fix ?? problem.knowledge?.steps?.[0];
  if (fix) lines.push("", `Fix: ${fix}`);
  if (problem.knowledge?.source) lines.push(`Source: ${problem.knowledge.source}`);
  return lines.join("\n");
}

import { atlasNotices, newNoticeMemory } from "./atlas-notices";
import { latestReliability, subscribeSelfAtlas } from "./self-atlas";
import { onGithubUpdate } from "./github-updates";
import { networkMeter } from "./network";
import { notifications } from "./notifications";
import { autonomousCore } from "./self/autonomous-core";
import { governance } from "./self/governance";
import { systemMap } from "./system-map";
import { installToastMirror } from "./toast-bridge";
import { ledger } from "./self/task-ledger";
import { taskGraph, type TaskGraph } from "./self/task-graph";
import { announceBackgroundTask, type TaskUpdate } from "./voice-engine/voice-tasks";

let wired = false;

type Notice = Parameters<typeof notifications.push>[0];

const DONE_NODE = new Set(["completed", "verified"]);
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** What a graph has to say now: finished, failed, or waiting on the owner. Null while it is simply working. */
function graphOutcome(graph: TaskGraph): "completed" | "failed" | "needs-approval" | null {
  if (graph.state === "completed") return "completed";
  if (graph.state === "failed") return "failed";
  if (graph.nodes.some((node) => node.state === "waiting")) return "needs-approval";
  return null;
}

/**
 * One short line, from what the subtasks recorded: how many finished with a checked postcondition, the failed step
 * and its error, or the step waiting on the owner. A finish that was not checked is never counted.
 */
export function graphOutcomeLine(graph: TaskGraph): string {
  const subject = clip(graph.request.replace(/\s+/g, " ").trim(), 70);
  const total = graph.nodes.length;
  const outcome = graphOutcome(graph);
  if (outcome === "failed") {
    const failed = graph.nodes.find((node) => node.state === "failed");
    const why = failed?.error ? `: ${clip(failed.error, 60)}` : "";
    return clip(`${subject} failed at ${failed?.title ?? "a step"}${why}.`, 160);
  }
  if (outcome === "needs-approval") {
    const waiting = graph.nodes.find((node) => node.state === "waiting");
    const tool = waiting?.checkpoint?.pendingApproval?.tool;
    return clip(
      `${subject} is waiting on you${tool ? ` to approve ${tool}` : ""} at ${waiting?.title ?? "a step"}.`,
      160,
    );
  }
  const checked = graph.nodes.filter(
    (node) => DONE_NODE.has(node.state) && node.checkpoint?.checked === true,
  ).length;
  return clip(`Done: ${subject}. ${checked} of ${total} step(s) checked.`, 160);
}

/** Waiting notices raised this session (a waiting graph does not use up its completion notice). */
const waitingNoticed = new Set<string>();
/** Final notices shown on screen while the voice has not taken the line yet. */
const finalNoticed = new Set<string>();

/**
 * Raises the notice for each graph that finished, failed or is waiting: a visual row in the notification centre and
 * one spoken line through the voice desk. A finished or failed graph is marked announced only after the voice took
 * the line (spoken or queued), so a line is not lost while no voice is attached.
 */
export function announceGraphs(
  graphs: readonly TaskGraph[],
  deps: {
    notify: (notice: Notice) => void;
    speak: (update: TaskUpdate, label: string) => boolean;
    markAnnounced: (graphId: string) => void;
  },
): void {
  for (const graph of graphs) {
    if (graph.announced) continue;
    const outcome = graphOutcome(graph);
    if (!outcome) continue;
    const line = graphOutcomeLine(graph);
    const label = clip(graph.request.replace(/\s+/g, " ").trim(), 60);
    if (outcome === "needs-approval") {
      const waiting = graph.nodes.find((node) => node.state === "waiting");
      const key = `${graph.id}:${waiting?.id ?? ""}:${waiting?.attempts ?? 0}`;
      if (waitingNoticed.has(key)) continue;
      waitingNoticed.add(key);
      deps.notify({
        id: `graph:${graph.id}:waiting:${waiting?.id ?? ""}`,
        level: "action",
        title: "Background task is waiting for you",
        detail: line,
        source: "Tasks",
        route: "/tasks",
      });
      deps.speak({ taskId: `graph:${graph.id}`, kind: "needs-approval", text: line }, label);
      continue;
    }
    const key = `${graph.id}:${outcome}`;
    if (!finalNoticed.has(key)) {
      finalNoticed.add(key);
      deps.notify({
        id: `graph:${graph.id}:${outcome === "completed" ? "done" : "failed"}`,
        level: outcome === "completed" ? "success" : "error",
        title:
          outcome === "completed"
            ? "Background task finished"
            : "Background task needs you — it failed",
        detail: `${graph.request.slice(0, 160)}\n${line}`,
        source: "Tasks",
        route: "/tasks",
      });
    }
    if (deps.speak({ taskId: `graph:${graph.id}`, kind: outcome, text: line }, label)) {
      deps.markAnnounced(graph.id);
    }
  }
}

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
      if (!isProblemCheck(check) && !isWarning(check.status)) continue;
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

  /* ------------------------------------------------------ PC reliability */
  // Event-driven on the shared atlas poller: a row is raised when it turns worse, then stays quiet.
  const atlasMemory = newNoticeMemory();
  subscribeSelfAtlas(() => {
    for (const notice of atlasNotices(latestReliability(), atlasMemory, Date.now())) {
      notifications.push({ ...notice, source: "PC health", route: "/self-management" });
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
  // The same outcome is also said once by voice, through the narrator's rules.
  taskGraph.subscribe(() => {
    announceGraphs(taskGraph.list(), {
      notify: (notice) => notifications.push(notice),
      speak: announceBackgroundTask,
      markAnnounced: (id) => taskGraph.markAnnounced(id),
    });
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

  /* ------------------------------------------------------------ updates */
  // The background check runs without the Updates panel open. This is what lets
  // a new release reach the owner anyway. It only informs: nothing installs.
  onGithubUpdate((check) => {
    if (!check.updateAvailable) return;
    const what = check.version ? `FRIDAY ${check.version}` : check.title || "A new FRIDAY version";
    notifications.push({
      id: `update:${check.updateChannel ?? "stable"}:${check.ref ?? check.version ?? "latest"}`,
      level: "action",
      title: `${check.testBuild ? "Test build" : "Update"} available — ${what}`,
      detail: check.staged
        ? "Downloaded and checked in the background. Open Settings → Updates and press Install. Nothing is installed without your go-ahead."
        : "Open Settings → Updates to download and install it. Nothing is installed without your go-ahead.",
      source: "Updates",
      route: "/settings",
    });
  });

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
