/**
 * Hang guard for the main window.
 *
 * Electron raises "unresponsive" when the page has not answered for a few seconds and "responsive" when it
 * answers again; it already waits a moment and cancels the first when the second follows. Left alone, a hung
 * window just turns white in the title bar and the person cannot tell whether to wait or to kill the app.
 * This asks them, once the hang has lasted `delayMs`: Wait keeps the page as it is (and asks again later if it
 * is still stuck), Reload restarts the interface only. Data on disk is never touched, and a page that comes
 * back on its own closes nothing and asks nothing.
 */

const DEFAULT_DELAY_MS = 8000;
const ASK_AGAIN_MS = 30000;

function watchWindowHang(
  win,
  {
    dialog,
    log = () => {},
    delayMs = DEFAULT_DELAY_MS,
    askAgainMs = ASK_AGAIN_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  },
) {
  let timer = null;
  let asking = false;
  let hung = false;

  const clear = () => {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  };

  const arm = (ms) => {
    clear();
    timer = setTimer(ask, ms);
  };

  async function ask() {
    timer = null;
    if (!hung || asking || win.isDestroyed()) return;
    asking = true;
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
    }
  }

  const onUnresponsive = () => {
    log("main window is not responding");
    hung = true;
    if (!timer && !asking) arm(delayMs);
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

module.exports = { watchWindowHang, DEFAULT_DELAY_MS, ASK_AGAIN_MS };
