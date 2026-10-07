/**
 * FRIDAY · owner sense feed (main process).
 *
 * Subscribes only to switches that are on. Off means no listener and no poll.
 * Folder changes stay on the existing workspace watcher. Clipboard text is
 * redacted and is not read while a password manager is in front.
 * The Windows title poll is unverified until it runs on the owner's PC.
 */
const clipboard = require("./clipboard-history.cjs");

/** Caption only. No keys, no pixels. */
const FOREGROUND_TITLE_SCRIPT =
  'Add-Type -TypeDefinition \'using System; using System.Text; using System.Runtime.InteropServices; public class FridayForeground { [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, StringBuilder s, int n); public static string Title() { var b = new StringBuilder(256); GetWindowText(GetForegroundWindow(), b, 256); return b.ToString(); } }\'; [FridayForeground]::Title()';

function readForegroundTitle() {
  if (process.platform !== "win32") return "";
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", FOREGROUND_TITLE_SCRIPT],
      { timeout: 1500, windowsHide: true, encoding: "utf8" },
    );
    return String(out || "")
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, 120);
  } catch {
    return "";
  }
}

function splitFolders(field) {
  return String(field || "")
    .split(/[\n,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function createSenseFeed(deps = {}) {
  let live = false;
  const attached = [];
  const intervalIds = [];
  const power = deps.powerMonitor || null;
  const state = {
    lastTitle: "",
    lastClip: "",
    lastOnline: null,
    lastIdle: false,
    lastCalendar: "",
  };

  function now() {
    return typeof deps.now === "function" ? Number(deps.now()) || 0 : 0;
  }

  function emit(raw) {
    if (!live || !raw) return;
    try {
      if (typeof deps.emit === "function") deps.emit(raw);
    } catch {
      /* one bad listener must not kill the feed */
    }
  }

  function arm(ms, fn) {
    if (typeof deps.schedule === "function") {
      deps.schedule(ms, fn);
      return;
    }
    intervalIds.push(setInterval(fn, ms));
  }

  function listen(event, fn) {
    if (!power || typeof power.on !== "function") return;
    power.on(event, fn);
    attached.push([event, fn]);
  }

  function stop() {
    live = false;
    if (power && typeof power.removeListener === "function") {
      for (const [event, fn] of attached) {
        try {
          power.removeListener(event, fn);
        } catch {
          /* already gone */
        }
      }
    }
    attached.length = 0;
    for (const id of intervalIds) clearInterval(id);
    intervalIds.length = 0;
    state.lastTitle = "";
    state.lastClip = "";
    state.lastOnline = null;
    state.lastIdle = false;
    state.lastCalendar = "";
    if (typeof deps.watchFolders === "function") {
      try {
        deps.watchFolders([]);
      } catch {
        /* the workspace watcher stays on its last list */
      }
    }
  }

  function apply(toggles = {}, fields = {}) {
    stop();
    live = true;
    const on = (key) => toggles[key] === true;

    if (on("senseLock")) {
      listen("lock-screen", () => emit({ sense: "lock", at: now(), text: "locked" }));
      listen("unlock-screen", () => emit({ sense: "lock", at: now(), text: "unlocked" }));
    }
    if (on("sensePower")) {
      listen("suspend", () => emit({ sense: "power", at: now(), text: "suspend" }));
      listen("resume", () => emit({ sense: "power", at: now(), text: "resume" }));
      listen("on-battery", () => emit({ sense: "power", at: now(), text: "battery" }));
      listen("on-ac", () => emit({ sense: "power", at: now(), text: "ac" }));
    }
    if (on("senseForeground")) {
      arm(deps.foregroundMs || 5000, () => {
        let title = "";
        try {
          const reader = deps.foregroundTitle || readForegroundTitle;
          title = String(reader() || "");
        } catch {
          title = "";
        }
        title = title
          .replace(/[\r\n]+/g, " ")
          .trim()
          .slice(0, 120);
        if (!title || title === state.lastTitle) return;
        state.lastTitle = title;
        emit({ sense: "foreground", at: now(), text: title });
      });
    }
    if (on("senseNetwork")) {
      arm(deps.networkMs || 10000, () => {
        let online = false;
        try {
          online = Boolean(typeof deps.online === "function" ? deps.online() : false);
        } catch {
          online = false;
        }
        if (state.lastOnline === online) return;
        state.lastOnline = online;
        emit({ sense: "network", at: now(), text: online ? "online" : "offline" });
      });
    }
    if (on("senseIdle")) {
      arm(deps.idleMs || 15000, () => {
        let idle = false;
        try {
          idle = Boolean(typeof deps.idle === "function" ? deps.idle() : false);
        } catch {
          idle = false;
        }
        if (idle === state.lastIdle) return;
        state.lastIdle = idle;
        if (!idle) return;
        emit({ sense: "idle", at: now(), text: "idle" });
      });
    }
    if (on("senseClipboard")) {
      arm(deps.clipboardMs || 15000, () => {
        let title = "";
        try {
          const reader = deps.foregroundTitle || readForegroundTitle;
          title = String(reader() || "");
        } catch {
          title = "";
        }
        if (clipboard.blockedSource(title)) return;
        let text = "";
        try {
          text = String(typeof deps.readClipboard === "function" ? deps.readClipboard() : "");
        } catch {
          text = "";
        }
        const peeked = clipboard.peek({ text, sourceApp: title });
        if (!peeked || peeked.text === state.lastClip) return;
        state.lastClip = peeked.text;
        emit({ sense: "clipboard", at: now(), text: peeked.text });
        if (typeof deps.noteClip === "function") {
          try {
            deps.noteClip(peeked.text, now());
          } catch {
            /* history is optional */
          }
        }
      });
    }
    if (on("senseCalendar")) {
      arm(deps.calendarMs || 60000, () => {
        let titles = [];
        try {
          const value = typeof deps.calendarTitles === "function" ? deps.calendarTitles() : [];
          titles = Array.isArray(value) ? value : [];
        } catch {
          titles = [];
        }
        const text = titles
          .map((line) =>
            String(line || "")
              .replace(/\s+/g, " ")
              .trim(),
          )
          .filter(Boolean)
          .slice(0, 3)
          .join("; ")
          .slice(0, 240);
        if (!text || text === state.lastCalendar) return;
        state.lastCalendar = text;
        emit({ sense: "calendar", at: now(), text });
      });
    }
    if (typeof deps.watchFolders === "function") {
      try {
        deps.watchFolders(on("senseFolder") ? splitFolders(fields.senseFolders) : []);
      } catch {
        /* the workspace watcher stays on its last list */
      }
    }
  }

  return { apply, stop };
}

module.exports = {
  createSenseFeed,
  readForegroundTitle,
  FOREGROUND_TITLE_SCRIPT,
  splitFolders,
};
