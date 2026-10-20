/**
 * One stall record for the Doctor. Recovery of a dead kernel stays on the
 * lifecycle owner. This module does not spawn or kill a process.
 */
const MAX = 20;
const notes = [];

function note(entry = {}) {
  const row = {
    at: Date.now(),
    kind: entry.kind === "window" ? "window" : "kernel",
    detail: String(entry.detail || "").slice(0, 180),
  };
  notes.unshift(row);
  if (notes.length > MAX) notes.length = MAX;
  return row;
}

function snapshot() {
  return notes.slice();
}

function planRecovery(row) {
  if (!row) return { recover: false, owner: "lifecycle", action: "none" };
  if (row.kind === "kernel") {
    return { recover: true, owner: "lifecycle", action: "restart-kernel" };
  }
  return { recover: false, owner: "lifecycle", action: "report" };
}

function doctorCheck() {
  const latest = notes[0];
  if (!latest) {
    return {
      id: "watchdog:stall",
      label: "Window and kernel watchdog",
      group: "FRIDAY",
      status: "Ready",
      detail: "No stall recorded.",
      fixable: false,
    };
  }
  const plan = planRecovery(latest);
  return {
    id: "watchdog:stall",
    label: "Window and kernel watchdog",
    group: "FRIDAY",
    status: "Warning",
    detail: `${latest.kind}: ${latest.detail}. Recovery owner: ${plan.owner} (${plan.action}).`,
    fixable: false,
  };
}

module.exports = { note, snapshot, planRecovery, doctorCheck };
