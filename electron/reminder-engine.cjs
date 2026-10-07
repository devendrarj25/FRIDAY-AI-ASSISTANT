/**
 * FRIDAY · reminder engine (main process)
 *
 * Persist due items in the selected workspace memory folder. This is not the
 * renderer personal-desk (that stays for the HUD). Catalog tools and skills
 * that need a real due-store use this file.
 */
const fs = require("node:fs");
const path = require("node:path");

function storePath(root) {
  if (!root) return null;
  return path.join(root, "memory", "reminders.json");
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
  fs.writeFileSync(file, JSON.stringify({ items }, null, 2), "utf8");
  return { ok: true, file, count: items.length };
}

function parseDue(value, now = Date.now()) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const iso = Date.parse(text);
  if (!Number.isNaN(iso)) return iso;
  const inHours = /\bin\s+(\d+)\s+hours?\b/i.exec(text);
  if (inHours) return now + Number(inHours[1]) * 3600_000;
  const inDays = /\bin\s+(\d+)\s+days?\b/i.exec(text);
  if (inDays) return now + Number(inDays[1]) * 86400_000;
  return null;
}

function run(input = {}) {
  const root = input.root;
  const action = String(input.action || "list").toLowerCase();
  const items = load(root);
  const now = Date.now();
  if (action === "list") {
    return { ok: true, count: items.length, items };
  }
  if (action === "due") {
    const due = items.filter((item) => !item.done && item.dueAt && item.dueAt <= now);
    return { ok: true, count: due.length, items: due, now };
  }
  if (action === "add") {
    const text = String(input.text || input.prompt || "").trim();
    if (!text) return { ok: false, error: "Reminder text is required." };
    const dueAt = parseDue(input.dueAt || input.due || text, now);
    const item = {
      id: `rem-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text: text.slice(0, 400),
      dueAt,
      createdAt: now,
      done: false,
    };
    items.push(item);
    const saved = save(root, items);
    if (!saved.ok) return saved;
    return { ok: true, item, count: items.length };
  }
  if (action === "done") {
    const id = String(input.id || "").trim();
    const item = items.find((row) => row.id === id);
    if (!item) return { ok: false, error: "Reminder not found." };
    item.done = true;
    item.doneAt = now;
    const saved = save(root, items);
    if (!saved.ok) return saved;
    return { ok: true, item };
  }
  return { ok: false, error: `Unknown reminder action: ${action}` };
}

module.exports = { run, load, parseDue, storePath };
