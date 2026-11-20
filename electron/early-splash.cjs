/**
 * The first thing on screen when FRIDAY is opened.
 *
 * Double-clicking the EXE used to show nothing until the main process had found the FRIDAY folder, repaired its layout,
 * read the settings and built the real window, and then the interface bundle had to load: on a PC with a virus scanner
 * and a big model folder that is long enough to look like a click that did nothing. This is a small frameless window
 * with the FRIDAY mark and a line that says what is happening, created the moment Electron is ready, before any of
 * that work. It has no script of its own, no preload and no network: one inline page. The real window replaces it when
 * it is shown (electron/main.cjs `reveal`), and it never outlives a fail-safe timer.
 *
 * It is not shown for a start at Windows sign-in (FRIDAY waits in the tray then), for the boot self-test and the
 * readiness check (CI has no desktop to show it on), or when FRIDAY_NO_SPLASH=1.
 */
"use strict";

const assets = require("./splash-assets.cjs");

const WIDTH = 480;
const HEIGHT = 380;
/** The splash never stays longer than this, whatever happens to the main window. */
const MAX_LIFE_MS = 90_000;

/** Pure: whether this start shows the splash. */
function shouldShow({ env = process.env, argv = process.argv, loginArg = "--friday-login" } = {}) {
  if (env.FRIDAY_BOOT_SELFTEST || env.FRIDAY_READINESS === "1") return false;
  if (String(env.FRIDAY_NO_SPLASH || "") === "1") return false;
  if (Array.isArray(argv) && argv.includes(loginArg)) return false;
  if (Array.isArray(argv) && argv.some((arg) => /friday-(boot-selftest|readiness)/.test(arg))) {
    return false;
  }
  return true;
}

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c,
  );

/** Pure: the page. Everything is inline (CSP allows only inline style and data: images and fonts). */
function splashHtml(status = "Starting FRIDAY") {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'">
<title>FRIDAY</title>
<style>
@font-face{font-family:"FridaySplashDisplay";font-weight:700;src:url(data:font/woff2;base64,${assets.ORBITRON_700_LATIN_FRIDAY}) format("woff2")}
@font-face{font-family:"FridaySplashBody";font-weight:500;src:url(data:font/woff2;base64,${assets.RAJDHANI_500_ASCII}) format("woff2")}
html,body{margin:0;height:100%;background:${assets.SPLASH_BACKGROUND};color:#e8edf5;overflow:hidden;user-select:none;-webkit-app-region:drag}
body{display:grid;place-items:center;text-align:center;font-family:"FridaySplashBody","Segoe UI",system-ui,sans-serif;border:1px solid rgba(90,209,255,.18);box-sizing:border-box}
.logo{display:block;margin:0 auto;width:120px;height:120px;object-fit:contain;animation:b 3.2s ease-in-out infinite}
.word{margin:18px 0 0;font:700 34px "FridaySplashDisplay","Segoe UI",sans-serif;letter-spacing:.3em;padding-left:.3em;color:#00d4ff;text-shadow:0 0 18px rgba(0,212,255,.45)}
.line{margin:10px 0 0;font-size:15px;font-weight:500;color:#e8edf5}
.bar{margin:20px auto 0;width:300px;height:5px;border-radius:999px;overflow:hidden;background:rgba(255,255,255,.1)}
.bar i{display:block;width:34%;height:100%;border-radius:999px;background:#00d4ff;animation:s 1.4s ease-in-out infinite}
@keyframes s{from{transform:translateX(-110%)}to{transform:translateX(320%)}}
@keyframes b{0%,100%{transform:scale(1);opacity:.92}50%{transform:scale(1.04);opacity:1}}
@media (prefers-reduced-motion:reduce){.logo,.bar i{animation:none}.bar i{width:100%;opacity:.6}}
</style></head>
<body><main>
<img class="logo" alt="" src="data:image/png;base64,${assets.SPLASH_LOGO_PNG}">
<p class="word">FRIDAY</p>
<p class="line" id="s" role="status" aria-live="polite">${escapeHtml(status)}</p>
<div class="bar" aria-hidden="true"><i></i></div>
</main></body></html>`;
}

const nothing = {
  shown: false,
  status() {},
  close() {},
  whenPainted: () => Promise.resolve(),
};

/**
 * Registers the splash on `app.whenReady()` (the first callback of the main process, so it runs before the slow work)
 * and returns { status(text), close(), whenPainted(ms), shown }. Never throws: a splash that cannot be drawn is just
 * not drawn.
 */
function create({
  app,
  BrowserWindow,
  env = process.env,
  argv = process.argv,
  loginArg = "--friday-login",
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!app || typeof app.whenReady !== "function" || !BrowserWindow) return nothing;
  if (!shouldShow({ env, argv, loginArg })) return nothing;

  let win = null;
  let closed = false;
  let loaded = Promise.resolve();
  let lifeTimer = null;
  const handle = {
    shown: false,
    status(text) {
      if (!win || win.isDestroyed()) return;
      try {
        win.webContents
          .executeJavaScript(
            `(function(){var e=document.getElementById("s");if(e)e.textContent=${JSON.stringify(String(text).slice(0, 80))}})()`,
          )
          .catch(() => undefined);
      } catch {
        /* the page may be gone or not loaded yet: the next status line will do */
      }
    },
    close() {
      closed = true;
      if (lifeTimer) clearTimer(lifeTimer);
      lifeTimer = null;
      const target = win;
      win = null;
      handle.shown = false;
      try {
        if (target && !target.isDestroyed()) target.destroy();
      } catch {
        /* already gone */
      }
    },
    /** Resolves when the page has loaded, or after `ms` at the latest: the main work then starts. */
    whenPainted(ms = 300) {
      return Promise.race([loaded, new Promise((resolve) => setTimer(resolve, ms))]);
    },
  };

  app.whenReady().then(() => {
    if (closed) return;
    try {
      win = new BrowserWindow({
        width: WIDTH,
        height: HEIGHT,
        show: true,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        center: true,
        title: "FRIDAY",
        backgroundColor: assets.SPLASH_BACKGROUND,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          devTools: false,
          spellcheck: false,
          backgroundThrottling: false,
        },
      });
      handle.shown = true;
      win.setMenuBarVisibility?.(false);
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      loaded = new Promise((resolve) => {
        win.webContents.once("did-finish-load", resolve);
        win.webContents.once("did-fail-load", resolve);
      });
      void win.loadURL(
        `data:text/html;charset=utf-8;base64,${Buffer.from(splashHtml()).toString("base64")}`,
      );
      lifeTimer = setTimer(() => handle.close(), MAX_LIFE_MS);
      lifeTimer?.unref?.();
    } catch (error) {
      log(`early splash not drawn: ${String((error && error.message) || error)}`);
      handle.close();
    }
  });
  return handle;
}

module.exports = { create, shouldShow, splashHtml, WIDTH, HEIGHT, MAX_LIFE_MS };
