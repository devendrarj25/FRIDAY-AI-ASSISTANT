/**
 * Honest labels for the FRIDAY Status board.
 *
 * Enabled ≠ running. Installed ≠ online. A connected kernel with nothing in
 * flight is Ready, not Active.
 */

export function presenceLabel(enabledCount: number, runningCount = 0): string {
  if (runningCount > 0) return "Active";
  if (enabledCount > 0) return "Ready";
  return "none installed";
}

export function presenceStatus(enabledCount: number, runningCount = 0): string {
  if (runningCount > 0) return "Active";
  if (enabledCount > 0) return "Ready";
  return "Idle";
}

export function brainCoreStatus(
  connected: boolean,
  runningTasks: number,
): { status: string; details: string } {
  if (!connected) {
    return { status: "Offline", details: "kernel not connected" };
  }
  if (runningTasks > 0) {
    return {
      status: "Active",
      details: `${runningTasks} task${runningTasks === 1 ? "" : "s"} running`,
    };
  }
  return { status: "Ready", details: "no tasks running" };
}

export function modelsPresence(installedCount: number): { state: string; status: string } {
  return installedCount
    ? { state: "Installed", status: "Installed" }
    : { state: "none installed", status: "Idle" };
}

export function discoveryStatus(supported: boolean): string {
  return supported ? "Available" : "Idle";
}
