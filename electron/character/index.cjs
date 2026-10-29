/**
 * FRIDAY · desktop companion controller
 *
 * Owns the character feature in the main process and wires it to the parts of
 * FRIDAY that already exist. It is strictly additive: if the feature is off
 * (the default until the user enables it) nothing is created, no tracker
 * runs and no timer ticks.
 *
 * Responsibilities
 *  - persist the character settings inside the FRIDAY root (state/character.json)
 *  - create/destroy the transparent overlay window
 *  - drive placement from the REAL foreground window / cursor
 *  - relay live FRIDAY state (from the main window) to the overlay
 *  - relay what the overlay asks (chat, voice, actions) back to the main
 *    window so every request goes through the existing brain, permission and
 *    billing pipeline — the character never talks to a model itself
 */
const fs = require("fs");
const path = require("path");
const { screen } = require("electron");

const paths = require("../friday-paths.cjs");
const runtime = require("./runtime.cjs");
const { CharacterOverlay } = require("./overlay.cjs");
const { WindowTracker } = require("./window-tracker.cjs");
const { MouseTracker } = require("./mouse-tracker.cjs");

const DEFAULTS = {
  enabled: false,
  autoStart: false,
  characterId: runtime.CHARACTER_ID,
  width: 240,
  opacity: 1,
  placement: "free", // free | title-bar | active-window | corner | mouse
  corner: "bottom-right",
  offsetX: 24,
  offsetY: 16,
  freeX: null,
  freeY: null,
  displayId: null,
  alwaysOnTop: true,
  clickThrough: true,
  gaze: true,
  followSpeed: 0.18,
  hideOnFullscreen: true,
  hideWhenIdle: false,
  speechBubble: true,
  miniChat: true,
  voiceReplies: true,
  quality: "high", // high | balanced | battery
  reduceMotion: false,
  greeting: true,
};

const ASPECT = 1097 / 413; // real height/width of the character crop

class CharacterController {
  constructor({ log = () => {}, devUrl = null, sendToMain = () => {} } = {}) {
    this.log = log;
    this.devUrl = devUrl;
    this.sendToMain = sendToMain;
    this.settings = { ...DEFAULTS };
    this.loaded = false;
    this.overlay = null;
    this.windowTracker = new WindowTracker(log);
    this.mouseTracker = new MouseTracker(60);
    this.unsubscribeWindow = null;
    this.unsubscribeMouse = null;
    this.lastState = { action: "idle", emotion: "calm", phase: "idle", speech: "", at: Date.now() };
    this.hiddenByFullscreen = false;
    this.placeTimer = null;
    this.lastGazeSentAt = 0;
    this.displaysBound = false;
    this.onDisplayChange = null;

    this.status = { running: false, lastError: null, recovered: 0 };
  }

  /* ------------------------------------------------------------ settings */

  file() {
    return paths.stateFile("character");
  }

  load() {
    if (this.loaded) return this.settings;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf8"));
      this.settings = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
    } catch {
      this.settings = { ...DEFAULTS };
    }
    this.loaded = true;
    return this.settings;
  }

  save() {
    try {
      const file = this.file();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.settings, null, 2));
    } catch (error) {
      this.log(`character: settings save failed — ${String(error?.message || error)}`);
    }
  }

  get() {
    this.load();
    return {
      settings: this.settings,
      running: Boolean(this.overlay?.isVisible()),
      created: Boolean(this.overlay?.exists()),
      status: this.status,
      trackerSupported: this.windowTracker.supported,
    };
  }

  set(patch) {
    this.load();
    const before = { ...this.settings };
    this.settings = { ...this.settings, ...(patch && typeof patch === "object" ? patch : {}) };
    this.settings.width = Math.min(
      560,
      Math.max(120, Number(this.settings.width) || DEFAULTS.width),
    );
    this.settings.opacity = Math.min(1, Math.max(0.2, Number(this.settings.opacity) || 1));
    this.save();
    this.apply(before);
    return this.get();
  }

  /* -------------------------------------------------------------- runtime */

  /** Bring the overlay in line with the current settings. */
  apply(before = {}) {
    const s = this.settings;
    if (!s.enabled) {
      this.stop();
      return;
    }
    if (!runtime.isHealthy()) {
      // Install the assets on demand: enabling the character is the request.
      const result = runtime.install();
      if (!result.ok) {
        this.status = { running: false, lastError: result.error, recovered: this.status.recovered };
        this.log(`character: cannot start — ${result.error}`);
        return;
      }
    }
    if (!this.overlay) {
      this.overlay = new CharacterOverlay({
        devUrl: this.devUrl,
        log: this.log,
        onEvent: (event, payload) => this.onOverlayEvent(event, payload),
      });
    }
    if (!this.overlay.exists()) {
      this.overlay.create(this.boundsFor(this.placementTarget()));
    }
    this.overlay.setAlwaysOnTop(s.alwaysOnTop);
    this.overlay.setOpacity(s.opacity);
    this.overlay.setClickThrough(s.clickThrough);
    if (before.width !== s.width) this.resize();
    this.overlay.show();
    this.status = { ...this.status, running: true, lastError: null };
    this.subscribeTrackers();
    this.subscribeDisplays();
    this.place(true);
    this.pushSettings();
    this.pushState();
  }

  start() {
    this.load();
    this.settings.enabled = true;
    this.save();
    this.apply();
    return this.get();
  }

  stop() {
    this.unsubscribeTrackers();
    this.unsubscribeDisplays();

    this.overlay?.destroy();
    this.overlay = null;
    this.status = { ...this.status, running: false };
    return this.get();
  }

  restart() {
    const enabled = this.load().enabled;
    this.stop();
    if (enabled) this.apply();
    return this.get();
  }

  resetPosition() {
    this.settings.freeX = null;
    this.settings.freeY = null;
    this.save();
    this.place(true);
    return this.get();
  }

  resize() {
    if (!this.overlay?.exists()) return;
    const width = Math.round(this.settings.width);
    this.overlay.setSize(width, Math.round(width * ASPECT));
  }

  /* ------------------------------------------------------------ placement */

  subscribeTrackers() {
    const needsWindow =
      this.settings.placement === "title-bar" ||
      this.settings.placement === "active-window" ||
      this.settings.hideOnFullscreen;
    const needsMouse = this.settings.placement === "mouse" || this.settings.gaze;

    if (needsWindow && !this.unsubscribeWindow) {
      this.unsubscribeWindow = this.windowTracker.subscribe((info) =>
        this.onForegroundWindow(info),
      );
    } else if (!needsWindow && this.unsubscribeWindow) {
      this.unsubscribeWindow();
      this.unsubscribeWindow = null;
    }

    if (needsMouse && !this.unsubscribeMouse) {
      this.unsubscribeMouse = this.mouseTracker.subscribe((point) => this.onCursor(point));
    } else if (!needsMouse && this.unsubscribeMouse) {
      this.unsubscribeMouse();
      this.unsubscribeMouse = null;
    }
  }

  unsubscribeTrackers() {
    this.unsubscribeWindow?.();
    this.unsubscribeMouse?.();
    this.unsubscribeWindow = null;
    this.unsubscribeMouse = null;
  }

  /**
   * Monitor layout, resolution and DPI can change while the companion is up
   * (docking, unplugging, scaling change). Re-place on the real screen events
   * so the character never ends up on a monitor that no longer exists.
   */
  subscribeDisplays() {
    if (this.displaysBound) return;
    this.displaysBound = true;
    this.onDisplayChange = () => {
      if (!this.settings.enabled) return;
      this.resize();
      this.place(true);
    };
    screen.on("display-metrics-changed", this.onDisplayChange);
    screen.on("display-added", this.onDisplayChange);
    screen.on("display-removed", this.onDisplayChange);
  }

  unsubscribeDisplays() {
    if (!this.displaysBound) return;
    this.displaysBound = false;
    try {
      screen.removeListener("display-metrics-changed", this.onDisplayChange);
      screen.removeListener("display-added", this.onDisplayChange);
      screen.removeListener("display-removed", this.onDisplayChange);
    } catch {
      /* screen listeners already gone */
    }
    this.onDisplayChange = null;
  }

  onForegroundWindow(info) {
    // A real fullscreen app hides the companion, and it comes back after.
    if (this.settings.hideOnFullscreen) {
      if (info.fullscreen && !this.hiddenByFullscreen) {
        this.hiddenByFullscreen = true;
        this.overlay?.hide();
      } else if (!info.fullscreen && this.hiddenByFullscreen) {
        this.hiddenByFullscreen = false;
        if (this.settings.enabled) this.overlay?.show();
      }
    }
    this.place();
    this.overlay?.send("character:context", {
      window: { title: info.title, process: info.process, maximized: info.maximized },
    });
  }

  onCursor(point) {
    if (this.settings.placement === "mouse") this.place();
    if (!this.settings.gaze) return;
    const now = Date.now();
    if (now - this.lastGazeSentAt < 33) return; // 30 Hz is plenty for a gaze
    this.lastGazeSentAt = now;
    const bounds = this.overlay?.currentBounds();
    if (!bounds) return;
    this.overlay?.send("character:gaze", {
      // Normalised offset of the cursor from the character's head.
      dx: (point.x - (bounds.x + bounds.width / 2)) / Math.max(240, bounds.width * 4),
      dy: (point.y - (bounds.y + bounds.height * 0.18)) / Math.max(240, bounds.height * 2),
      near:
        point.x >= bounds.x - 40 &&
        point.x <= bounds.x + bounds.width + 40 &&
        point.y >= bounds.y - 40 &&
        point.y <= bounds.y + bounds.height + 40,
    });
  }

  placementTarget() {
    return this.windowTracker.snapshot();
  }

  /** Coalesce placement work into one update per frame. */
  place(immediate = false) {
    if (!this.overlay?.exists()) return;
    if (immediate) {
      if (this.placeTimer) {
        clearTimeout(this.placeTimer);
        this.placeTimer = null;
      }
      this.applyPlacement();
      return;
    }
    if (this.placeTimer) return;
    this.placeTimer = setTimeout(() => {
      this.placeTimer = null;
      this.applyPlacement();
    }, 16);
  }

  applyPlacement() {
    if (!this.overlay?.exists()) return;
    const bounds = this.boundsFor(this.placementTarget());
    if (bounds) this.overlay.setBounds(this.clampToDisplay(bounds));
  }

  boundsFor(windowInfo) {
    const s = this.settings;
    const width = Math.round(Math.min(560, Math.max(120, Number(s.width) || DEFAULTS.width)));
    const height = Math.round(width * ASPECT);
    const primary = screen.getPrimaryDisplay();
    const area = primary.workArea;

    if (s.placement === "mouse") {
      const point = this.mouseTracker.snapshot() || screen.getCursorScreenPoint();
      return {
        x: Math.round(point.x + 24),
        y: Math.round(point.y - height * 0.35),
        width,
        height,
      };
    }

    if (s.placement === "corner") {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const wa = display.workArea;
      const right = wa.x + wa.width - width - s.offsetX;
      const left = wa.x + s.offsetX;
      const bottom = wa.y + wa.height - height - s.offsetY;
      const top = wa.y + s.offsetY;
      const map = {
        "bottom-right": { x: right, y: bottom },
        "bottom-left": { x: left, y: bottom },
        "top-right": { x: right, y: top },
        "top-left": { x: left, y: top },
      };
      const pos = map[s.corner] || map["bottom-right"];
      return { ...pos, width, height };
    }

    if (
      (s.placement === "title-bar" || s.placement === "active-window") &&
      windowInfo?.bounds?.width
    ) {
      const b = windowInfo.bounds;
      if (s.placement === "title-bar") {
        return {
          x: Math.round(b.x + b.width - width - s.offsetX),
          y: Math.round(b.y + windowInfo.titleBarHeight - height + 8),
          width,
          height,
        };
      }
      return {
        x: Math.round(b.x + b.width - width - s.offsetX),
        y: Math.round(b.y + b.height - height - s.offsetY),
        width,
        height,
      };
    }

    // Free placement: wherever the user last dragged the character.
    if (Number.isFinite(s.freeX) && Number.isFinite(s.freeY)) {
      return { x: Math.round(s.freeX), y: Math.round(s.freeY), width, height };
    }
    return {
      x: Math.round(area.x + area.width - width - 32),
      y: Math.round(area.y + area.height - height - 24),
      width,
      height,
    };
  }

  /** Keep the character fully on a real monitor, whatever the layout is. */
  clampToDisplay(bounds) {
    const display = screen.getDisplayNearestPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    });
    const wa = display.workArea;
    return {
      width: bounds.width,
      height: bounds.height,
      x: Math.min(
        Math.max(bounds.x, wa.x - bounds.width * 0.25),
        wa.x + wa.width - bounds.width * 0.75,
      ),
      y: Math.min(Math.max(bounds.y, wa.y - 8), wa.y + wa.height - bounds.height * 0.35),
    };
  }

  /* -------------------------------------------------------- state relaying */

  pushSettings() {
    this.overlay?.send("character:settings", {
      settings: this.settings,
      model: runtime.modelPayload(),
    });
  }

  pushState(state) {
    if (state) this.lastState = { ...this.lastState, ...state, at: Date.now() };
    this.overlay?.send("character:state", this.lastState);
  }

  /** Called from the renderer of the MAIN window with real FRIDAY state. */
  publish(payload) {
    if (!payload || typeof payload !== "object") return { ok: false };
    this.pushState(payload);
    return { ok: true };
  }

  onOverlayEvent(event, payload) {
    if (event === "recovered") {
      this.status = { ...this.status, recovered: this.status.recovered + 1 };
      this.pushSettings();
      this.pushState();
    }
    if (event === "failed" || event === "load-failed") {
      this.status = {
        ...this.status,
        running: false,
        lastError: payload?.message || payload?.reason || "overlay failed",
      };
    }
  }

  /** Overlay -> main window (chat turns, actions, voice). */
  forwardToMain(channel, payload) {
    try {
      this.sendToMain(channel, payload);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  /** Drag handling: the overlay reports a delta, the controller moves it. */
  drag(delta) {
    if (!this.overlay?.exists()) return { ok: false };
    const bounds = this.overlay.currentBounds();
    if (!bounds) return { ok: false };
    const next = this.clampToDisplay({
      ...bounds,
      x: bounds.x + Math.round(Number(delta?.dx) || 0),
      y: bounds.y + Math.round(Number(delta?.dy) || 0),
    });
    this.overlay.setBounds(next);
    if (delta?.commit) {
      this.settings.placement = "free";
      this.settings.freeX = next.x;
      this.settings.freeY = next.y;
      this.save();
      this.subscribeTrackers();
      this.pushSettings();
    }
    return { ok: true, bounds: next };
  }

  setInteractive(interactive) {
    if (!this.overlay?.exists()) return { ok: false };
    // While the pointer is over the character we accept clicks; otherwise the
    // desktop below keeps every click.
    this.overlay.setClickThrough(!interactive && this.settings.clickThrough);
    return { ok: true };
  }

  dispose() {
    this.unsubscribeTrackers();
    this.unsubscribeDisplays();

    this.windowTracker.stop();
    this.mouseTracker.stop();
    this.overlay?.destroy();
    this.overlay = null;
  }
}

module.exports = { CharacterController, CHARACTER_DEFAULTS: DEFAULTS };
