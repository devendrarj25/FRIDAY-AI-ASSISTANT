import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
const { watchWindowHang } = require_("../../electron/window-hang.cjs") as {
  watchWindowHang: (win: unknown, options: Record<string, unknown>) => () => void;
};

function setup(response = 0) {
  const win = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    webContents: { reloadIgnoringCache: vi.fn() },
  });
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const dialog = { showMessageBox: vi.fn(async () => ({ response })) };
  const log = vi.fn();
  const stop = watchWindowHang(win, {
    dialog,
    log,
    delayMs: 8000,
    askAgainMs: 30000,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t: { live: boolean }) => {
      t.live = false;
    },
  });
  const fire = async (index = timers.length - 1) => {
    const t = timers[index];
    if (t?.live) {
      t.live = false;
      t.fn();
    }
    await new Promise((r) => setImmediate(r));
  };
  return { win, timers, dialog, log, stop, fire };
}

describe("a hung main window is not left silent", () => {
  it("asks nothing when the page answers again before the delay", async () => {
    const { win, dialog, fire } = setup();
    win.emit("unresponsive");
    win.emit("responsive");
    await fire();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("asks once after the delay and reloads only when the owner picks Reload", async () => {
    const reload = setup(1);
    reload.win.emit("unresponsive");
    expect(reload.timers[0]?.ms).toBe(8000);
    await reload.fire();
    expect(reload.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(reload.win.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);

    const wait = setup(0);
    wait.win.emit("unresponsive");
    await wait.fire();
    expect(wait.win.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
  });

  it("asks again later while Wait leaves the page stuck, and stops once it answers", async () => {
    const { win, timers, dialog, fire } = setup(0);
    win.emit("unresponsive");
    await fire();
    expect(timers.at(-1)?.ms).toBe(30000);
    await fire();
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
    win.emit("responsive");
    expect(timers.at(-1)?.live).toBe(false);
  });

  it("does not stack prompts for repeated events, and goes quiet on close or stop", async () => {
    const { win, timers, dialog, fire, stop } = setup();
    win.emit("unresponsive");
    win.emit("unresponsive");
    expect(timers.filter((t) => t.live)).toHaveLength(1);
    win.destroyed = true;
    await fire();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();

    const other = setup();
    other.win.emit("unresponsive");
    other.stop();
    expect(other.timers.every((t) => !t.live)).toBe(true);
    expect(other.win.listenerCount("unresponsive")).toBe(0);
    void stop;
  });

  it("is wired into the main window and skipped in the boot self-test", () => {
    const main = require_("node:fs").readFileSync("electron/main.cjs", "utf8") as string;
    expect(main).toMatch(
      /if \(!process\.env\.FRIDAY_BOOT_SELFTEST\) \{\s*require\("\.\/window-hang\.cjs"\)\.watchWindowHang\(win, \{ dialog, log \}\);/,
    );
  });
});
