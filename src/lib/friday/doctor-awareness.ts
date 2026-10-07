/**
 * FRIDAY · live Setup & Doctor session (renderer)
 *
 * One shared snapshot of the Doctor page so Core Brain, Auto Mode, and Chat
 * see the same checks the owner is looking at. The store stays
 * `doctor-engine.ts` / `electron/diagnostics.cjs` — this module never opens
 * a second probe.
 */

import {
  doctor,
  isHealthy,
  isProblem,
  isWarning,
  type DoctorCheck,
  type DoctorState,
} from "./doctor-engine";

export type DoctorFilter = "all" | "problems" | "warnings" | "healthy" | "fixable" | "owner";

export type DoctorSession = {
  desktop: boolean;
  follow: boolean;
  filter: DoctorFilter;
  query: string;
  selectedIds: string[];
  scanning: boolean;
  mode: DoctorState["mode"];
  lastScanAt: number | null;
  lastDeep: boolean;
  durationMs: number;
  checks: DoctorCheck[];
  log: DoctorState["log"];
  repairing: string[];
  rollbacks: number;
};

const empty = (): DoctorSession => ({
  desktop: false,
  follow: true,
  filter: "all",
  query: "",
  selectedIds: [],
  scanning: false,
  mode: "idle",
  lastScanAt: null,
  lastDeep: false,
  durationMs: 0,
  checks: [],
  log: [],
  repairing: [],
  rollbacks: 0,
});

let session: DoctorSession = empty();
let asker: ((prompt: string) => void) | null = null;

export function readLiveDoctor(): DoctorSession {
  const snap = doctor.getSnapshot();
  const checks = mergeById(session.checks, snap.checks);
  return {
    ...session,
    desktop: snap.desktop || session.desktop,
    scanning: snap.scanning,
    mode: snap.mode,
    lastScanAt: snap.lastScanAt ?? session.lastScanAt,
    lastDeep: snap.lastDeep,
    durationMs: snap.durationMs || session.durationMs,
    checks,
    log: snap.log.length ? snap.log : session.log,
    repairing: snap.repairing.length ? snap.repairing : session.repairing,
    rollbacks: snap.rollbacks.length || session.rollbacks,
  };
}

function mergeById(sessionRows: DoctorCheck[], storeRows: DoctorCheck[]): DoctorCheck[] {
  const map = new Map<string, DoctorCheck>();
  for (const row of sessionRows) map.set(row.id, row);
  for (const row of storeRows) map.set(row.id, row);
  return [...map.values()];
}

export function doctorSnapshot(): DoctorSession {
  return readLiveDoctor();
}

export function publishDoctorSession(patch: Partial<DoctorSession>): DoctorSession {
  session = {
    ...session,
    ...patch,
    checks: patch.checks ? patch.checks.slice(0, 120) : session.checks,
    log: patch.log ? patch.log.slice(0, 300) : session.log,
    repairing: patch.repairing ? patch.repairing.slice(0, 40) : session.repairing,
  };
  return session;
}

export function registerDoctorAsk(fn: ((prompt: string) => void) | null): void {
  asker = fn;
}

export function requestDoctorAsk(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text || !asker) return false;
  asker(text);
  return true;
}

export function filterChecks(
  checks: DoctorCheck[],
  options: { filter?: DoctorFilter; query?: string },
): DoctorCheck[] {
  const filter = options.filter ?? "all";
  const query = String(options.query || "")
    .trim()
    .toLowerCase();
  return checks.filter((check) => {
    if (filter === "problems" && !isProblem(check.status)) return false;
    if (filter === "warnings" && !isWarning(check.status)) return false;
    if (filter === "healthy" && !isHealthy(check.status)) return false;
    if (filter === "fixable" && !(check.fixable && !isHealthy(check.status))) return false;
    if (filter === "owner" && check.repairKind !== "needs-owner") return false;
    if (
      query &&
      !`${check.label} ${check.group} ${check.id} ${check.status} ${check.detail} ${check.cause ?? ""}`
        .toLowerCase()
        .includes(query)
    ) {
      return false;
    }
    return true;
  });
}

export function summarizeDoctorProblems(checks: DoctorCheck[], maxLines = 12): string {
  return checks
    .filter(
      (check) =>
        isProblem(check.status) || isWarning(check.status) || check.repairKind === "needs-owner",
    )
    .slice(0, maxLines)
    .map((check) => `[${check.status}] ${check.label} — ${check.cause || check.detail}`)
    .join("\n");
}

export function formatDoctorExtra(maxChars = 4000): string {
  const snap = readLiveDoctor();
  const problems = summarizeDoctorProblems(snap.checks).slice(-1200);
  const body = snap.checks
    .slice(0, 24)
    .map((check) => `[${check.status}] ${check.group}/${check.label} — ${check.detail}`)
    .join("\n")
    .slice(-maxChars);
  const log = snap.log
    .slice(0, 16)
    .map((line) => `${line.at} [${line.level}] ${line.line}`)
    .join("\n")
    .slice(-1200);
  return [
    "DOCTOR SESSION (live FRIDAY diagnostics — not invented)",
    `desktop: ${snap.desktop ? "yes" : "no (preview)"}`,
    `scanning: ${snap.scanning ? snap.mode : "idle"}`,
    `filter: ${snap.filter}`,
    snap.query ? `query: ${snap.query}` : "query: (none)",
    `follow: ${snap.follow ? "on" : "paused"}`,
    `last scan: ${snap.lastDeep ? "deep" : "quick"}`,
    `checks: ${snap.checks.length}`,
    `selected: ${snap.selectedIds.length ? snap.selectedIds.join(", ") : "none"}`,
    `repairing: ${snap.repairing.length ? snap.repairing.join(", ") : "none"}`,
    `rollbacks: ${snap.rollbacks}`,
    problems ? `attention:\n${problems}` : "attention: none in this buffer",
    "recent checks:",
    body || "(empty)",
    "recent repair log:",
    log || "(empty)",
  ].join("\n");
}

export function resetDoctorSession(): void {
  session = empty();
}
