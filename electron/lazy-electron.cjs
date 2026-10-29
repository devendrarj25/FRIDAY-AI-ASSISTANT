/**
 * Electron exports that are not ready on the first turn of the main file.
 *
 * safeStorage, desktopCapturer, Tray, and nativeImage initialise when the
 * export is first read. On a headless Windows runner that init waits for the
 * ready event, and ready cannot fire until this process returns to the event
 * loop. The packaged boot check never reads them and reaches ready. Readiness
 * used to read them while main.cjs was still loading (release 38892746988
 * stopped at before-subsystems). Read them only after app.isReady().
 *
 * `app` itself is already used before ready (the boot check depends on it)
 * and is safe to read here.
 */
function electron() {
  try {
    return require("electron");
  } catch {
    return null;
  }
}

function appReady() {
  try {
    const app = electron()?.app;
    return Boolean(app && typeof app.isReady === "function" && app.isReady());
  } catch {
    return false;
  }
}

/** The named export, or null while the app is still starting. */
function afterReady(name) {
  if (!appReady()) return null;
  try {
    const value = electron()?.[name];
    return value == null ? null : value;
  } catch {
    return null;
  }
}

module.exports = { electron, appReady, afterReady };
