// FRIDAY · agents/core/browser-extension-inventory
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function roots() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      path.join(local, "Google", "Chrome", "User Data", "Default", "Extensions"),
      path.join(local, "Microsoft", "Edge", "User Data", "Default", "Extensions"),
      path.join(local, "Chromium", "User Data", "Default", "Extensions"),
    ];
  }
  return [
    path.join(home, ".config", "google-chrome", "Default", "Extensions"),
    path.join(home, ".config", "chromium", "Default", "Extensions"),
    path.join(home, ".config", "microsoft-edge", "Default", "Extensions"),
  ];
}

function readManifest(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function plan() {
  const found = [];
  const searched = [];
  for (const root of roots()) {
    searched.push(root);
    if (!fs.existsSync(root)) continue;
    let ids;
    try {
      ids = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const id of ids) {
      const extDir = path.join(root, id.name);
      let versions;
      try {
        versions = fs
          .readdirSync(extDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory());
      } catch {
        continue;
      }
      const version = versions[0];
      if (!version) continue;
      const manifest = readManifest(path.join(extDir, version.name, "manifest.json"));
      const name = (manifest && (manifest.name || manifest.short_name)) || id.name;
      found.push({
        id: id.name,
        name: String(name),
        version: version.name,
        browserRoot: root,
      });
      if (found.length >= 200) break;
    }
  }
  return {
    ok: true,
    platform: process.platform,
    searched,
    count: found.length,
    extensions: found,
    actionable: false,
    note: found.length ? undefined : "No local Chrome/Chromium/Edge extension folders were found.",
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
