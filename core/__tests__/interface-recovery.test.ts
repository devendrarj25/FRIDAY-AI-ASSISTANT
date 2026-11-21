import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8").replace(/\r\n/g, "\n");

type Info = { kind: string };
type Recovery = {
  started: () => void;
  finished: () => void;
  failed: (e: Record<string, unknown>) => string;
  rendererGone: (reason: string) => string;
  missing: (detail: string) => string;
  manualRetry: (reason?: string) => void;
  dispose: () => void;
  state: () => { retriesUsed: number; loaded: boolean; gaveUp: boolean };
};
const mod = require_("../../electron/interface-recovery.cjs") as {
  ERR_ABORTED: number;
  RETRY_DELAYS_MS: number[];
  isAborted: (v: unknown) => boolean;
  firstLine: (v: unknown) => string;
  createInterfaceRecovery: (o: Record<string, unknown>) => Recovery;
};

/** A manual clock: timers run only when the test says so. */
function harness(options: { loading?: () => boolean } = {}) {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const loadInterface = vi.fn();
  const onGiveUp = vi.fn<(detail: string, info: Info) => void>();
  const log = vi.fn();
  const recovery = mod.createInterfaceRecovery({
    loadInterface,
    onGiveUp,
    log,
    isLoading: options.loading ?? (() => false),
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id: number) => void timers.delete(id),
  });
  /** Runs the oldest pending timer and returns its wait. */
  const fire = () => {
    const first = [...timers.entries()][0];
    if (!first) throw new Error("no timer is waiting");
    timers.delete(first[0]);
    first[1].fn();
    return first[1].ms;
  };
  return { recovery, timers, loadInterface, onGiveUp, log, fire };
}

const realError = { code: -6, description: "ERR_FILE_NOT_FOUND", url: "friday://app/index.html" };

describe("ERR_ABORTED is not a failure", () => {
  it("knows the aborted error in every shape Electron gives it", () => {
    expect(mod.ERR_ABORTED).toBe(-3);
    expect(mod.isAborted(-3)).toBe(true);
    expect(mod.isAborted(-2)).toBe(false);
    expect(mod.isAborted({ errno: -3, code: "ERR_ABORTED" })).toBe(true);
    expect(mod.isAborted({ code: "ERR_ABORTED" })).toBe(true);
    expect(mod.isAborted(new Error("ERR_ABORTED (-3) loading 'friday://app/index.html'"))).toBe(
      true,
    );
    expect(mod.isAborted(new Error("ERR_FAILED (-2) loading 'friday://app/index.html'"))).toBe(
      false,
    );
    expect(mod.isAborted(null)).toBe(false);
    expect(mod.isAborted(undefined)).toBe(false);
  });

  it("ignores a replaced load: no retry, no error page", () => {
    const h = harness();
    h.recovery.started();
    const verdict = h.recovery.failed({
      code: -3,
      description: "",
      url: "friday://app/index.html",
      isMainFrame: true,
    });
    expect(verdict).toBe("ignored");
    expect(h.onGiveUp).not.toHaveBeenCalled();
    expect(h.loadInterface).not.toHaveBeenCalled();
    expect(h.recovery.state().retriesUsed).toBe(0);
  });

  it("ignores a failed load of a sub frame", () => {
    const h = harness();
    expect(h.recovery.failed({ ...realError, isMainFrame: false })).toBe("ignored");
    expect(h.onGiveUp).not.toHaveBeenCalled();
  });
});

describe("a real load error is retried before the owner is told", () => {
  it("retries twice with a growing wait, then gives up once", () => {
    const h = harness();
    h.recovery.started();
    expect(h.recovery.failed({ ...realError, isMainFrame: true })).toBe("retrying");
    expect(h.fire()).toBe(mod.RETRY_DELAYS_MS[0]);
    expect(h.loadInterface).toHaveBeenCalledTimes(1);

    expect(h.recovery.failed({ ...realError, isMainFrame: true })).toBe("retrying");
    expect(h.fire()).toBe(mod.RETRY_DELAYS_MS[1]);
    expect(h.loadInterface).toHaveBeenCalledTimes(2);
    expect(h.onGiveUp).not.toHaveBeenCalled();

    expect(h.recovery.failed({ ...realError, isMainFrame: true })).toBe("gave-up");
    expect(h.onGiveUp).toHaveBeenCalledTimes(1);
    const [detail, info] = h.onGiveUp.mock.calls[0] as [string, Info];
    expect(detail).toContain("ERR_FILE_NOT_FOUND");
    expect(detail).toContain("(-6)");
    expect(info.kind).toBe("load-error");
    // After giving up it stays quiet: no second message, no more loads.
    expect(h.recovery.failed({ ...realError, isMainFrame: true })).toBe("gave-up");
    expect(h.onGiveUp).toHaveBeenCalledTimes(1);
    expect(h.loadInterface).toHaveBeenCalledTimes(2);
  });

  it("counts the event and the rejected load of one failure as one retry", () => {
    const h = harness();
    h.recovery.started();
    h.recovery.failed({ ...realError, isMainFrame: true });
    h.recovery.failed({ code: -2, description: "rejected", isMainFrame: true });
    expect(h.timers.size).toBe(1);
    h.fire();
    expect(h.loadInterface).toHaveBeenCalledTimes(1);
    expect(h.recovery.state().retriesUsed).toBe(1);
  });

  it("starts the count again once the interface has loaded", () => {
    const h = harness();
    h.recovery.started();
    h.recovery.failed({ ...realError, isMainFrame: true });
    h.fire();
    h.recovery.finished();
    expect(h.recovery.state()).toEqual({ retriesUsed: 0, loaded: true, gaveUp: false });
    // A later trouble has its own two retries again.
    h.recovery.rendererGone("crashed");
    h.fire();
    h.recovery.rendererGone("crashed");
    h.fire();
    expect(h.onGiveUp).not.toHaveBeenCalled();
    expect(h.loadInterface).toHaveBeenCalledTimes(3);
  });

  it("does not load again when the page arrived while a retry was waiting", () => {
    const h = harness();
    h.recovery.started();
    h.recovery.failed({ ...realError, isMainFrame: true });
    h.recovery.finished();
    expect(h.timers.size).toBe(0);
    expect(h.loadInterface).not.toHaveBeenCalled();
  });
});

describe("a load that never finishes", () => {
  it("is retried when nothing is loading and nothing has arrived", () => {
    const h = harness({ loading: () => false });
    h.recovery.started();
    h.fire(); // the stall timer
    expect(h.log.mock.calls.flat().join("\n")).toMatch(/no page arrived/);
    h.fire(); // the retry wait
    expect(h.loadInterface).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting while the page is still loading, then loads it afresh", () => {
    const h = harness({ loading: () => true });
    h.recovery.started();
    for (let i = 0; i < 4; i += 1) h.fire(); // four stall checks, each finds it still loading
    expect(h.loadInterface).not.toHaveBeenCalled();
    h.fire(); // the fifth stall check retries
    h.fire(); // the retry wait
    expect(h.loadInterface).toHaveBeenCalledTimes(1);
  });

  it("stops watching once the interface loaded", () => {
    const h = harness();
    h.recovery.started();
    h.recovery.finished();
    expect(h.timers.size).toBe(0);
  });
});

describe("the renderer process exited", () => {
  it("is retried like a failed load, even after the interface had loaded", () => {
    const h = harness();
    h.recovery.started();
    h.recovery.finished();
    expect(h.recovery.rendererGone("crashed")).toBe("retrying");
    h.fire();
    expect(h.loadInterface).toHaveBeenCalledTimes(1);
    expect(h.recovery.rendererGone("crashed")).toBe("retrying");
    h.fire();
    expect(h.recovery.rendererGone("crashed")).toBe("gave-up");
    const [detail, info] = h.onGiveUp.mock.calls[0] as [string, Info];
    expect(detail).toContain("crashed");
    expect(info.kind).toBe("renderer-gone");
  });
});

describe("a missing bundle and the owner's own retry", () => {
  it("tells the owner at once when the bundle is missing, with no retry", () => {
    const h = harness();
    expect(h.recovery.missing("The FRIDAY interface bundle is missing.")).toBe("gave-up");
    expect(h.onGiveUp).toHaveBeenCalledWith("The FRIDAY interface bundle is missing.", {
      kind: "missing",
    });
    expect(h.timers.size).toBe(0);
  });

  it("starts from zero when the owner asks again after giving up", () => {
    const h = harness();
    h.recovery.started();
    h.recovery.failed({ ...realError, isMainFrame: true });
    h.fire();
    h.recovery.failed({ ...realError, isMainFrame: true });
    h.fire();
    h.recovery.failed({ ...realError, isMainFrame: true });
    expect(h.recovery.state().gaveUp).toBe(true);
    h.recovery.manualRetry("owner asked");
    expect(h.recovery.state()).toEqual({ retriesUsed: 0, loaded: false, gaveUp: false });
    expect(h.loadInterface).toHaveBeenCalledTimes(3);
    // It is watched again, and a new failure retries instead of staying silent.
    expect(h.recovery.failed({ ...realError, isMainFrame: true })).toBe("retrying");
  });

  it("does nothing after dispose", () => {
    const h = harness();
    h.recovery.started();
    h.recovery.dispose();
    expect(h.timers.size).toBe(0);
    h.recovery.manualRetry();
    expect(h.loadInterface).not.toHaveBeenCalled();
  });

  it("shows only the first line of an error", () => {
    expect(mod.firstLine("Error: boom\n    at x (y.js:1)")).toBe("Error: boom");
    expect(mod.firstLine(undefined)).toBe("");
  });
});

describe("how the main process uses it", () => {
  const main = read("electron/main.cjs");
  const loader = read("electron/renderer.cjs");

  it("sends a failed load through the recovery, not straight to the error page", () => {
    expect(main).toMatch(/recovery\.failed\(\{ code, description, url, isMainFrame \}\)/);
    expect(main).toMatch(/recovery\.rendererGone\(details\.reason\)/);
    expect(main).toMatch(/onGiveUp: \(detail, info\) => failInterface\(detail, info\)/);
    // The only direct showLoadFailure calls in the load handlers are the harness paths, which never retry.
    const handler = main.slice(
      main.indexOf('win.webContents.on("did-fail-load"'),
      main.indexOf('win.webContents.on("render-process-gone"'),
    );
    expect(handler.match(/showLoadFailure\(/g)?.length).toBe(1);
    expect(handler).toMatch(/if \(harness\) \{\s*showLoadFailure/);
  });

  it("treats a rejected loadURL that was replaced (ERR_ABORTED) as not an error", () => {
    expect(loader).toMatch(/aborted: isAborted\(err\)/);
    expect(loader).toMatch(/missing: true/);
    expect(main).toMatch(/else if \(info\.aborted\)/);
  });

  it("watches every load and resets when the real interface finishes", () => {
    expect(main).toMatch(/win\.webContents\.on\("did-start-navigation", \(details\) => \{/);
    expect(main).toMatch(/!details\.isMainFrame \|\| details\.isSameDocument/);
    expect(main).toMatch(/win\.webContents\.on\("did-navigate"/);
    expect(main).toMatch(/interfaceFailed = false;\s*recovery\.finished\(\);/);
    expect(main).toMatch(/function isFailurePage\(url\)/);
  });

  it("never reloads a page that is already loading, and loads afresh instead of reloading the failure page", () => {
    const step = main.slice(
      main.indexOf("lifeSteps.reload = () => {"),
      main.indexOf("lifeSteps.lock = () => {"),
    );
    expect(step).toMatch(/win\.webContents\.isLoading\(\)/);
    expect(step).toMatch(/reload skipped: the interface is still loading/);
    expect(step).toMatch(/interfaceFailed \|\| !interfaceLoaded/);
    expect(step).toMatch(/interfaceRecovery\.manualRetry\("window recovery"\)/);
  });

  it("closes for good from the failure page instead of hiding to the tray", () => {
    const close = main.slice(
      main.indexOf('win.on("close", (event) => {'),
      main.indexOf("// The window is never allowed to stay invisible"),
    );
    expect(close).toMatch(/!interfaceFailed && ownerPrefToggle\("tray", true\)/);
    expect(close).toMatch(/!interfaceFailed &&\s*ownerPrefToggle\("confirmExit", true\)/);
    expect(close).toMatch(/requestShutdown\("window-close"\)/);
  });

  it("tries the interface again when FRIDAY is opened again on the failure page", () => {
    const show = main.slice(
      main.indexOf("function showFridayWindow() {"),
      main.indexOf("/** Close-to-tray"),
    );
    expect(show).toMatch(/interfaceFailed && interfaceRecovery/);
    expect(show).toMatch(/manualRetry\("FRIDAY was opened again"\)/);
  });

  it("offers Try again, Restart, Quit and the log from the failure page", () => {
    const offer = main.slice(main.indexOf("async function offerRecovery("));
    for (const label of ["Try again", "Restart FRIDAY", "Quit FRIDAY", "Open log folder"]) {
      expect(offer).toContain(`"${label}"`);
    }
    expect(offer).toMatch(/interfaceRecovery\?\.manualRetry\("owner asked"\)/);
    expect(offer).toMatch(/life\.requestRestart\("interface-failed"\)/);
    expect(offer).toMatch(/life\.requestShutdown\("interface-failed"\)/);
    expect(offer).toMatch(/signal: failureDialogAbort\.signal/);
    // The harnesses have no one to answer.
    expect(offer).toMatch(/FRIDAY_BOOT_SELFTEST \|\| process\.env\.FRIDAY_READINESS === "1"/);
  });

  it("restarts once in software drawing before it shows the failure page, but never for a missing bundle", () => {
    const fail = main.slice(
      main.indexOf("function failInterface("),
      main.indexOf("/** Renders a plain, readable failure screen"),
    );
    expect(fail).toMatch(/info\.kind !== "missing"/);
    expect(fail).toMatch(/gpuGuard\.requestSoftware\(/);
    expect(fail).toMatch(/life\.requestRestart\("interface-load-failed"\)/);
    expect(fail).toMatch(/showLoadFailure\(detail\)/);
  });
});
