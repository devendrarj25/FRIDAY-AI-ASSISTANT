/**
 * FRIDAY · Self Atlas (read-only)
 *
 * One live, typed answer to "where am I, what am I, what is running, what state am I in".
 * It is built from real probes of this PC and never from memory or training knowledge.
 * Every fact names its `source`, the time it was read (`readAt`) and a `confidence`;
 * anything that could not be inspected is `unknown` with the reason, never "ok".
 *
 * Nothing here writes, spawns or changes anything. It composes the owners that already know:
 * `friday-paths.cjs` (the folders), `service-health.cjs` (the engines), `install-inventory.cjs`
 * (tools and models), the kernel's `/health`, the shipped defaults beside the app. The main
 * process hands them in through `ctx`, so a test can point the same builder at a throwaway root.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SCHEMA = 1;
const STATUSES = ["ok", "warn", "bad", "unknown"];
const GROUPS = [
  "location",
  "version",
  "processes",
  "config",
  "data",
  "backups",
  "logs",
  "inventory",
];
const WALK_LIMIT = 5000;
const SQLITE_MAGIC = "SQLite format 3\u0000";

/** A fact the owner (or FRIDAY) can quote. `readAt` is when the probe ran. */
function fact(group, id, label, value, status, source, readAt, confidence, note) {
  return {
    group,
    id,
    label,
    value: String(value),
    status: STATUSES.includes(status) ? status : "unknown",
    source,
    readAt,
    confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
    ...(note ? { note: String(note) } : {}),
  };
}

/** Run one probe; a throw becomes an honest "not inspected" fact, never a healthy one. */
async function probe(out, group, id, label, source, readAt, run) {
  try {
    const got = await run();
    const rows = Array.isArray(got) ? got : [got];
    for (const row of rows) {
      if (!row) continue;
      out.push(
        fact(
          group,
          row.id || id,
          row.label || label,
          row.value,
          row.status,
          row.source || source,
          readAt,
          row.confidence,
          row.note,
        ),
      );
    }
  } catch (error) {
    out.push(
      fact(
        group,
        id,
        label,
        "not inspected",
        "unknown",
        source,
        readAt,
        0,
        error && error.message ? error.message : "probe failed",
      ),
    );
  }
}

const bytesText = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
};

const ageText = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "under a minute ago";
  if (minutes < 120) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 72) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
};

/** Files, bytes and newest mtime under a folder. Bounded, never follows links. */
function measureDir(dir, limit = WALK_LIMIT) {
  const out = { exists: false, files: 0, bytes: 0, newest: 0, truncated: false };
  let top;
  try {
    top = fs.statSync(dir);
  } catch {
    return out;
  }
  if (!top.isDirectory()) return out;
  out.exists = true;
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > limit) {
        out.truncated = true;
        return out;
      }
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        const stat = fs.statSync(full);
        out.files += 1;
        out.bytes += stat.size;
        if (stat.mtimeMs > out.newest) out.newest = stat.mtimeMs;
      } catch {
        /* a file that vanished mid-walk is not a fault */
      }
    }
  }
  return out;
}

/** The SQLite file header, read without opening the database. A structural check only. */
function sqliteHeader(file) {
  const handle = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(100);
    const read = fs.readSync(handle, head, 0, 100, 0);
    const size = fs.fstatSync(handle).size;
    if (read < 100) return { valid: false, size, reason: "file is shorter than a SQLite header" };
    if (head.toString("latin1", 0, 16) !== SQLITE_MAGIC) {
      return { valid: false, size, reason: "the SQLite signature is missing" };
    }
    let pageSize = head.readUInt16BE(16);
    if (pageSize === 1) pageSize = 65536;
    const pages = head.readUInt32BE(28);
    const looksAligned = pageSize >= 512 && (pageSize & (pageSize - 1)) === 0;
    if (!looksAligned) return { valid: false, size, reason: `odd page size ${pageSize}` };
    const expected = pages * pageSize;
    const tornTail = pages > 0 && size < expected;
    return {
      valid: !tornTail,
      size,
      pageSize,
      pages,
      reason: tornTail ? "file is shorter than its page count" : "",
    };
  } finally {
    fs.closeSync(handle);
  }
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** `automation.auto_approve_exec` from a kernel.yaml text, or null when it is not there. */
function autoApproveExec(text) {
  const match = /^\s*auto_approve_exec:\s*(true|false)\b/m.exec(String(text || ""));
  return match ? match[1] === "true" : null;
}

/** How this EXE was started, from facts the process already has. */
function installKind(ctx) {
  if (ctx.portableDir) return "portable EXE";
  if (!ctx.isPackaged) return "source checkout (not an installed EXE)";
  return "installed (Setup)";
}

const FATAL_LINE = /\b(fatal|traceback|unhandled|uncaught|exception|error)\b/i;

function tailText(file, maxBytes = 65536) {
  const handle = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(handle).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Build the atlas.
 *
 * ctx: { now, root, appDir, exePath, isPackaged, portableDir, channel, version, epoch, runtime,
 *        pid, kernel(), services(), shippedConfig(name), databaseFile, inventory() }
 * Every member is optional; a missing one makes its facts `unknown`.
 */
async function buildAtlas(ctx = {}) {
  const now = typeof ctx.now === "function" ? ctx.now() : Date.now();
  const facts = [];
  const root = ctx.root ? path.resolve(ctx.root) : "";
  const add = (group, id, label, source, run) => probe(facts, group, id, label, source, now, run);

  /* ---------------------------------------------------------------- location */
  await add("location", "root", "FRIDAY folder", "friday-paths.cjs", () => {
    if (!root) {
      return { value: "no FRIDAY folder selected", status: "bad", confidence: 1 };
    }
    const exists = fs.existsSync(root);
    let writable = false;
    try {
      fs.accessSync(root, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
    return {
      value: root,
      status: !exists ? "bad" : writable ? "ok" : "warn",
      confidence: 1,
      note: !exists ? "the folder does not exist" : writable ? "" : "the folder is not writable",
    };
  });
  await add("location", "app-dir", "App folder", "friday-paths.cjs programDir", () => {
    if (!ctx.appDir) return { value: "not reported", status: "unknown", confidence: 0 };
    const exists = fs.existsSync(ctx.appDir);
    return { value: ctx.appDir, status: exists ? "ok" : "warn", confidence: exists ? 1 : 0.8 };
  });
  await add("location", "exe", "Running EXE", "Electron app.getPath('exe')", () => ({
    value: ctx.exePath ? `${ctx.exePath} · ${installKind(ctx)}` : installKind(ctx),
    status: ctx.exePath ? "ok" : "unknown",
    confidence: ctx.exePath ? 1 : 0.4,
  }));
  await add("location", "channel", "Build channel", "build-channel.cjs", () => ({
    value: ctx.channel || "not reported",
    status: ctx.channel ? "ok" : "unknown",
    confidence: ctx.channel ? 1 : 0,
    note: ctx.channel === "test" ? "a test build keeps its own state under profiles/test" : "",
  }));

  /* ----------------------------------------------------------------- version */
  await add("version", "friday", "FRIDAY version", "config/friday-version.json", () => ({
    value: ctx.version
      ? `${ctx.version}${ctx.epoch ? ` · epoch ${ctx.epoch}` : ""}`
      : "not reported",
    status: ctx.version ? "ok" : "unknown",
    confidence: ctx.version ? 1 : 0,
  }));
  await add("version", "runtime", "Runtime", "process.versions", () => {
    const runtime = ctx.runtime || {};
    const parts = ["electron", "node", "chrome"]
      .filter((name) => runtime[name])
      .map((name) => `${name} ${runtime[name]}`);
    return {
      value: parts.join(" · ") || "not reported",
      status: parts.length ? "ok" : "unknown",
      confidence: parts.length ? 1 : 0,
    };
  });

  /* --------------------------------------------------------------- processes */
  await add("processes", "electron-main", "Desktop process", "process.pid", () => ({
    value: ctx.pid ? `pid ${ctx.pid}` : "not reported",
    status: ctx.pid ? "ok" : "unknown",
    confidence: ctx.pid ? 1 : 0,
  }));
  await add("processes", "kernel", "Python kernel", "kernel /health", async () => {
    if (typeof ctx.kernel !== "function") {
      return { value: "not inspected", status: "unknown", confidence: 0 };
    }
    const got = await ctx.kernel();
    if (!got || !got.reachable) {
      return {
        value: "not reachable",
        status: "bad",
        confidence: 0.9,
        note: (got && got.error) || "the kernel did not answer /health",
      };
    }
    const health = got.health || {};
    const insideRoot =
      !root || !health.data_dir || path.resolve(String(health.data_dir)).startsWith(root);
    const parts = [
      health.version ? `version ${health.version}` : "",
      got.port ? `port ${got.port}` : "",
      got.pid ? `pid ${got.pid}` : "",
      health.instance_id ? `instance ${String(health.instance_id).slice(0, 8)}` : "",
    ].filter(Boolean);
    const mismatch =
      ctx.version &&
      health.version &&
      !String(health.version).startsWith(String(ctx.version).split(".").slice(0, 3).join("."));
    return {
      value: parts.join(" · ") || "answering",
      status: !insideRoot ? "bad" : mismatch ? "warn" : "ok",
      confidence: 0.95,
      note: !insideRoot
        ? `the kernel stores data outside the FRIDAY folder: ${health.data_dir}`
        : mismatch
          ? `kernel version ${health.version} differs from the app version ${ctx.version}`
          : "",
    };
  });
  await add("processes", "services", "Local engines", "service-health.cjs", async () => {
    if (typeof ctx.services !== "function") {
      return { value: "not inspected", status: "unknown", confidence: 0 };
    }
    const rows = (await ctx.services()) || [];
    const online = rows.filter((row) => row.state === "online");
    return {
      value: rows.length
        ? `${online.length}/${rows.length} online${online.length ? `: ${online.map((row) => row.name).join(", ")}` : ""}`
        : "none reported",
      status: rows.length ? "ok" : "unknown",
      confidence: rows.length ? 0.9 : 0.3,
      note: "an offline engine is normal when it is not installed or not needed",
    };
  });

  /* ------------------------------------------------------------------ config */
  const configDir = root ? path.join(root, "config") : "";
  for (const name of ["kernel.yaml", "models.yaml"]) {
    await add("config", name, `${name} in effect`, "config folder vs shipped defaults", () => {
      const live = path.join(configDir, name);
      if (!configDir || !fs.existsSync(live)) {
        return {
          value: "missing",
          status: "warn",
          confidence: 0.9,
          note: "the shipped default will be seeded on start",
        };
      }
      const shipped = typeof ctx.shippedConfig === "function" ? ctx.shippedConfig(name) : null;
      const pending = fs.existsSync(`${live}.new`);
      if (!shipped || !fs.existsSync(shipped)) {
        return {
          value: "present · shipped default not found to compare",
          status: "unknown",
          confidence: 0.5,
        };
      }
      const same = sha256(live) === sha256(shipped);
      return {
        value: same ? "matches the shipped default" : "edited by the owner",
        status: pending ? "warn" : "ok",
        confidence: 1,
        note: pending ? `${name}.new holds a newer shipped default waiting for review` : "",
      };
    });
  }
  await add(
    "config",
    "auto-approve-exec",
    "Run-without-asking switch",
    "config/kernel.yaml",
    () => {
      const live = configDir ? path.join(configDir, "kernel.yaml") : "";
      if (!live || !fs.existsSync(live))
        return { value: "not readable", status: "unknown", confidence: 0 };
      const value = autoApproveExec(fs.readFileSync(live, "utf8"));
      if (value === null)
        return { value: "not set in the file", status: "unknown", confidence: 0.6 };
      return {
        value: `automation.auto_approve_exec: ${value}`,
        status: value ? "bad" : "ok",
        confidence: 1,
        note: value ? "this must stay false: FRIDAY would run commands without asking" : "",
      };
    },
  );

  /* -------------------------------------------------------------------- data */
  await add("data", "database", "Database", "database file header", () => {
    const file = ctx.databaseFile || (root ? path.join(root, "database", "friday.sqlite3") : "");
    if (!file || !fs.existsSync(file)) {
      return { value: "no database file yet", status: "warn", confidence: 0.9 };
    }
    const head = sqliteHeader(file);
    const wal = fs.existsSync(`${file}-wal`) ? " · WAL present" : "";
    return {
      value: `${bytesText(head.size)} · ${head.valid ? "header valid" : `header problem: ${head.reason}`}${wal}`,
      status: head.valid ? "ok" : "bad",
      confidence: 0.6,
      note: "a header check only; the full integrity check runs in the kernel and was not run here",
    };
  });
  await add("data", "memory", "Memory folders", "memory/", () => {
    const got = measureDir(root ? path.join(root, "memory") : "");
    if (!got.exists) return { value: "folder missing", status: "warn", confidence: 0.9 };
    return {
      value: `${got.files} file(s) · ${bytesText(got.bytes)}${got.truncated ? " · partial count" : ""}`,
      status: "ok",
      confidence: got.truncated ? 0.6 : 0.9,
    };
  });

  /* ----------------------------------------------------------------- backups */
  await add("backups", "backups", "Backups", "backup/", () => {
    const got = measureDir(root ? path.join(root, "backup") : "");
    if (!got.exists) return { value: "no backup folder", status: "warn", confidence: 0.9 };
    if (!got.files) return { value: "no backup yet", status: "warn", confidence: 0.9 };
    return {
      value: `${got.files} file(s) · ${bytesText(got.bytes)} · newest ${ageText(now - got.newest)}`,
      status: "ok",
      confidence: got.truncated ? 0.6 : 0.9,
    };
  });

  /* -------------------------------------------------------------------- logs */
  await add("logs", "logs", "Logs", "logs/", () => {
    const dir = root ? path.join(root, "logs") : "";
    const got = measureDir(dir);
    if (!got.exists || !got.files)
      return { value: "no log file yet", status: "unknown", confidence: 0.8 };
    let newestFile = "";
    let newestTime = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const stat = fs.statSync(path.join(dir, entry.name));
      if (stat.mtimeMs > newestTime) {
        newestTime = stat.mtimeMs;
        newestFile = entry.name;
      }
    }
    let errors = 0;
    if (newestFile) {
      errors = tailText(path.join(dir, newestFile))
        .split(/\r?\n/)
        .filter((line) => FATAL_LINE.test(line)).length;
    }
    return {
      value: `${got.files} file(s) · ${bytesText(got.bytes)} · newest ${newestFile || "?"} ${ageText(now - got.newest)}`,
      status: errors ? "warn" : "ok",
      confidence: 0.8,
      note: errors ? `${errors} line(s) with an error word in the last 64 KB of ${newestFile}` : "",
    };
  });

  /* --------------------------------------------------------------- inventory */
  await add("inventory", "inventory", "Installed tools and models", "inventory.json", () => {
    const got = typeof ctx.inventory === "function" ? ctx.inventory() : null;
    if (!got || !Array.isArray(got.items)) {
      return {
        value: "inventory not written yet",
        status: "unknown",
        confidence: 0.4,
        note: "open Install Manager once to write it",
      };
    }
    const outdated = got.items.filter((item) => item.updateAvailable).length;
    return {
      value: `${got.items.length} item(s)${outdated ? ` · ${outdated} with an update` : ""}`,
      status: outdated ? "warn" : "ok",
      confidence: 0.85,
    };
  });

  const counts = { ok: 0, warn: 0, bad: 0, unknown: 0 };
  for (const row of facts) counts[row.status] += 1;
  const groups = {};
  for (const name of GROUPS) {
    const rows = facts.filter((row) => row.group === name);
    groups[name] = {
      total: rows.length,
      ok: rows.filter((row) => row.status === "ok").length,
      warn: rows.filter((row) => row.status === "warn").length,
      bad: rows.filter((row) => row.status === "bad").length,
      unknown: rows.filter((row) => row.status === "unknown").length,
    };
  }
  return {
    schema: SCHEMA,
    readAt: now,
    root,
    facts,
    groups,
    counts,
    summary: `${facts.length} facts read: ${counts.ok} ok, ${counts.warn} warn, ${counts.bad} bad, ${counts.unknown} not inspected`,
  };
}

module.exports = {
  SCHEMA,
  GROUPS,
  buildAtlas,
  measureDir,
  sqliteHeader,
  autoApproveExec,
  installKind,
  bytesText,
  ageText,
};
