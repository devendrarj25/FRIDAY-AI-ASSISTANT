/**
 * Hang guard for the main window.
 *
 * Electron raises "unresponsive" when the page has not answered for a few seconds and "responsive" when it
 * answers again; it already waits a moment and cancels the first when the second follows. Left alone, a hung
 * window just turns white in the title bar and the person cannot tell whether to wait or to kill the app.
 * This asks them, once the hang has lasted `delayMs`: Wait keeps the page as it is (and asks again later if it
 * is still stuck), Reload restarts the interface only. Data on disk is never touched, and a page that comes
 * back on its own closes nothing and asks nothing.
 *
 * Two optional steps (the resource governor wires them): `onPersist` runs once per hang after `persistMs` (a
 * one-line notice that cannot depend on the stuck page, a native one), and `autoReloadMs` reloads the interface
 * once if the page is still stuck after that long, closing a prompt nobody answered. The automatic reload is
 * limited to one per `autoReloadCooldownMs`, so a page that hangs again at once is not reloaded in a loop.
 */

const DEFAULT_DELAY_MS = 8000;
const ASK_AGAIN_MS = 30000;
const DEFAULT_PERSIST_MS = 4000;
const DEFAULT_AUTO_RELOAD_COOLDOWN_MS = 10 * 60 * 1000;

function watchWindowHang(
  win,
  {
    dialog,
    log = () => {},
    delayMs = DEFAULT_DELAY_MS,
    askAgainMs = ASK_AGAIN_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onPersist = null,
    persistMs = DEFAULT_PERSIST_MS,
    autoReloadMs = 0,
    autoReloadCooldownMs = DEFAULT_AUTO_RELOAD_COOLDOWN_MS,
    now = () => Date.now(),
  },
) {
  let timer = null;
  let persistTimer = null;
  let autoTimer = null;
  let asking = false;
  let hung = false;
  let promptAbort = null;
  let lastAutoReloadAt = -Infinity;

  const clearAsk = () => {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  };

  const clear = () => {
    clearAsk();
    if (persistTimer) {
      clearTimer(persistTimer);
      persistTimer = null;
    }
    if (autoTimer) {
      clearTimer(autoTimer);
      autoTimer = null;
    }
  };

  const persisted = () => {
    persistTimer = null;
    if (!hung || win.isDestroyed()) return;
    try {
      onPersist(autoReloadMs > 0 ? autoReloadMs : null);
    } catch (error) {
      log(`hang notice failed: ${error && error.message ? error.message : error}`);
    }
  };

  const autoReload = () => {
    autoTimer = null;
    if (!hung || win.isDestroyed()) return;
    if (now() - lastAutoReloadAt < autoReloadCooldownMs) {
      log(
        "main window still not responding; it was reloaded a moment ago, leaving it to the owner",
      );
      return;
    }
    lastAutoReloadAt = now();
    log("main window did not recover: reloading the interface once on its own");
    hung = false;
    if (promptAbort) promptAbort.abort();
    win.webContents.reloadIgnoringCache();
  };

  const arm = (ms) => {
    clearAsk();
    timer = setTimer(ask, ms);
  };

  async function ask() {
    timer = null;
    if (!hung || asking || win.isDestroyed()) return;
    asking = true;
    promptAbort =
      autoReloadMs > 0 && typeof AbortController === "function" ? new AbortController() : null;
    try {
      const { response } = await dialog.showMessageBox(win, {
        type: "warning",
        title: "FRIDAY is not responding",
        message: "FRIDAY is busy and has not answered for a few seconds.",
        detail:
          "Wait keeps everything as it is. Reload restarts the interface only: your files, memory and settings on disk are not touched, but anything on screen that was not saved yet is lost.",
        buttons: ["Wait", "Reload"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        ...(promptAbort ? { signal: promptAbort.signal } : {}),
      });
      if (response === 1 && !win.isDestroyed()) {
        log("main window hung: reloading the interface at the owner's request");
        hung = false;
        win.webContents.reloadIgnoringCache();
      } else if (hung && !win.isDestroyed()) {
        arm(askAgainMs);
      }
    } catch (error) {
      log(`hang prompt failed: ${error && error.message ? error.message : error}`);
    } finally {
      asking = false;
      promptAbort = null;
    }
  }

  const onUnresponsive = () => {
    log("main window is not responding");
    hung = true;
    if (!timer && !asking) arm(delayMs);
    if (typeof onPersist === "function" && !persistTimer)
      persistTimer = setTimer(persisted, persistMs);
    if (autoReloadMs > 0 && !autoTimer) autoTimer = setTimer(autoReload, autoReloadMs);
  };
  const onResponsive = () => {
    if (hung) log("main window responded again");
    hung = false;
    clear();
  };
  const onClosed = () => {
    hung = false;
    clear();
  };

  win.on("unresponsive", onUnresponsive);
  win.on("responsive", onResponsive);
  win.once("closed", onClosed);

  return function stop() {
    win.removeListener("unresponsive", onUnresponsive);
    win.removeListener("responsive", onResponsive);
    win.removeListener("closed", onClosed);
    onClosed();
  };
}

module.exports = {
  watchWindowHang,
  DEFAULT_DELAY_MS,
  ASK_AGAIN_MS,
  DEFAULT_PERSIST_MS,
  DEFAULT_AUTO_RELOAD_COOLDOWN_MS,
};
