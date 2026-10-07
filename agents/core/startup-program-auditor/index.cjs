// FRIDAY · agents/core/startup-program-auditor
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function listDir(folder) {
  if (!folder || !fs.existsSync(folder)) return [];
  try {
    return fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({ name: entry.name, path: path.join(folder, entry.name), source: folder }));
  } catch {
    return [];
  }
}

function queryRunKey(hive) {
  if (process.platform !== "win32") return [];
  try {
    const out = execFileSync(
      "reg",
      ["query", `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`],
      { encoding: "utf8", timeout: 8000, windowsHide: true },
    );
    return String(out)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^HKEY_/i.test(line))
      .map((line) => ({ name: line.slice(0, 80), path: line, source: hive }));
  } catch {
    return [];
  }
}

function plan() {
  if (process.platform !== "win32") {
    return {
      ok: true,
      platform: process.platform,
      entries: [],
      count: 0,
      actionable: false,
      note: `Startup programs are a Windows feature; this host is ${process.platform}.`,
    };
  }
  const folders = [
    path.join(
      process.env.APPDATA || "",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
    ),
    path.join(
      process.env.PROGRAMDATA || "",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "StartUp",
    ),
  ];
  const entries = [...folders.flatMap(listDir), ...queryRunKey("HKCU"), ...queryRunKey("HKLM")];
  return {
    ok: true,
    platform: process.platform,
    folders,
    entries,
    count: entries.length,
    actionable: entries.length > 0,
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
      error: "Recording this inventory requires an approved plan.",
    };
  return { ...preview, dryRun: false, applied: "report-only" };
}

module.exports = { plan, run };
