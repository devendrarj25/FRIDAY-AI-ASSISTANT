/**
 * FRIDAY · clipboard history (main process)
 *
 * Stores recent clipboard captures under the workspace memory folder.
 * Capture reads Electron's clipboard when available, or an explicit `text`
 * argument (used by tests and by callers that already have the value).
 */
const fs = require("node:fs");
const path = require("node:path");

const MAX = 50;

function storePath(root) {
  if (!root) return null;
  return path.join(root, "memory", "clipboard-history.json");
}

function load(root) {
  const file = storePath(root);
  if (!file) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(raw.items) ? raw.items : [];
  } catch {
    return [];
  }
}

function save(root, items) {
  const file = storePath(root);
  if (!file) return { ok: false, error: "No FRIDAY workspace is selected." };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ items: items.slice(0, MAX) }, null, 2), "utf8");
  return { ok: true, file, count: Math.min(items.length, MAX) };
}

function readClipboard() {
  try {
    const { clipboard } = require("electron");
    if (clipboard && typeof clipboard.readText === "function") return clipboard.readText();
  } catch {
    /* not in Electron */
  }
  return "";
}

function run(input = {}) {
  const root = input.root;
  const action = String(input.action || "list").toLowerCase();
  const items = load(root);
  if (action === "list") return { ok: true, count: items.length, items };
  if (action === "clear") {
    const saved = save(root, []);
    if (!saved.ok) return saved;
    return { ok: true, count: 0, items: [] };
  }
  if (action === "capture") {
    const text = String(input.text || readClipboard() || "").trim();
    if (!text) {
      return {
        ok: false,
        error:
          "Clipboard was empty. In the desktop app I read the OS clipboard; otherwise pass text.",
      };
    }
    const item = { at: Date.now(), chars: text.length, text: text.slice(0, 8000) };
    items.unshift(item);
    const saved = save(root, items);
    if (!saved.ok) return saved;
    return { ok: true, item, count: saved.count };
  }
  return { ok: false, error: `Unknown clipboard action: ${action}` };
}

module.exports = { run, load, storePath };
