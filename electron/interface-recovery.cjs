/**
 * FRIDAY · getting the interface back when its page does not load.
 *
 * Chromium reports ERR_ABORTED (-3) whenever a navigation is replaced or stopped by another one: a second reload from
 * a watchdog, the owner opening the window while it loads, a reload after sleep. That is not a failure, the newer
 * load carries on. Before this module the window treated -3 like any other error, put up the "could not start the
 * interface" page and never loaded the real interface again, so a healthy FRIDAY stayed on an error page for good.
 *
 * This keeps one decision in one place:
 *  - an aborted load (-3) is logged and ignored; a stall timer still notices when nothing came after it;
 *  - a real load error, a renderer that exited, or a load that never finished is retried a few times with a short
 *    wait, because the cause is often a one-off (a busy disk at sign-in, a virus scan, a graphics driver reset);
 *  - only when every retry failed is the owner told, through `onGiveUp`, which is the one place that decides what
 *    the owner sees (electron/main.cjs `failInterface`).
 *
 * It starts and kills nothing and holds no Electron object: the window, the timers and the load call are injected,
 * so the decisions are tested without a window (core/__tests__/interface-recovery.test.ts).
 */
"use strict";

/** Chromium net error for a navigation that another navigation replaced or that was stopped. */
const ERR_ABORTED = -3;
/** Waits before each automatic retry. Two retries, so three loads in all, then the owner is told. */
const RETRY_DELAYS_MS = [1500, 4000];
/** A load that has produced nothing for this long is looked at again. */
const STALL_MS = 25_000;
/** A page that is still loading after this many stall checks is replaced by a fresh load. */
const MAX_STALL_EXTENSIONS = 4;

/** True for the error a rejected `loadURL` or a `did-fail-load` event carries when the load was replaced. */
function isAborted(errorOrCode) {
  if (typeof errorOrCode === "number") return errorOrCode === ERR_ABORTED;
  if (!errorOrCode || typeof errorOrCode !== "object") return false;
  if (errorOrCode.errno === ERR_ABORTED || errorOrCode.errorCode === ERR_ABORTED) return true;
  if (errorOrCode.code === "ERR_ABORTED") return true;
  return /\bERR_ABORTED\b/.test(String(errorOrCode.message || ""));
}

/** A line the owner can read: the first line only, so a stack trace never fills the failure page. */
function firstLine(text) {
  return String(text == null ? "" : text)
    .split(/\r?\n/)[0]
    .trim();
}

/**
 * @param {object} options
 * @param {() => void} options.loadInterface starts a fresh load of the interface in the window
 * @param {(detail: string, info: {kind: string}) => void} options.onGiveUp every retry failed: tell the owner
 * @param {() => boolean} [options.isLoading] true while the page is still loading
 * @param {(message: string) => void} [options.log]
 */
function createInterfaceRecovery({
  loadInterface,
  onGiveUp,
  isLoading = () => false,
  log = () => {},
  delaysMs = RETRY_DELAYS_MS,
  stallMs = STALL_MS,
  maxStallExtensions = MAX_STALL_EXTENSIONS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let retriesUsed = 0;
  let loaded = false;
  let gaveUp = false;
  let disposed = false;
  let stallExtensions = 0;
  let retryTimer = null;
  let stallTimer = null;

  function clearRetry() {
    if (retryTimer) clearTimer(retryTimer);
    retryTimer = null;
  }
  function clearStall() {
    if (stallTimer) clearTimer(stallTimer);
    stallTimer = null;
  }
  function clearAll() {
    clearRetry();
    clearStall();
  }

  function armStall() {
    clearStall();
    if (disposed) return;
    stallTimer = setTimer(onStall, stallMs);
    if (stallTimer && typeof stallTimer.unref === "function") stallTimer.unref();
  }

  function onStall() {
    stallTimer = null;
    if (loaded || gaveUp || disposed) return;
    let loading = false;
    try {
      loading = Boolean(isLoading());
    } catch {
      loading = false;
    }
    if (loading && stallExtensions < maxStallExtensions) {
      stallExtensions += 1;
      armStall();
      return;
    }
    retry(
      loading
        ? "the page was still loading after a long wait"
        : "no page arrived and no load was running",
      "stalled",
    );
  }

  /** A load began (a first load, a reload, a navigation). Watches that it finishes. */
  function started() {
    if (gaveUp || disposed) return;
    loaded = false;
    stallExtensions = 0;
    armStall();
  }

  /** The real interface finished loading: the count of retries starts again for the next trouble. */
  function finished() {
    loaded = true;
    gaveUp = false;
    retriesUsed = 0;
    stallExtensions = 0;
    clearAll();
  }

  function retry(reason, kind) {
    if (disposed) return "disposed";
    if (gaveUp) return "gave-up";
    if (retryTimer) return "retrying";
    if (retriesUsed >= delaysMs.length) {
      gaveUp = true;
      clearAll();
      log(`interface did not load after ${retriesUsed + 1} tries: ${reason}`);
      onGiveUp(reason, { kind });
      return "gave-up";
    }
    const wait = delaysMs[retriesUsed];
    retriesUsed += 1;
    log(`interface load retry ${retriesUsed}/${delaysMs.length} in ${wait} ms: ${reason}`);
    clearStall();
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (loaded || gaveUp || disposed) return;
      loadInterface();
      started();
    }, wait);
    return "retrying";
  }

  /**
   * A `did-fail-load` event for the main frame, or a rejected `loadURL`.
   * Returns "ignored" (aborted or not the main frame), "retrying" or "gave-up".
   */
  function failed({ code, description = "", url = "", isMainFrame = true } = {}) {
    if (!isMainFrame) return "ignored";
    if (isAborted(code)) {
      log(`interface load ${url || ""} was replaced by a newer load (ERR_ABORTED); not an error`);
      return "ignored";
    }
    const text = `${firstLine(description) || "load error"} (${code})${url ? ` ${url}` : ""}`;
    return retry(text, "load-error");
  }

  /** The renderer process exited. Loaded or not, the interface is gone and gets the same retries. */
  function rendererGone(reason) {
    loaded = false;
    return retry(`the interface process stopped (${reason || "unknown"})`, "renderer-gone");
  }

  /** The bundle itself is missing: retrying cannot help, so the owner is told at once. */
  function missing(detail) {
    if (gaveUp || disposed) return "gave-up";
    gaveUp = true;
    clearAll();
    onGiveUp(String(detail), { kind: "missing" });
    return "gave-up";
  }

  /** The owner (or a second start of FRIDAY) asked for another go: the counts start from zero. */
  function manualRetry(reason) {
    if (disposed) return;
    log(`interface load tried again${reason ? `: ${reason}` : ""}`);
    clearAll();
    retriesUsed = 0;
    gaveUp = false;
    loaded = false;
    loadInterface();
    started();
  }

  function dispose() {
    disposed = true;
    clearAll();
  }

  return {
    started,
    finished,
    failed,
    rendererGone,
    missing,
    manualRetry,
    dispose,
    state: () => ({ retriesUsed, loaded, gaveUp }),
  };
}

module.exports = {
  ERR_ABORTED,
  RETRY_DELAYS_MS,
  STALL_MS,
  MAX_STALL_EXTENSIONS,
  isAborted,
  firstLine,
  createInterfaceRecovery,
};
