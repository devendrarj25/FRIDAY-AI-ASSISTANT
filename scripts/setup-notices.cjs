/**
 * Setup notices: the one place where setup, Doctor and the build record what could not be finished.
 *
 * A failed download or an optional install is a NOTICE, never a stop: the step prints one line, records the item here
 * and carries on, so the build still runs. FRIDAY then lists the record under Install Manager / Models so the owner
 * finishes the item from inside the app. Only a real build blocker (Node.js, npm, the dependency install, Electron,
 * the packaging tools) still fails a step; those never come through this file.
 *
 * Strict mode is opt-in: FRIDAY_SETUP_STRICT=1 (or the older FRIDAY_PREFETCH_STRICT=1 and
 * FRIDAY_PREFETCH_TOOLKIT_STRICT=1) turns every notice back into a failure for a machine that must be complete.
 *
 * The record is <FRIDAY_ROOT>/runtime/setup-notices.json. Every function here is best effort and never throws.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "setup-notices.json";
const KINDS = ["tool", "model", "package", "pack", "voice", "runtime", "other"];
const WHERE = "FRIDAY > Install Manager / Models";

/** True only when the owner asked for the old stop-on-failure behaviour. */
function isStrict(env = process.env) {
  return ["FRIDAY_SETUP_STRICT", "FRIDAY_PREFETCH_STRICT", "FRIDAY_PREFETCH_TOOLKIT_STRICT"].some(
    (name) => String(env[name] || "").trim() === "1",
  );
}

function defaultRoot() {
  try {
    return require("./friday-root.cjs").workspaceRootOrDev({ record: false }).root || "";
  } catch {
    return "";
  }
}

/** <root>/runtime/setup-notices.json, or "" when no root can be found. */
function noticesFile(root = defaultRoot()) {
  return root ? path.join(root, "runtime", FILE_NAME) : "";
}

/** One printable line: line breaks become a space, every other control character (C0, DEL, C1, U+2028/9) is dropped. */
function cleanText(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, max);
}

/** One normalised entry; null when there is no id. */
function normalise(entry, now) {
  if (!entry || !cleanText(entry.id, 120)) return null;
  const kind = KINDS.includes(entry.kind) ? entry.kind : "other";
  return {
    id: cleanText(entry.id, 120),
    kind,
    label: cleanText(entry.label || entry.id, 120),
    reason: cleanText(entry.reason || "not finished", 300),
    // The Install Manager or Models row that finishes it, when there is one.
    installManagerId: cleanText(entry.installManagerId || "", 120),
    // The command that repairs it from a terminal.
    repair: cleanText(entry.repair || "npm run doctor", 120),
    at: cleanText(entry.at || now, 40),
  };
}

function readNotices(root) {
  const file = noticesFile(root);
  if (!file) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed && parsed.notices)
        ? parsed.notices
        : [];
    return list.map((entry) => normalise(entry, entry && entry.at)).filter(Boolean);
  } catch {
    return [];
  }
}

function writeAll(root, notices) {
  const file = noticesFile(root);
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ schema: 1, notices }, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** The one line printed for a notice: what, why, and where to finish it. */
function formatNotice(entry) {
  const item = normalise(entry, "");
  if (!item) return "";
  return `[friday] NOTICE ${item.label}: ${item.reason}. Not a stop: finish it later in ${WHERE}${
    item.installManagerId ? ` (${item.installManagerId})` : ""
  }, or run ${item.repair}.`;
}

/**
 * Records (replacing an older entry with the same id) and returns the printed line. Pass { print: false } to only
 * record. `now` is injectable so a test never depends on today's date.
 */
function recordNotice(
  entry,
  { root, now = new Date().toISOString(), log = console.log, print = true } = {},
) {
  const item = normalise(entry, now);
  if (!item) return "";
  const list = readNotices(root).filter((old) => old.id !== item.id);
  list.push(item);
  writeAll(root, list);
  const line = formatNotice(item);
  if (print && line) log(line);
  return line;
}

/** Removes a notice once its item is installed. True when something was removed. */
function clearNotice(id, { root } = {}) {
  const list = readNotices(root);
  const next = list.filter((old) => old.id !== id);
  if (next.length === list.length) return false;
  writeAll(root, next);
  return true;
}

/** The closing block of a step or of Doctor: one line per open notice, or "" when there are none. */
function summaryLines(notices) {
  const list = (notices || []).map((entry) => normalise(entry, "")).filter(Boolean);
  if (!list.length) return [];
  return [
    `[friday] ${list.length} item(s) could not be finished here. This does not stop the build; finish them in ${WHERE}:`,
    ...list.map(
      (item) =>
        `[friday]   - ${item.label}: ${item.reason}${item.installManagerId ? ` (${item.installManagerId})` : ""}`,
    ),
  ];
}

module.exports = {
  FILE_NAME,
  KINDS,
  WHERE,
  isStrict,
  noticesFile,
  readNotices,
  recordNotice,
  clearNotice,
  formatNotice,
  summaryLines,
};
