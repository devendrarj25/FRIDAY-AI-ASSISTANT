/**
 * FRIDAY · system tray
 *
 * FRIDAY keeps running after the window is closed, so there must be one honest,
 * always-visible sign that she is still alive — and one obvious way to fully
 * quit. This module owns that surface and nothing else:
 *
 *   Open FRIDAY    → show + focus the existing window (never a second one)
 *   Pause listening→ really stops the microphone (renderer side), not a badge
 *   Quit FRIDAY    → the only in-app way (besides Settings) to end the process
 *
 * The tooltip always reports the REAL state it was given (listening / paused /
 * manual mode); it is never optimistic.
 */
const { Tray, Menu, nativeImage } = require("electron");
const fridayVersion = require("./friday-version.cjs");

let tray = null;
let hooks = {};
let state = { mode: "manual", listening: false, paused: false };
let toldUserAboutBackground = false;

function tooltip() {
  if (state.paused) return "FRIDAY — running in background · microphone paused";
  if (state.listening) return "FRIDAY — listening for the wake word";
  if (state.mode === "auto") return "FRIDAY — auto mode · microphone starting";
  return "FRIDAY — running in background · manual mode";
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: "Open FRIDAY", click: () => hooks.onOpen?.() },
    { type: "separator" },
    {
      label: "Pause listening",
      type: "checkbox",
      checked: state.paused,
      click: (item) => hooks.onPauseToggle?.(item.checked),
    },
    { type: "separator" },
    { label: `Version ${fridayVersion.displayVersion()}`, enabled: false },
    { label: "Quit FRIDAY", click: () => hooks.onQuit?.() },
  ]);
}

function refresh() {
  if (!tray || tray.isDestroyed?.()) return;
  tray.setToolTip(tooltip());
  tray.setContextMenu(buildMenu());
}

/** Create the tray once. Returns null when the platform has no tray. */
function init({ iconPath, onOpen, onQuit, onPauseToggle, log } = {}) {
  hooks = { onOpen, onQuit, onPauseToggle, log };
  if (tray && !tray.isDestroyed?.()) return tray;
  try {
    const image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    tray.on("click", () => hooks.onOpen?.());
    tray.on("double-click", () => hooks.onOpen?.());
    refresh();
  } catch (error) {
    tray = null;
    log?.(`tray unavailable: ${error?.message || error}`);
  }
  return tray;
}

/** Push the real microphone/mode state the renderer reported. */
function setState(next) {
  state = { ...state, ...next };
  refresh();
  return state;
}

const getState = () => ({ ...state });

/**
 * One honest notice, the first time the window is closed to the tray, so no
 * one is left wondering where FRIDAY went.
 */
function noticeBackground() {
  if (toldUserAboutBackground || !tray || tray.isDestroyed?.()) return false;
  toldUserAboutBackground = true;
  try {
    tray.displayBalloon?.({
      title: "FRIDAY is still running",
      content:
        "FRIDAY stays in the system tray so the wake word keeps working. Right-click the tray icon → Quit FRIDAY to close her completely.",
    });
  } catch {
    /* balloons are Windows-only — the tooltip still explains the state */
  }
  return true;
}

function destroy() {
  try {
    tray?.destroy();
  } catch {
    /* already gone */
  }
  tray = null;
}

module.exports = { init, setState, getState, noticeBackground, destroy, refresh };
