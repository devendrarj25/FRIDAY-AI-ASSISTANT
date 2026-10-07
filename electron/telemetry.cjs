/**
 * FRIDAY · shared telemetry ring (main process).
 *
 * One in-memory ring for logs, IPC traffic and performance samples. Log lines
 * are also appended to `<FRIDAY_ROOT>/logs/main.log` so the Logs page, Chat,
 * Auto Mode and a restart all see the same stream. Sampling is passive —
 * nothing here polls. Caps keep a long session from growing unbounded.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const paths = require("./friday-paths.cjs");

const LIMIT = 300;
const LEVELS = new Set(["info", "debug", "warn", "error"]);

const ring = (limit = LIMIT) => {
  const items = [];
  return {
    push(entry) {
      items.push(entry);
      if (items.length > limit) items.splice(0, items.length - limit);
      return entry;
    },
    list(count = limit) {
      return items.slice(-count);
    },
    clear() {
      items.length = 0;
    },
    get size() {
      return items.length;
    },
  };
};

const logs = ring();
const ipc = ring();
const perf = ring(120);

let seq = 0;
let ipcSeq = 0;
let hydrating = false;
let emit = () => {};

function init(send) {
  emit = typeof send === "function" ? send : () => {};
}

function asLevel(value) {
  const level = String(value || "info").toLowerCase();
  return LEVELS.has(level) ? level : "info";
}

function nextId() {
  seq += 1;
  return `log-${seq}`;
}

function logPath() {
  try {
    return paths.logFile();
  } catch {
    return null;
  }
}

function formatLogLine(entry) {
  const iso = new Date(entry.at || Date.now()).toISOString();
  return `[${iso}] [${asLevel(entry.level)}] ${entry.source || "main"} ${String(entry.message || "")}`;
}

/** Parse one disk line (modern stamp or the older `[ISO] message` form). */
function parseLogLine(line) {
  const text = String(line || "").replace(/\s+$/, "");
  if (!text) return null;
  const modern = /^\[([^\]]+)\] \[([a-z]+)\] (\S+) ([\s\S]*)$/i.exec(text);
  if (modern) {
    const at = Date.parse(modern[1]);
    return {
      at: Number.isFinite(at) ? at : Date.now(),
      level: asLevel(modern[2]),
      source: modern[3],
      message: modern[4],
    };
  }
  const legacy = /^\[([^\]]+)\] ([\s\S]*)$/.exec(text);
  if (legacy) {
    const at = Date.parse(legacy[1]);
    return {
      at: Number.isFinite(at) ? at : Date.now(),
      level: "info",
      source: "main",
      message: legacy[2],
    };
  }
  return { at: Date.now(), level: "info", source: "main", message: text };
}

function persist(entry) {
  if (hydrating) return;
  if (process.env.VITEST) return;
  // Kernel stdout is already forwarded by main.cjs; everything else still
  // prints so a packaged run without the Logs page open is diagnosable.
  if (entry.source !== "kernel") {
    try {
      process.stdout.write(`${formatLogLine(entry)}\n`);
    } catch {
      /* stdout gone */
    }
  }
  const file = logPath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${formatLogLine(entry)}\n`, "utf8");
  } catch {
    /* logging must never take the app down */
  }
}

function sendToRenderer(channel, payload) {
  try {
    emit(channel, payload);
  } catch {
    /* renderer gone */
  }
}

function recordLog(level, source, message) {
  const entry = {
    id: nextId(),
    at: Date.now(),
    level: asLevel(level),
    source: String(source || "main"),
    message: String(message).slice(0, 4000),
  };
  logs.push(entry);
  persist(entry);
  sendToRenderer("telemetry:log", entry);
  return entry;
}

/** Recorded by the ipcMain wrapper for every call, success or failure. */
function recordIpc(entry) {
  ipcSeq += 1;
  const row = { id: `ipc-${ipcSeq}`, at: Date.now(), ...entry };
  ipc.push(row);
  sendToRenderer("telemetry:ipc", row);
  return row;
}

function sizeOf(value) {
  try {
    return value === undefined ? 0 : JSON.stringify(value).length;
  } catch {
    return -1; // non-serialisable payload (handles, buffers)
  }
}

function samplePerformance(extra = {}) {
  const mem = process.memoryUsage();
  return perf.push({
    at: Date.now(),
    rssMb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
    heapMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
    uptimeSec: Math.round(process.uptime()),
    loadAvg: Math.round((os.loadavg()[0] || 0) * 100) / 100,
    freeMemMb: Math.round(os.freemem() / (1024 * 1024)),
    ...extra,
  });
}

function readTail(file, maxBytes = 256000) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function hydrateFromText(text) {
  hydrating = true;
  try {
    const parsed = [];
    for (const line of String(text || "").split(/\r?\n/)) {
      const entry = parseLogLine(line);
      if (entry) parsed.push(entry);
    }
    const keep = parsed.slice(-LIMIT);
    for (const entry of keep) {
      logs.push({ id: nextId(), ...entry });
    }
    return keep.length;
  } finally {
    hydrating = false;
  }
}

/** Replace the ring with the tail of `<root>/logs/main.log`. */
function hydrate() {
  logs.clear();
  seq = 0;
  const file = logPath();
  let result = { ok: true, loaded: 0, file: file || null };
  if (!paths.root() || !file) {
    sendToRenderer("telemetry:cleared", { at: Date.now(), reason: "hydrate" });
    return result;
  }
  try {
    if (!fs.existsSync(file)) {
      sendToRenderer("telemetry:cleared", { at: Date.now(), reason: "hydrate" });
      return { ok: true, loaded: 0, file };
    }
    const loaded = hydrateFromText(readTail(file));
    result = { ok: true, loaded, file };
  } catch (error) {
    result = { ok: false, loaded: 0, file, error: String(error.message || error) };
  }
  sendToRenderer("telemetry:cleared", { at: Date.now(), reason: "hydrate" });
  return result;
}

function clearLogs() {
  logs.clear();
  sendToRenderer("telemetry:cleared", { at: Date.now() });
  return { ok: true };
}

function listFiles() {
  if (!paths.root()) return { ok: false, error: "No FRIDAY workspace is selected.", files: [] };
  const file = logPath();
  if (!file) return { ok: false, error: "Log folder is not available.", files: [] };
  const dir = path.dirname(file);
  try {
    if (!fs.existsSync(dir)) return { ok: true, dir, files: [] };
    const files = [];
    const walk = (current, rel) => {
      if (files.length >= 80) return;
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= 80) return;
        const relative = rel ? `${rel}/${entry.name}` : entry.name;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full, relative);
        else if (entry.isFile()) {
          let size = 0;
          let mtime = 0;
          try {
            const st = fs.statSync(full);
            size = st.size;
            mtime = st.mtimeMs;
          } catch {
            /* skip */
          }
          files.push({ rel: relative, size, mtime });
        }
      }
    };
    walk(dir, "");
    files.sort((a, b) => b.mtime - a.mtime);
    return { ok: true, dir, files };
  } catch (error) {
    return { ok: false, dir, files: [], error: String(error.message || error) };
  }
}

function readLogFile(rel = "main.log", limit = 80000) {
  if (!paths.root()) return { ok: false, error: "No FRIDAY workspace is selected." };
  const file = logPath();
  if (!file) return { ok: false, error: "Log folder is not available." };
  const dir = path.resolve(path.dirname(file));
  const target = path.resolve(dir, String(rel || "main.log").replace(/^[\\/]+/, ""));
  if (target !== dir && !target.startsWith(dir + path.sep)) {
    return { ok: false, error: "Path escapes the logs folder." };
  }
  try {
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return { ok: false, error: "That log file is not there." };
    }
    const text = readTail(target, limit);
    return { ok: true, rel: path.relative(dir, target).replace(/\\/g, "/"), text };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

function snapshot() {
  samplePerformance();
  return {
    at: Date.now(),
    logs: logs.list(),
    ipc: ipc.list(),
    perf: perf.list(60),
    counts: { logs: logs.size, ipc: ipc.size, perf: perf.size },
    file: logPath(),
  };
}

module.exports = {
  LIMIT,
  init,
  recordLog,
  recordIpc,
  samplePerformance,
  sizeOf,
  snapshot,
  hydrate,
  hydrateFromText,
  clearLogs,
  listFiles,
  readLogFile,
  parseLogLine,
  formatLogLine,
  logs,
  ipc,
  perf,
};
