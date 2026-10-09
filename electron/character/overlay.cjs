/**
 * FRIDAY · transparent desktop companion window
 *
 * A frameless, transparent, always-on-top BrowserWindow that renders the 2D
 * character with the GPU. It is completely separate from the main FRIDAY
 * window: creating, hiding or crashing this overlay never affects the app.
 *
 * Design notes
 *  - Click-through is real: `setIgnoreMouseEvents(true, { forward: true })`
 *    lets the desktop underneath receive every click while the renderer still
 *    sees hover, so hovering the character re-enables interaction.
 *  - The window is never focusable while click-through, so it can't steal
 *    focus from whatever the user is typing in.
 *  - A renderer crash is recovered automatically, at most a few times, and
 *    the failure is reported instead of being retried forever.
 */
const { BrowserWindow, screen, app } = require("electron");
const path = require("path");

const rendererLoader = require("../renderer.cjs");

const MIN_W = 120;
const MAX_W = 900;

class CharacterOverlay {
  /**
   * @param {object} options
   * @param {string|null} options.devUrl dev server URL when running unpackaged
   * @param {(msg:string)=>void} options.log
   * @param {(event:string, payload:any)=>void} options.onEvent renderer -> controller
   */
  constructor({ devUrl = null, log = () => {}, onEvent = () => {} } = {}) {
    this.devUrl = devUrl;
    this.log = log;
    this.onEvent = onEvent;
    this.win = null;
    this.ready = false;
    this.pending = [];
    this.interactive = false;
    this.onTop = true;
    this.crashCount = 0;
    this.lastBounds = null;
    this.destroyed = false;
  }

  exists() {
    return Boolean(this.win && !this.win.isDestroyed());
  }

  /** Create the overlay if it isn't there yet. Idempotent. */
  create(initialBounds) {
    if (this.exists()) return this.win;
    this.destroyed = false;
    const bounds = initialBounds || this.lastBounds || this.defaultBounds(260);

    this.win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false, // moved programmatically, so it can never be flung off-screen
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      acceptFirstMouse: true,
      thickFrame: false,
      paintWhenInitiallyHidden: true,
      title: "FRIDAY Companion",
      webPreferences: {
        preload: path.join(__dirname, "..", "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });

    this.win.setAlwaysOnTop(true, "screen-saver");
    try {
      // Visible on every virtual desktop, and not a window the OS should
      // include in Alt-Tab or window cycling.
      this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* platform without workspace support */
    }
    this.setClickThrough(true);

    this.win.webContents.on("did-finish-load", () => {
      this.ready = true;
      this.crashCount = 0;
      const queued = this.pending.splice(0);
      queued.forEach(([channel, payload]) => this.send(channel, payload));
      this.onEvent("loaded", null);
    });

    this.win.webContents.on("render-process-gone", (_e, details) => {
      this.log(`character overlay renderer gone: ${details?.reason}`);
      this.recover(`renderer ${details?.reason || "crashed"}`);
    });
    this.win.on("unresponsive", () => {
      this.log("character overlay unresponsive");
      this.recover("renderer unresponsive");
    });
    this.win.on("closed", () => {
      this.ready = false;
      this.win = null;
    });
    // Never let the overlay navigate anywhere or open windows.
    this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    const result = rendererLoader.load(this.win, {
      devUrl: this.devUrl,
      route: "character",
      log: this.log,
      onFailure: (message) => {
        this.log(`character overlay load failed: ${message}`);
        this.onEvent("load-failed", { message });
      },
    });
    this.log(`character overlay loading (${result.mode}) ${result.target}`);
    return this.win;
  }

  /** Recreate after a crash, but never in an endless loop. */
  recover(reason) {
    if (this.destroyed) return;
    this.crashCount += 1;
    this.ready = false;
    const bounds = this.currentBounds();
    try {
      this.win?.destroy();
    } catch {
      /* already gone */
    }
    this.win = null;
    if (this.crashCount > 3) {
      this.onEvent("failed", { reason, crashCount: this.crashCount });
      this.log(`character overlay giving up after ${this.crashCount} failures (${reason})`);
      return;
    }
    setTimeout(() => {
      if (this.destroyed) return;
      this.create(bounds);
      this.show();
      this.onEvent("recovered", { reason, attempt: this.crashCount });
    }, 900);
  }

  defaultBounds(width) {
    const display = screen.getPrimaryDisplay();
    const w = Math.round(Math.min(MAX_W, Math.max(MIN_W, width)));
    const h = Math.round(w * (1097 / 413));
    return {
      x: Math.round(display.workArea.x + display.workArea.width - w - 32),
      y: Math.round(display.workArea.y + display.workArea.height - h - 24),
      width: w,
      height: h,
    };
  }

  currentBounds() {
    if (!this.exists()) return this.lastBounds;
    try {
      this.lastBounds = this.win.getBounds();
    } catch {
      /* keep the previous value */
    }
    return this.lastBounds;
  }

  setBounds(bounds) {
    if (!this.exists()) return;
    const next = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };
    const current = this.win.getBounds();
    if (
      current.x === next.x &&
      current.y === next.y &&
      current.width === next.width &&
      current.height === next.height
    ) {
      return;
    }
    try {
      this.win.setBounds(next);
      this.lastBounds = next;
      this.ensureTopmost();
    } catch {
      /* window went away between the check and the call */
    }
  }

  setSize(width, height) {
    const bounds = this.currentBounds() || this.defaultBounds(width);
    this.setBounds({ ...bounds, width, height });
  }

  /**
   * Click-through: the desktop below keeps receiving clicks while the
   * renderer still gets hover events so it can ask to become interactive.
   */
  setClickThrough(enabled) {
    if (!this.exists()) return;
    this.interactive = !enabled;
    try {
      this.win.setIgnoreMouseEvents(Boolean(enabled), { forward: true });
      this.win.setFocusable(!enabled);
    } catch {
      /* ignore */
    }
  }

  setAlwaysOnTop(enabled) {
    if (!this.exists()) return;
    this.onTop = Boolean(enabled);
    try {
      // "screen-saver" is the only level that reliably floats above a
      // foreground / fullscreen application on Windows; "normal" lets the
      // focused app cover the companion, which reads as "not showing".
      this.win.setAlwaysOnTop(this.onTop, this.onTop ? "screen-saver" : "normal", 1);
    } catch {
      /* ignore */
    }
  }

  /**
   * Windows silently drops the topmost flag when another app takes the
   * foreground or a fullscreen window appears. Re-assert it whenever we show
   * or reposition the companion.
   */
  ensureTopmost() {
    if (!this.exists() || this.onTop === false) return;
    try {
      this.win.setAlwaysOnTop(true, "screen-saver", 1);
      this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* platform without workspace support */
    }
  }

  setOpacity(value) {
    if (!this.exists()) return;
    try {
      this.win.setOpacity(Math.min(1, Math.max(0.1, Number(value) || 1)));
    } catch {
      /* ignore */
    }
  }

  show() {
    if (!this.exists()) return;
    try {
      // showInactive keeps the user's focus exactly where it was.
      this.win.showInactive();
      this.ensureTopmost();
    } catch {
      /* ignore */
    }
  }

  hide() {
    if (!this.exists()) return;
    try {
      this.win.hide();
    } catch {
      /* ignore */
    }
  }

  isVisible() {
    return this.exists() && this.win.isVisible();
  }

  send(channel, payload) {
    if (!this.exists()) return;
    if (!this.ready) {
      this.pending.push([channel, payload]);
      if (this.pending.length > 40) this.pending.splice(0, this.pending.length - 40);
      return;
    }
    try {
      this.win.webContents.send(channel, payload);
    } catch {
      /* window closing */
    }
  }

  destroy() {
    this.destroyed = true;
    this.currentBounds();
    this.ready = false;
    try {
      this.win?.destroy();
    } catch {
      /* already gone */
    }
    this.win = null;
  }

  webContentsId() {
    return this.exists() ? this.win.webContents.id : null;
  }
}

module.exports = { CharacterOverlay, MIN_W, MAX_W };
