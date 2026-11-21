/**
 * Start at sign-in. `wasOpenedAtLogin` is macOS only, so on Windows FRIDAY could not tell it had been started at
 * sign-in and opened a window over the desktop every time; a portable build wrote a path that no longer exists; and
 * the registry value was named differently from the one Setup's uninstaller removes. The module is driven with a
 * fake `app` that stores entries the way Windows does (value name -> path + args).
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const login = require_("../../electron/login-item.cjs") as {
  LOGIN_ARG: string;
  VALUE_NAME: string;
  LEGACY_VALUE_NAME: string;
  options: (env?: Record<string, string>, execPath?: string) => { path: string; args: string[] };
  isEnabled: (app: FakeApp, ctx?: Ctx) => boolean;
  setEnabled: (app: FakeApp, on: boolean, ctx?: Ctx) => boolean;
  migrate: (app: FakeApp, ctx?: Ctx) => boolean;
  isPortable: (env?: Record<string, string>) => boolean;
  release: (app: FakeApp, ctx?: Ctx) => boolean;
  startedAtLogin: (argv?: string[], settings?: Record<string, unknown> | null) => boolean;
};

type Ctx = { env?: Record<string, string>; execPath?: string };
type Entry = { path: string; args: string[] };
type SetCall = { openAtLogin: boolean; name?: string; path?: string; args?: string[] };

/** A Windows Run key: openAtLogin is true only when a stored entry matches path and args. */
class FakeApp {
  run = new Map<string, Entry>();
  execPath: string;
  constructor(execPath = "C:\\FRIDAY\\App\\FRIDAY.exe") {
    this.execPath = execPath;
  }
  setLoginItemSettings(s: SetCall) {
    const name = s.name ?? "dev.friday.desk"; // Electron's default: the AppUserModelId
    if (!s.openAtLogin) this.run.delete(name);
    else this.run.set(name, { path: s.path ?? this.execPath, args: s.args ?? [] });
  }
  getLoginItemSettings(o: { path?: string; args?: string[] } = {}) {
    const wantPath = o.path ?? this.execPath;
    const wantArgs = JSON.stringify(o.args ?? []);
    const hit = [...this.run.values()].some(
      (e) => e.path === wantPath && JSON.stringify(e.args) === wantArgs,
    );
    return { openAtLogin: hit };
  }
}

const ctx = (extra: Record<string, string> = {}): Ctx => ({
  env: extra,
  execPath: "C:\\FRIDAY\\App\\FRIDAY.exe",
});

describe("the sign-in entry", () => {
  it("launches the program with the sign-in marker, under the name Setup's uninstaller removes", () => {
    const app = new FakeApp();
    expect(login.setEnabled(app, true, ctx())).toBe(true);
    expect([...app.run.keys()]).toEqual(["FRIDAY"]);
    expect(app.run.get("FRIDAY")).toEqual({
      path: "C:\\FRIDAY\\App\\FRIDAY.exe",
      args: ["--friday-login"],
    });
    expect(login.VALUE_NAME).toBe("FRIDAY");
  });

  it("writes the portable launcher's file, not the temporary folder it unpacks into", () => {
    const app = new FakeApp("C:\\Users\\a\\AppData\\Local\\Temp\\abc123\\FRIDAY.exe");
    const env = { PORTABLE_EXECUTABLE_FILE: "D:\\Tools\\FRIDAY-Portable-1.1.5.7.exe" };
    login.setEnabled(app, true, { env, execPath: app.execPath });
    expect(app.run.get("FRIDAY")!.path).toBe("D:\\Tools\\FRIDAY-Portable-1.1.5.7.exe");
    expect(login.isEnabled(app, { env, execPath: app.execPath })).toBe(true);
  });

  it("turning it off removes the entry and the one an earlier build wrote under the old name", () => {
    const app = new FakeApp();
    app.run.set("dev.friday.desk", { path: app.execPath, args: [] });
    app.run.set("FRIDAY", { path: app.execPath, args: ["--friday-login"] });
    expect(login.setEnabled(app, false, ctx())).toBe(false);
    expect(app.run.size).toBe(0);
  });

  it("an entry from an older build still shows as on, and is rewritten once", () => {
    const app = new FakeApp();
    app.run.set("dev.friday.desk", { path: app.execPath, args: [] });
    expect(login.isEnabled(app, ctx())).toBe(true);
    expect(login.migrate(app, ctx())).toBe(true);
    expect([...app.run.keys()]).toEqual(["FRIDAY"]);
    expect(app.run.get("FRIDAY")!.args).toEqual(["--friday-login"]);
    expect(login.migrate(app, ctx())).toBe(false);
  });

  it("does nothing when sign-in start was never switched on", () => {
    const app = new FakeApp();
    expect(login.isEnabled(app, ctx())).toBe(false);
    expect(login.migrate(app, ctx())).toBe(false);
    expect(app.run.size).toBe(0);
  });
});

describe("knowing the launch came from the sign-in entry", () => {
  it("reads the argument on Windows, where the OS flag does not exist", () => {
    expect(login.startedAtLogin(["C:\\FRIDAY.exe", "--friday-login"], { openAtLogin: true })).toBe(
      true,
    );
    expect(
      login.startedAtLogin(["C:\\FRIDAY.exe"], { openAtLogin: true, wasOpenedAtLogin: false }),
    ).toBe(false);
  });

  it("still honours the macOS flag", () => {
    expect(login.startedAtLogin(["FRIDAY"], { openAtLogin: true, wasOpenedAtLogin: true })).toBe(
      true,
    );
    expect(login.startedAtLogin(["FRIDAY"], null)).toBe(false);
  });
});

describe("main.cjs uses it everywhere", () => {
  const main = readFileSync(path.join(root, "electron/main.cjs"), "utf8");

  it("has no raw login-item call left, and reads the launch reason through the module", () => {
    expect(main).not.toMatch(/app\.setLoginItemSettings\(/);
    expect(main).toContain("loginItem.setEnabled(app, Boolean(toggles.startup))");
    expect(main).toContain(
      'ipcMain.handle("startup:get", () => (PORTABLE_RUN ? false : loginItem.isEnabled(app)));',
    );
    expect(main).toContain("loginItem.startedAtLogin(process.argv, settings)");
    expect(main).toContain("loginItem.migrate(app)");
  });

  it("does not carry the sign-in marker into a restart the owner asked for", () => {
    const fn = main.slice(main.indexOf("function restartArgv()"), main.indexOf("const life = "));
    expect(fn).toContain("LOGIN_ARG");
    expect(fn).toContain('"--friday-restart=1"');
  });
});

describe("the portable EXE is a program you run, not an installation", () => {
  const portableEnv = { PORTABLE_EXECUTABLE_FILE: "D:\\Tools\\FRIDAY-Portable-1.1.5.7.exe" };
  const temp = "C:\\Users\\a\\AppData\\Local\\Temp\\abc123\\FRIDAY.exe";

  it("knows it is portable from the launcher's variable, and an installed copy is not", () => {
    expect(login.isPortable(portableEnv)).toBe(true);
    expect(login.isPortable({})).toBe(false);
    expect(login.isPortable({ PORTABLE_EXECUTABLE_FILE: "  " })).toBe(false);
  });

  it("removes the entry an earlier build wrote for the portable file, in either form", () => {
    for (const args of [["--friday-login"], []]) {
      const app = new FakeApp(temp);
      app.run.set("FRIDAY", { path: portableEnv.PORTABLE_EXECUTABLE_FILE, args });
      expect(login.release(app, { env: portableEnv, execPath: temp })).toBe(true);
      expect(app.run.size).toBe(0);
    }
  });

  it("never touches the entry of an installed copy, which points at its own program", () => {
    const app = new FakeApp(temp);
    app.run.set("FRIDAY", { path: "D:\\FRIDAY\\App\\FRIDAY.exe", args: ["--friday-login"] });
    expect(login.release(app, { env: portableEnv, execPath: temp })).toBe(false);
    expect(app.run.get("FRIDAY")!.path).toBe("D:\\FRIDAY\\App\\FRIDAY.exe");
    // An installed FRIDAY never runs the release at all.
    expect(login.release(app, { env: {}, execPath: "D:\\FRIDAY\\App\\FRIDAY.exe" })).toBe(false);
    expect(app.run.size).toBe(1);
  });

  it("main.cjs: no sign-in entry, no tray or background after close, no hidden start, from the portable file", () => {
    const main = readFileSync(path.join(root, "electron/main.cjs"), "utf8");
    expect(main).toContain("const PORTABLE_RUN = portableMode.portable;");
    // The sign-in entry is neither read, written nor migrated.
    expect(main).toContain('!PORTABLE_RUN &&\n      typeof toggles.startup === "boolean"');
    expect(main).toContain("PORTABLE_RUN ? false : loginItem.setEnabled(app, Boolean(enabled))");
    expect(main).toContain("loginItem.release(app,");
    // A leftover marker never keeps the window hidden.
    const hidden = main.slice(main.indexOf("function loginLaunchHidden()"));
    expect(hidden.slice(0, 400)).toContain("if (PORTABLE_RUN) return false;");
    // The X button quits (after asking when tasks run), and launching minimized to the tray is ignored.
    expect(main).toContain('const closeToTray = !PORTABLE_RUN && ownerPrefToggle("tray", true);');
    expect(main).toContain("!PORTABLE_RUN &&");
    expect(main).toMatch(/launchMinimized", false\)/);
    const closeIpc = main.slice(main.indexOf('ipcMain.on("window:close"'));
    expect(closeIpc.slice(0, 500)).toContain("if (PORTABLE_RUN)");
    expect(closeIpc.slice(0, 500)).toContain("target.close()");
    expect(main).toContain("if (PORTABLE_RUN) liveWin()?.minimize();");
    expect(main).toContain("portable: PORTABLE_RUN,");
  });

  it("Settings shows the three switches off for the portable EXE and says why, and keeps the saved preferences", () => {
    const ui = readFileSync(
      path.join(root, "src/components/friday/settings/GeneralSettings.tsx"),
      "utf8",
    );
    expect(ui).toContain("if (value?.portable) {");
    expect(ui).toContain("setPortable(true);");
    expect(ui).toContain('on={!portable && isOn("startup")}');
    expect(ui).toContain('on={!portable && isOn("launchMinimized")}');
    expect(ui).toContain('on={!portable && isOn("tray")}');
    expect(ui).toContain("Setup install only");
    // A portable FRIDAY never writes the installed copy's preferences from the Windows state.
    expect(ui).toMatch(/\} else read\(\);/);
  });
});

describe("Setup's uninstaller clears both names", () => {
  const nsh = readFileSync(path.join(root, "installer/build/installer.nsh"), "utf8");
  it("removes the Run and approval values under FRIDAY and under the old AppUserModelId name, in both modes", () => {
    for (const name of ["FRIDAY", "dev.friday.desk"]) {
      const run = new RegExp(
        `DeleteRegValue HKCU "Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run" "${name}"`,
        "g",
      );
      const approved = new RegExp(
        `DeleteRegValue HKCU "Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\StartupApproved\\\\Run" "${name}"`,
        "g",
      );
      expect(nsh.match(run)?.length, `${name} Run`).toBe(2);
      expect(nsh.match(approved)?.length, `${name} StartupApproved`).toBe(2);
    }
  });
});

describe("a window hidden to the tray can always be found again", () => {
  const main = readFileSync(path.join(root, "electron/main.cjs"), "utf8");
  const tray = readFileSync(path.join(root, "electron/tray.cjs"), "utf8");

  it("hides only when a tray icon exists, and minimizes to the taskbar when it does not", () => {
    const fn = main.slice(
      main.indexOf("function hideToTray()"),
      main.indexOf("/** Active work the confirm dialog lists."),
    );
    expect(fn).toContain('typeof tray.isAvailable === "function" && tray.isAvailable()');
    expect(fn).toContain("target.hide()");
    expect(fn).toContain("target.minimize()");
    expect(fn.indexOf("target.hide()")).toBeLessThan(fn.indexOf("target.minimize()"));
  });

  it("the tray reports whether its icon is there", () => {
    expect(tray).toContain("function isAvailable()");
    expect(tray).toMatch(/module\.exports = \{[^}]*isAvailable/);
    const api = require_("../../electron/tray.cjs") as { isAvailable: () => boolean };
    expect(api.isAvailable()).toBe(false); // nothing has created an icon in this process
  });
});

describe("ending FRIDAY with a signal", () => {
  const main = readFileSync(path.join(root, "electron/main.cjs"), "utf8");

  it("shuts down in order on the first signal and ends at once on a second, so the kernel is not left running", () => {
    const at = main.indexOf('for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"])');
    expect(at).toBeGreaterThan(-1);
    const block = main.slice(at, at + 700);
    expect(block).toContain("process.on(signal");
    expect(block).toContain("life.requestShutdown(`signal ${signal}`)");
    expect(block).toContain("life.exitNow(130");
    // The handler is installed after the lifecycle exists and before the app is ready.
    expect(main.indexOf("const life = appLifecycle.createLifecycle")).toBeLessThan(at);
    expect(at).toBeLessThan(main.indexOf("app.whenReady()"));
  });
});
