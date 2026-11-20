/**
 * Opening FRIDAY: a window at once, nothing said or heard behind the boot screen, few popups, a bell that opens.
 * The owner's report: the loading window came long after the double click; FRIDAY started talking while the boot
 * screen still said "Restoring your state"; popups kept coming ("config reloaded") in text too dark to read; and the
 * notification bell did nothing.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTION_WINDOW_MS,
  BURST_LIMIT,
  REPEAT_MS,
  SETTLE_MS,
  decidePopup,
  type PopupInput,
} from "../../src/lib/friday/toast-bridge";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

type Splash = {
  shown: boolean;
  status: (t: string) => void;
  close: () => void;
  whenPainted: (ms?: number) => Promise<unknown>;
};
const splash = require_("../../electron/early-splash.cjs") as {
  shouldShow: (o: { env?: Record<string, string>; argv?: string[]; loginArg?: string }) => boolean;
  splashHtml: (status?: string) => string;
  create: (o: Record<string, unknown>) => Splash;
  MAX_LIFE_MS: number;
};
const assets = require_("../../electron/splash-assets.cjs") as {
  ORBITRON_700_LATIN_FRIDAY: string;
  RAJDHANI_500_ASCII: string;
  SPLASH_LOGO_PNG: string;
  SPLASH_BACKGROUND: string;
};

describe("the first window", () => {
  it("is shown for an ordinary start and a restart, not for a start at sign-in, CI or when switched off", () => {
    expect(splash.shouldShow({ env: {}, argv: ["FRIDAY.exe"] })).toBe(true);
    expect(splash.shouldShow({ env: {}, argv: ["FRIDAY.exe", "--friday-restart=1"] })).toBe(true);
    expect(splash.shouldShow({ env: {}, argv: ["FRIDAY.exe", "--friday-login"] })).toBe(false);
    expect(splash.shouldShow({ env: { FRIDAY_BOOT_SELFTEST: "1" }, argv: [] })).toBe(false);
    expect(splash.shouldShow({ env: { FRIDAY_READINESS: "1" }, argv: [] })).toBe(false);
    expect(splash.shouldShow({ env: {}, argv: ["--friday-boot-selftest"] })).toBe(false);
    expect(splash.shouldShow({ env: { FRIDAY_NO_SPLASH: "1" }, argv: [] })).toBe(false);
  });

  it("is one inline page: no script, no network, only data fonts and images, and the status text is escaped", () => {
    const html = splash.splashHtml('Opening <b>"x"</b>');
    expect(html).toContain("script-src 'none'");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
    expect(html).toContain(assets.ORBITRON_700_LATIN_FRIDAY);
    expect(html).toContain(assets.RAJDHANI_500_ASCII);
  });

  it("is made the moment Electron is ready, names the stage being worked on and goes away on request", async () => {
    const made: Record<string, unknown>[] = [];
    const js: string[] = [];
    let destroyed = false;
    let ready: () => void = () => undefined;
    const app = { whenReady: () => new Promise<void>((resolve) => (ready = resolve)) };
    class FakeWindow {
      webContents = {
        once: (event: string, fn: () => void) => {
          if (event === "did-finish-load") setTimeout(fn, 0);
        },
        on: () => undefined,
        setWindowOpenHandler: () => undefined,
        executeJavaScript: (code: string) => {
          js.push(code);
          return Promise.resolve();
        },
      };
      constructor(options: Record<string, unknown>) {
        made.push(options);
      }
      setMenuBarVisibility() {}
      loadURL() {
        return Promise.resolve();
      }
      isDestroyed() {
        return destroyed;
      }
      destroy() {
        destroyed = true;
      }
    }
    const timers: Array<() => void> = [];
    const handle = splash.create({
      app,
      BrowserWindow: FakeWindow,
      env: {},
      argv: [],
      setTimer: (fn: () => void) => {
        timers.push(fn);
        return { unref() {} };
      },
      clearTimer: () => undefined,
    });
    expect(made).toHaveLength(0);
    ready();
    await Promise.resolve();
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({
      frame: false,
      show: true,
      skipTaskbar: true,
      resizable: false,
    });
    expect(made[0]?.["webPreferences"]).toMatchObject({ sandbox: true, nodeIntegration: false });
    handle.status("Opening your FRIDAY folder");
    expect(js[0]).toContain("Opening your FRIDAY folder");
    handle.close();
    expect(destroyed).toBe(true);
    handle.status("after close");
    expect(js).toHaveLength(1);
  });

  it("does not outlive its fail-safe timer, and a start that does not show it costs nothing", async () => {
    expect(splash.MAX_LIFE_MS).toBeLessThanOrEqual(120_000);
    const quiet = splash.create({
      app: { whenReady: () => Promise.resolve() },
      BrowserWindow: class {},
      env: { FRIDAY_READINESS: "1" },
      argv: [],
    });
    expect(quiet.shown).toBe(false);
    await expect(quiet.whenPainted(5)).resolves.toBeUndefined();
  });

  it("looks like the boot screen that follows: the same background, and the same two fonts in the static page", () => {
    expect(assets.SPLASH_BACKGROUND).toBe("#030b1a");
    const page = read("src/renderer/index.html");
    expect(page).toContain(assets.ORBITRON_700_LATIN_FRIDAY);
    expect(page).toContain(assets.RAJDHANI_500_ASCII);
    expect(page).toContain(assets.SPLASH_BACKGROUND);
    expect(page).not.toContain("#141821");
    expect(page).toContain('font: 700 36px "FridaySplashDisplay"');
  });
});

describe("how the main process uses it", () => {
  const main = read("electron/main.cjs");

  it("loads from the code cache, shows the splash first, lets it load, and closes it with the real window", () => {
    expect(main).toContain("enableCompileCache");
    const cache = main.indexOf("enableCompileCache");
    const early = main.indexOf('require("./early-splash.cjs")');
    expect(cache).toBeGreaterThan(-1);
    expect(early).toBeGreaterThan(cache);
    // Before every other module is loaded.
    expect(early).toBeLessThan(main.indexOf('require("./system-health.cjs")'));
    expect(main).toContain("await earlySplash.whenPainted(350)");
    const reveal = main.slice(main.indexOf("const reveal = () =>"));
    expect(reveal.slice(0, 1500).match(/earlySplash\.close\(\)/g)?.length).toBeGreaterThanOrEqual(
      3,
    );
    expect(main).toContain("earlySplash.status(stage ? stage.label : label)");
  });
});

describe("nothing is heard or said behind the boot screen", () => {
  it("Auto waits for the boot screen, and a reply is not spoken while it is up", () => {
    const mode = read("src/lib/friday/assistant-mode.ts");
    expect(mode).toContain("private enterAutoWhenStarted()");
    expect(mode).toContain("this.enterAutoWhenStarted();");
    expect(mode).toContain("whenBootDone(");
    const speak = mode.slice(mode.indexOf("private speak(text: string)"));
    expect(speak.slice(0, 600)).toContain("isBootHolding()");
    const streamed = mode.slice(mode.indexOf("private speakStreamed("));
    expect(streamed.slice(0, 300)).toContain("isBootHolding()");
    const leave = mode.slice(mode.indexOf("private leaveAuto()"));
    expect(leave.slice(0, 300)).toContain("this.bootWait?.()");
    const desktop = read("src/lib/friday/desktop.ts");
    expect(desktop).toContain("export function isBootHolding()");
    expect(desktop).toContain("export function whenBootDone(");
  });
});

describe("popups", () => {
  const base: PopupInput = {
    level: "success",
    hasAction: false,
    sinceInputMs: 1000,
    booting: false,
    sinceBootMs: SETTLE_MS + 1000,
    sinceSameMs: Number.POSITIVE_INFINITY,
    recentBurst: 0,
  };
  const pop = (change: Partial<PopupInput>) => decidePopup({ ...base, ...change });

  it("a failure, a warning and a toast with a button pop up; the answer to what the owner just did pops up", () => {
    expect(pop({ level: "error", sinceInputMs: Infinity })).toBe(true);
    expect(pop({ level: "warn", sinceInputMs: Infinity })).toBe(true);
    expect(pop({ level: "info", hasAction: true, sinceInputMs: Infinity })).toBe(true);
    expect(pop({ level: "success" })).toBe(true);
    expect(pop({ level: "info", sinceInputMs: ACTION_WINDOW_MS - 1 })).toBe(true);
  });

  it("system chatter stays in the notification centre: nothing the owner did, nothing at start-up", () => {
    // "config reloaded", a background refresh, a status the watcher noticed
    expect(pop({ level: "success", sinceInputMs: Infinity })).toBe(false);
    expect(pop({ level: "info", sinceInputMs: ACTION_WINDOW_MS + 1 })).toBe(false);
    // while the boot screen is up, and for a while after it
    expect(pop({ level: "success", booting: true })).toBe(false);
    expect(pop({ level: "success", sinceBootMs: SETTLE_MS - 1 })).toBe(false);
    expect(pop({ level: "warn", booting: true })).toBe(false);
    expect(pop({ level: "info", hasAction: true, booting: true })).toBe(false);
    // a real failure is never held back by start-up
    expect(pop({ level: "error", booting: true })).toBe(true);
  });

  it("the same popup is not raised again soon, and a burst is capped", () => {
    expect(pop({ level: "error", sinceSameMs: REPEAT_MS - 1 })).toBe(false);
    expect(pop({ level: "error", sinceSameMs: REPEAT_MS + 1 })).toBe(true);
    expect(pop({ recentBurst: BURST_LIMIT - 1 })).toBe(true);
    expect(pop({ recentBurst: BURST_LIMIT })).toBe(false);
    // the cap never holds back a failure
    expect(pop({ level: "error", recentBurst: 99 })).toBe(true);
  });

  it("source: the policy lives in the one bridge every toast goes through and keeps the toast's id", () => {
    const text = read("src/lib/friday/toast-bridge.ts");
    expect(text).toContain("shouldPopUp(level, message, options)");
    expect(text).toContain("return id;");
    expect(text).toContain("quietIds.has(id) && !failure");
  });
});

describe("the bell and the readable popup", () => {
  it("the list is drawn on the page, not inside the title strip that clips it; the bell is 32 px", () => {
    const bell = read("src/components/friday/NotificationCenter.tsx");
    expect(bell).toContain("createPortal(");
    expect(bell).toContain("document.body");
    expect(bell).toContain("fixed z-[80]");
    expect(bell).toContain("relative grid size-8 place-items-center");
    expect(bell).toContain("panelRef.current?.contains(target)");
  });

  it("the second line of a popup is body text, not the muted grey that vanished on the dark glass", () => {
    const css = read("src/styles.css");
    const rule = css.slice(css.indexOf("[data-sonner-toast] [data-description]"));
    expect(rule.slice(0, 200)).toContain("color-mix(in oklab, var(--foreground) 82%, transparent)");
    expect(read("src/components/ui/sonner.tsx")).toContain("visibleToasts={2}");
  });

  it("small glass text is 13 px and one weight heavier", () => {
    const css = read("src/styles.css");
    for (const token of [
      "text-meta",
      "text-meta-sm",
      "text-note",
      "text-note-sm",
      "text-data",
      "text-data-sm",
    ]) {
      const at = css.indexOf(`html[data-ui-style="glass"] .${token} {`);
      expect(at, token).toBeGreaterThan(-1);
      const body = css.slice(at, css.indexOf("}", at));
      expect(body, token).toContain("font-size: 0.8125rem;");
      expect(body, token).toContain("font-weight: 500;");
    }
  });
});
