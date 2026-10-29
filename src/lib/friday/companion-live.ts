/**
 * Coarse live snapshot published beside the companion feature registry.
 *
 * High-frequency voice (VAD level, interim transcript) stays out of this
 * object so `companion-features.json` is not rewritten on every audio tick.
 * Voice state, doctor totals, connectors, reachable cloud providers, and the
 * owner's route / cost / model picks change infrequently and are the same
 * facts Manual, Auto and the phone should show.
 */
export type CompanionLive = {
  voice: string;
  listening: boolean;
  error: boolean;
  doctor: {
    problems: number;
    warnings: number;
    scanning: boolean;
  };
  connectors: Array<{ id: string; name: string; connected: boolean }>;
  cloud: string[];
  /** Where inference may run — same value the desktop router stores. */
  routeMode: string;
  /** Hard usage policy the router is enforcing (not a second cost store). */
  policy: string;
  /** Owner-picked model ids; empty means the mode's full eligible pool. */
  selected: string[];
  /** Live main-process cooldowns; the kernel phone fallback must skip these ids. */
  coolingModelIds: string[];
  /**
   * Coarse in-flight work from the existing brain observe snapshot.
   * Omitted when idle so the companion-features signature stays stable.
   */
  work?: {
    goal: string | null;
    step: string | null;
    status: string | null;
    tool: string | null;
  };
  /**
   * Off-LAN probe from electron/remote-access.cjs. Omitted when the desktop
   * has not published a real probe (browser preview, or the IPC failed).
   * `url` is only set when Tailscale is enabled, running, and a phone is paired.
   */
  remote?: {
    enabled: boolean;
    available: boolean;
    backend: string;
    url: string | null;
    detail: string;
    requiresPairedPhone?: boolean;
  };
  /** Desktop operating surface: Manual or Auto. Omitted when unpublished. */
  mode?: string;
  /**
   * Set when the phone cursor is behind the desktop or an outcome is unknown.
   * Omitted while the cursor is current so an idle snapshot stays stable.
   */
  sync?: {
    phase: "stale" | "snapshot" | "resume";
    mutate: boolean;
  };
  /**
   * Coarse Library + active project line. Omitted when both desks are idle
   * so companion tests that expect "healthy" stay exact.
   */
  desk?: string;
  /**
   * Subtitle computed by `companionLiveLine`. The phone displays this string
   * instead of rebuilding it, so a new live field cannot drift on the PWA.
   */
  line?: string;
};

export function buildCompanionLive(input: {
  voice: string;
  listening: boolean;
  error: boolean;
  doctorProblems: number;
  doctorWarnings: number;
  doctorScanning: boolean;
  connectors: Array<{ id: string; name: string; connected: boolean }>;
  cloud: string[];
  routeMode?: string;
  policy?: string;
  selected?: string[];
  coolingModelIds?: string[];
  workGoal?: string | null;
  workStep?: string | null;
  workStatus?: string | null;
  workTool?: string | null;
  remote?: {
    enabled: boolean;
    available: boolean;
    backend: string;
    url: string | null;
    detail: string;
    requiresPairedPhone?: boolean;
  } | null;
  mode?: string;
  desk?: string;
  lastCursor?: number;
  nextCursor?: number;
  durableMissed?: boolean;
  outcomeKnown?: boolean;
}): CompanionLive {
  const workGoal = input.workGoal || null;
  const workStep = input.workStep || null;
  const workStatus = input.workStatus || null;
  const workTool = input.workTool || null;
  const work =
    workGoal || workStep || workStatus || workTool
      ? { goal: workGoal, step: workStep, status: workStatus, tool: workTool }
      : undefined;
  const live: CompanionLive = {
    voice: input.voice || "OFF",
    listening: Boolean(input.listening),
    error: Boolean(input.error),
    doctor: {
      problems: input.doctorProblems,
      warnings: input.doctorWarnings,
      scanning: Boolean(input.doctorScanning),
    },
    connectors: input.connectors.map((row) => ({
      id: row.id,
      name: row.name,
      connected: Boolean(row.connected),
    })),
    cloud: [...input.cloud],
    routeMode: input.routeMode || "auto",
    policy: input.policy || "free-preferred",
    selected: [...(input.selected || [])].filter(Boolean),
    coolingModelIds: [...new Set(input.coolingModelIds || [])].filter(Boolean),
    ...(work ? { work } : {}),
    ...(input.remote
      ? {
          remote: {
            enabled: Boolean(input.remote.enabled),
            available: Boolean(input.remote.available),
            backend: input.remote.backend || "none",
            url: input.remote.url || null,
            detail: input.remote.detail || "",
            ...(input.remote.requiresPairedPhone ? { requiresPairedPhone: true } : {}),
          },
        }
      : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.desk ? { desk: input.desk } : {}),
  };
  const sync = reconcileCompanionCursor({
    lastCursor: input.lastCursor ?? 0,
    nextCursor: input.nextCursor ?? input.lastCursor ?? 0,
    durableMissed: input.durableMissed === true,
    outcomeKnown: input.outcomeKnown !== false,
  });
  if (sync.phase !== "connected") {
    live.sync = { phase: sync.phase, mutate: sync.mutate };
  }
  return { ...live, line: companionLiveLine(live) };
}

/**
 * The desktop owns the cursor. A gap or an unknown outcome blocks another
 * write until a snapshot is current. Push is not a second task store.
 */
export function reconcileCompanionCursor(input: {
  lastCursor: number;
  nextCursor: number;
  durableMissed: boolean;
  outcomeKnown: boolean;
}): {
  phase: "connected" | "stale" | "snapshot" | "resume";
  mutate: boolean;
  reason: string;
} {
  const last = Math.floor(Number(input.lastCursor));
  const next = Math.floor(Number(input.nextCursor));
  if (!Number.isFinite(last) || !Number.isFinite(next) || next < last) {
    return { phase: "snapshot", mutate: false, reason: "a broken cursor needs a fresh snapshot" };
  }
  if (input.durableMissed || next > last + 1) {
    return {
      phase: "snapshot",
      mutate: false,
      reason: "a gap needs the desktop snapshot before another write",
    };
  }
  if (!input.outcomeKnown) {
    return {
      phase: "stale",
      mutate: false,
      reason: "an unknown outcome is reconciled before retry",
    };
  }
  if (next === last + 1) {
    return { phase: "resume", mutate: true, reason: "the next event continues the stream" };
  }
  return { phase: "connected", mutate: true, reason: "the cursor is current" };
}

/** One line the phone subtitle (and tests) can share. */
export function companionLiveLine(live: CompanionLive): string {
  const bits: string[] = [];
  if (live.mode) bits.push(live.mode);
  if (live.voice && live.voice !== "OFF") bits.push(live.voice.toLowerCase());
  const problems = live.doctor.problems;
  const warnings = live.doctor.warnings;
  if (problems || warnings) {
    bits.push(
      `${problems} issue${problems === 1 ? "" : "s"}` +
        (warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""),
    );
  } else if (!live.doctor.scanning) {
    bits.push("healthy");
  }
  const connected = live.connectors.filter((row) => row.connected).map((row) => row.name);
  if (connected.length) bits.push(connected.join(", "));
  if (live.cloud.length) bits.push(`cloud: ${live.cloud.join(", ")}`);
  if (live.routeMode && live.routeMode !== "auto") bits.push(`route: ${live.routeMode}`);
  if (live.policy && live.policy !== "free-preferred") bits.push(`cost: ${live.policy}`);
  if (live.selected?.length) bits.push(`models: ${live.selected.join(", ")}`);
  if (live.work?.step) bits.push(live.work.step);
  else if (live.work?.goal) bits.push(live.work.goal);
  else if (live.work?.tool) bits.push(live.work.tool);
  if (live.remote?.url) bits.push("off-LAN ready");
  else if (live.remote?.enabled) bits.push("off-LAN: not ready");
  if (live.desk) bits.push(live.desk);
  if (live.sync && live.sync.mutate === false) bits.push("refreshing");
  return bits.join(" · ");
}
