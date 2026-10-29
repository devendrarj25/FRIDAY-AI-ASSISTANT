// FRIDAY · agents/core/network-connection-snapshot
const { execFileSync } = require("node:child_process");

function tryCmd(cmd, args) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
    return { ok: true, output: String(out) };
  } catch (error) {
    return { ok: false, error: String(error.message || error), output: "" };
  }
}

function snapshot() {
  if (process.platform === "win32") return tryCmd("netstat", ["-ano"]);
  const ss = tryCmd("ss", ["-tuln"]);
  if (ss.ok) return ss;
  return tryCmd("netstat", ["-tuln"]);
}

function plan() {
  const shot = snapshot();
  if (!shot.ok) {
    return {
      ok: false,
      platform: process.platform,
      error: shot.error || "No ss/netstat output on this host.",
      connections: [],
    };
  }
  const connections = shot.output
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 200);
  return {
    ok: true,
    platform: process.platform,
    count: connections.length,
    connections,
    actionable: false,
  };
}

async function run(input = {}) {
  const preview = plan(input);
  if (!preview.ok) return preview;
  const dryRun = input.dryRun !== false;
  if (dryRun) return { ...preview, dryRun: true };
  if (!input.approved)
    return {
      ...preview,
      dryRun: true,
      error: "Recording this snapshot requires an approved plan.",
    };
  return { ...preview, dryRun: false, applied: "report-only" };
}

module.exports = { plan, run };
