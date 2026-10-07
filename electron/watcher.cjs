// Watches hot-reloadable workspace folders and emits debounced change events.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WATCHED_FOLDERS, resolveFolder } = require("./workspace.cjs");

/**
 * Only these files are actually read once at process start, so only these can
 * genuinely require a restart. Everything else under a watched folder is
 * re-read on demand and reloads hot.
 *
 * This list is deliberately narrow: FRIDAY writes its own preferences, model
 * registry, provider keys and service state into `config/` while it runs, and
 * treating those as "restart required" produced a restart prompt loop.
 */
const RESTART_FILES = [
  /^config[\\/]kernel\.ya?ml$/i,
  /^config[\\/]paths[\\/]/i,
  /^config[\\/]system[\\/]/i,
  /^\.env$/i,
];

/** Noise FRIDAY (or an editor) writes constantly — never a user-visible change. */
const IGNORED = [
  /(^|[\\/])\./, // dotfiles, .git, editor swap dirs
  /\.(tmp|temp|swp|swx|part|crdownload|lock|log)$/i,
  /\.sqlite3?(-wal|-shm|-journal)?$/i,
  /~$/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])(cache|logs?|temporary|backups?)([\\/]|$)/i,
  // "<root>/App" is the installed program, replaced wholesale by Setup and by
  // every update. Its churn is never a user edit.
  /^app([\\/]|$)/i,
  // Renderer-published companion snapshot (menu + coarse live state). Not a
  // user edit; rewriting it must not raise a "config reloaded" toast.
  /(^|[\\/])config[\\/]companion-features\.json$/i,
];

const isIgnored = (relative) => IGNORED.some((rx) => rx.test(relative));

const needsRestart = (relative) => RESTART_FILES.some((rx) => rx.test(relative));

function hashFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    // Large files are identified by size+mtime instead of a full read.
    if (stat.size > 2 * 1024 * 1024) return `${stat.size}:${stat.mtimeMs}`;
    return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

class WorkspaceWatcher {
  constructor(onChange) {
    this.onChange = onChange;
    this.watchers = [];
    this.timers = new Map();
    // relative path -> last content hash, so a rewrite with identical bytes
    // (very common: FRIDAY re-serializing its own JSON) emits nothing.
    this.hashes = new Map();
    this.root = null;
  }

  start(root) {
    this.stop();
    if (!root) return;
    this.root = root;
    // Seed the hashes for every file that can request a restart BEFORE
    // watching. Without this, the first time FRIDAY (or Windows) touches an
    // unchanged config file the watcher sees "no known hash" and raises a
    // restart prompt for content that never changed.
    this.seedRestartHashes(root);
    for (const relative of WATCHED_FOLDERS) {
      const dir = resolveFolder(root, relative) || path.join(root, relative);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
          this.queue(relative, filename ? String(filename) : "");
        });
        // A watched folder can disappear while FRIDAY is running. Consume the
        // native watcher error instead of letting an unhandled EventEmitter
        // error terminate the Electron main process.
        watcher.on("error", (error) => {
          this.onChange({
            component: relative,
            file: `watch stopped: ${error.message}`,
            restartRequired: false,
            at: Date.now(),
          });
        });
        this.watchers.push(watcher);
      } catch {
        /* folder missing or not watchable — skipped */
      }
    }
  }

  /** Hash the current contents of every restart-relevant file under `root`. */
  seedRestartHashes(root) {
    const walk = (dir, relative, depth) => {
      if (depth > 4) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRelative = path.join(relative, entry.name);
        if (isIgnored(childRelative)) continue;
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(child, childRelative, depth + 1);
          continue;
        }
        if (!needsRestart(childRelative)) continue;
        const hash = hashFile(child);
        if (hash) this.hashes.set(childRelative, hash);
      }
    };
    walk(path.join(root, "config"), "config", 0);
    const env = path.join(root, ".env");
    const envHash = hashFile(env);
    if (envHash) this.hashes.set(".env", envHash);
  }

  // Bursty editors fire many events; collapse them per file.
  queue(folder, filename) {
    const relative = filename ? path.join(folder, filename) : folder;
    if (isIgnored(relative)) return;
    clearTimeout(this.timers.get(relative));
    this.timers.set(
      relative,
      setTimeout(() => {
        this.timers.delete(relative);
        this.emit(folder, filename, relative);
      }, 350),
    );
  }

  emit(folder, filename, relative) {
    if (filename && this.root) {
      const absolute = path.join(this.root, relative);
      const hash = hashFile(absolute);
      if (hash) {
        if (this.hashes.get(relative) === hash) return; // identical bytes
        this.hashes.set(relative, hash);
      } else if (!fs.existsSync(absolute)) {
        this.hashes.delete(relative);
      }
    }
    this.onChange({
      component: folder,
      file: filename,
      relative,
      restartRequired: needsRestart(relative),
      at: Date.now(),
    });
  }

  stop() {
    this.watchers.forEach((w) => {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    });
    this.watchers = [];
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this.hashes.clear();
  }
}

module.exports = { WorkspaceWatcher, RESTART_FILES, needsRestart, isIgnored };
