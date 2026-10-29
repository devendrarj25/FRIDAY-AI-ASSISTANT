/**
 * Packaged boot check. One window, the real renderer, then exit.
 *
 * electron/main.cjs returns into this file before it loads the workspace,
 * kernel, or Python graph. Chromium emits ready only after that entry file
 * returns to the event loop. The marker file is the only signal. This file
 * does not write the stdout pipe and does not take the single-instance lock.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const renderer = require("./renderer.cjs");

const PROBE = `(() => {
  const root = document.querySelector('#root');
  if (!root || !root.childElementCount) return { mounted: false, reason: 'app root is empty' };
  const text = (document.body.innerText || '').trim();
  const painted = root.querySelectorAll('*').length;
  if (painted < 5 || text.length < 3)
    return { mounted: false, reason: 'interface rendered no content' };
  return { mounted: true, painted, chars: text.length };
})()`;

function workspaceRoot() {
  return String(process.env.FRIDAY_WORKSPACE_ROOT || "").replace(/^["']|["']$/g, "");
}

function markerFile() {
  const root = workspaceRoot();
  if (!root) return "";
  try {
    if (!fs.statSync(root).isDirectory()) return "";
  } catch {
    return "";
  }
  return path.join(path.resolve(root), "logs", "boot-selftest.txt");
}

function emit(line) {
  const file = markerFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${String(line || "").replace(/\r?\n/g, " ")}\n`);
  } catch {
    /* smoke reports a missing marker */
  }
}

function note(line) {
  const file = markerFile();
  if (!file) return;
  try {
    fs.appendFileSync(path.join(path.dirname(file), "main.log"), `${String(line || "")}\n`);
  } catch {
    /* the marker is the smoke signal */
  }
}

function start() {
  renderer.registerScheme();
  // Closing the last window would otherwise quit with code 0 and hide a failed
  // probe. finish() writes the marker, then app.exit is the smoke result.
  app.on("window-all-closed", () => {
    /* finish() calls app.exit with the probe result */
  });

  const root = workspaceRoot();
  ipcMain.handle("workspace:get", () => root || null);
  ipcMain.on("state:identity", (event) => {
    event.returnValue = null;
  });

  let finished = false;
  let scheduled = false;

  const finish = (code, line) => {
    if (finished) return;
    finished = true;
    emit(line);
    note(line);
    app.__fridayQuitting = true;
    try {
      for (const open of BrowserWindow.getAllWindows()) {
        if (!open.isDestroyed()) open.destroy();
      }
    } catch {
      /* teardown must never change the self-test result */
    }
    setTimeout(() => app.exit(code), 400);
  };

  setTimeout(() => {
    finish(1, "FRIDAY_BOOT_SELFTEST_FAIL interface did not mount before the deadline");
  }, 70000);

  const schedule = (target) => {
    if (scheduled) return;
    scheduled = true;
    const deadline = Date.now() + 55000;
    const tick = () => {
      if (finished) return;
      if (Date.now() >= deadline) {
        finish(1, "FRIDAY_BOOT_SELFTEST_FAIL interface did not mount before the deadline");
        return;
      }
      const open = target && !target.isDestroyed() ? target : null;
      if (!open || open.webContents.isDestroyed()) {
        setTimeout(tick, 400);
        return;
      }
      let settled = false;
      const slow = setTimeout(() => {
        if (settled || finished) return;
        settled = true;
        setTimeout(tick, 400);
      }, 2500);
      open.webContents
        .executeJavaScript(PROBE)
        .then((result) => {
          if (settled || finished) return;
          settled = true;
          clearTimeout(slow);
          if (result && result.mounted) {
            finish(
              0,
              `FRIDAY_BOOT_SELFTEST_OK interface mounted (${result.painted} nodes, ${result.chars} chars)`,
            );
            return;
          }
          setTimeout(tick, 400);
        })
        .catch((err) => {
          if (settled || finished) return;
          settled = true;
          clearTimeout(slow);
          if (Date.now() >= deadline) {
            finish(
              1,
              `FRIDAY_BOOT_SELFTEST_FAIL ${(err && err.message) || "interface did not mount"}`,
            );
            return;
          }
          setTimeout(tick, 400);
        });
    };
    tick();
  };

  app.whenReady().then(() => {
    note(`FRIDAY boot self-test ready · root=${root || "(none)"}`);
    let win;
    try {
      win = new BrowserWindow({
        width: 1280,
        height: 800,
        show: true,
        backgroundColor: "#141821",
        title: "FRIDAY",
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: false,
          backgroundThrottling: false,
        },
      });
    } catch (error) {
      finish(1, `FRIDAY_BOOT_SELFTEST_FAIL ${error && error.message ? error.message : error}`);
      return;
    }

    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame) return;
      finish(1, `FRIDAY_BOOT_SELFTEST_FAIL renderer failed to load [${code}] ${description}`);
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      finish(1, `FRIDAY_BOOT_SELFTEST_FAIL render process gone: ${details.reason}`);
    });

    renderer.load(win, {
      devUrl: process.env.FRIDAY_DEV_URL,
      log: (message) => note(message),
    });
    schedule(win);
  });
}

module.exports = { start };
