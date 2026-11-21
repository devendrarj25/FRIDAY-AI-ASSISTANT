/**
 * The portable EXE and the installed (Setup) FRIDAY run side by side and do not disturb each other: the portable EXE
 * has its own settings folder (so its own single-instance lock and preferences), its own FRIDAY folder, its own kernel
 * port, never reads or writes the installed copy's registry pointer, never runs the Setup installer to update, and has
 * its own taskbar identity. Driven with real temporary folders and a fake Electron `app`.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

type Env = Record<string, string>;
const data = require_("../../electron/portable-data.cjs") as {
  HOME_NAME: string;
  PORTABLE_KERNEL_PORT: number;
  isPortable: (env?: Env) => boolean;
  dataHome: (env?: Env) => string | null;
  prepare: (
    app: unknown,
    env?: Env,
  ) => { portable: boolean; home: string; userData: string; root: string };
  appUserModelId: (base: string, env?: Env) => string;
  isPortableAsset: (name: string) => boolean;
  updateTarget: (o: { file: string; env?: Env; fallbackDir?: string }) => string | null;
};
const bind = require_("../../electron/kernel-bind.cjs") as {
  DEFAULT_KERNEL_PORT: number;
  PORTABLE_KERNEL_PORT: number;
  initialPort: (env?: Env) => number;
};
const sync = require_("../../electron/github-sync.cjs") as {
  installerAsset: (
    assets: Array<{ name: string }>,
    o?: { portable?: boolean },
  ) => { name: string } | null;
};

const made: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-portable-test-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  while (made.length) fs.rmSync(made.pop()!, { recursive: true, force: true });
});

class FakeApp {
  paths: Record<string, string> = {};
  setPath(name: string, value: string) {
    this.paths[name] = value;
  }
}

describe("the portable EXE's own data", () => {
  it("is portable only when the launcher's variable is set", () => {
    expect(
      data.isPortable({ PORTABLE_EXECUTABLE_FILE: "D:\\x\\FRIDAY-Portable-1.1.5.7.exe" }),
    ).toBe(true);
    expect(data.isPortable({})).toBe(false);
    expect(data.dataHome({})).toBeNull();
  });

  it("keeps settings, the lock and the FRIDAY folder in a folder beside the portable file", () => {
    const dir = temp();
    const env: Env = {
      PORTABLE_EXECUTABLE_FILE: path.join(dir, "FRIDAY-Portable-1.1.5.7.exe"),
      PORTABLE_EXECUTABLE_DIR: dir,
    };
    const app = new FakeApp();
    const plan = data.prepare(app, env);
    const home = path.join(dir, data.HOME_NAME);
    expect(plan).toEqual({
      portable: true,
      home,
      userData: path.join(home, "userData"),
      root: path.join(home, "FRIDAY"),
    });
    expect(app.paths["userData"]).toBe(plan.userData);
    expect(app.paths["sessionData"]).toBe(plan.userData);
    expect(fs.statSync(plan.root).isDirectory()).toBe(true);
    // The owner's own FRIDAY_WORKSPACE_ROOT is never overwritten (the default is resolved in the app).
    expect(env["FRIDAY_WORKSPACE_ROOT"]).toBeUndefined();
  });

  it("an installed run changes nothing", () => {
    const app = new FakeApp();
    const env: Env = {};
    expect(data.prepare(app, env)).toEqual({ portable: false, home: "", userData: "", root: "" });
    expect(app.paths).toEqual({});
    expect(env).toEqual({});
  });

  it("falls back to the local app-data folder when the portable file's folder cannot be written", () => {
    const dir = temp();
    const blocker = path.join(dir, "not-a-folder");
    fs.writeFileSync(blocker, "x");
    const local = path.join(dir, "local");
    const home = data.dataHome({
      PORTABLE_EXECUTABLE_FILE: path.join(blocker, "FRIDAY-Portable.exe"),
      PORTABLE_EXECUTABLE_DIR: blocker,
      LOCALAPPDATA: local,
    });
    expect(home).toBe(path.join(local, data.HOME_NAME));
  });

  it("FRIDAY_PORTABLE_DATA names another home", () => {
    const dir = temp();
    expect(data.dataHome({ PORTABLE_EXECUTABLE_FILE: "x.exe", FRIDAY_PORTABLE_DATA: dir })).toBe(
      path.resolve(dir),
    );
  });

  it("two portable copies in two folders do not share a thing", () => {
    const a = temp();
    const b = temp();
    const planA = data.prepare(new FakeApp(), {
      PORTABLE_EXECUTABLE_FILE: path.join(a, "F.exe"),
      PORTABLE_EXECUTABLE_DIR: a,
    });
    const planB = data.prepare(new FakeApp(), {
      PORTABLE_EXECUTABLE_FILE: path.join(b, "F.exe"),
      PORTABLE_EXECUTABLE_DIR: b,
    });
    expect(planA.userData).not.toBe(planB.userData);
    expect(planA.root).not.toBe(planB.root);
  });
});

describe("a port and a taskbar identity of its own", () => {
  it("the portable EXE defaults to 8766 and the installed FRIDAY keeps 8765; an explicit port wins", () => {
    expect(bind.PORTABLE_KERNEL_PORT).toBe(8766);
    expect(data.PORTABLE_KERNEL_PORT).toBe(8766);
    expect(bind.initialPort({})).toBe(8765);
    expect(bind.initialPort({ PORTABLE_EXECUTABLE_FILE: "x.exe" })).toBe(8766);
    expect(
      bind.initialPort({ PORTABLE_EXECUTABLE_FILE: "x.exe", FRIDAY_KERNEL_PORT: "9000" }),
    ).toBe(9000);
  });

  it("is not grouped with, or pinned as, the installed FRIDAY in the taskbar", () => {
    expect(data.appUserModelId("dev.friday.desk", {})).toBe("dev.friday.desk");
    expect(data.appUserModelId("dev.friday.desk", { PORTABLE_EXECUTABLE_FILE: "x.exe" })).toBe(
      "dev.friday.desk.portable",
    );
  });
});

describe("updates replace the portable file and never run the Setup installer", () => {
  const assets = [
    { name: "FRIDAY-Setup-1.1.5.8.exe" },
    { name: "FRIDAY-Portable-1.1.5.8.exe" },
    { name: "latest.yml" },
  ];

  it("picks the Setup installer for the installed FRIDAY and the Portable file for the portable EXE", () => {
    expect(sync.installerAsset(assets)!.name).toBe("FRIDAY-Setup-1.1.5.8.exe");
    expect(sync.installerAsset(assets, { portable: true })!.name).toBe(
      "FRIDAY-Portable-1.1.5.8.exe",
    );
    expect(
      sync.installerAsset([{ name: "FRIDAY-Setup-1.1.5.8.exe" }], { portable: true }),
    ).toBeNull();
  });

  it("knows a Portable file by name", () => {
    expect(data.isPortableAsset("FRIDAY-Portable-1.1.5.7.exe")).toBe(true);
    expect(data.isPortableAsset("FRIDAY-Test-Portable-1.1.5.8-test.1.exe")).toBe(true);
    expect(data.isPortableAsset("FRIDAY-Setup-1.1.5.7.exe")).toBe(false);
    expect(data.isPortableAsset("FRIDAY-Portable.zip")).toBe(false);
  });

  it("puts the new file beside the running one, never over it", () => {
    const dir = temp();
    const downloads = path.join(temp(), "installers");
    const running = path.join(dir, "FRIDAY-Portable-1.1.5.7.exe");
    const env: Env = { PORTABLE_EXECUTABLE_FILE: running, PORTABLE_EXECUTABLE_DIR: dir };
    const file = path.join(downloads, "FRIDAY-Portable-1.1.5.8.exe");
    expect(data.updateTarget({ file, env, fallbackDir: downloads })).toBe(
      path.join(dir, "FRIDAY-Portable-1.1.5.8.exe"),
    );
    // The running file itself is refused.
    expect(data.updateTarget({ file: running, env, fallbackDir: dir })).toBeNull();
  });

  it("uses the download folder when the portable file's folder cannot be written", () => {
    const base = temp();
    const blocker = path.join(base, "file");
    fs.writeFileSync(blocker, "x");
    const downloads = path.join(base, "installers");
    const env: Env = {
      PORTABLE_EXECUTABLE_FILE: path.join(blocker, "FRIDAY-Portable-1.1.5.7.exe"),
      PORTABLE_EXECUTABLE_DIR: blocker,
    };
    expect(
      data.updateTarget({
        file: path.join(downloads, "FRIDAY-Portable-1.1.5.8.exe"),
        env,
        fallbackDir: downloads,
      }),
    ).toBe(path.join(downloads, "FRIDAY-Portable-1.1.5.8.exe"));
  });
});

describe("main.cjs keeps the two apart", () => {
  const main = read("electron/main.cjs");

  it("sets the portable data folder before anything reads userData or asks for the lock", () => {
    const prepare = main.indexOf("portableData.prepare(app, process.env)");
    expect(prepare).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(main.indexOf("enableCompileCache"));
    expect(prepare).toBeLessThan(main.indexOf("app.requestSingleInstanceLock()"));
    expect(prepare).toBeLessThan(main.indexOf("app.setAppUserModelId("));
    expect(main).toContain('app.setAppUserModelId(portableData.appUserModelId("dev.friday.desk"))');
  });

  it("never reads or writes the installed copy's registry pointer, and falls back to its own FRIDAY folder", () => {
    const readFn = main.slice(main.indexOf("function readRegistryWorkspace()"));
    expect(readFn.slice(0, 400)).toContain("if (PORTABLE_RUN) return Promise.resolve(null);");
    const writeFn = main.slice(main.indexOf("function writeRegistryWorkspace(root)"));
    expect(writeFn.slice(0, 300)).toContain("if (PORTABLE_RUN) return;");
    expect(main).toContain("if (PORTABLE_RUN && portableMode.root)");
  });

  it("never adopts a kernel that is already running, and an update never runs the Setup installer", () => {
    expect(main).toContain(
      "const own = PORTABLE_RUN ? false : await kernelBind.probeFriday(KERNEL_PORT);",
    );
    expect(main).toContain("return installPortableUpdate({");
    const apply = main.slice(main.indexOf("async function installPortableUpdate("));
    const body = apply.slice(0, apply.indexOf("/** Pending/stable update state"));
    expect(body).not.toContain("installerLaunch");
    expect(body).not.toContain("SILENT_UPDATE_ARGS");
    expect(body).toContain('["--friday-restart=1"]');
    expect(main).toContain("{ portable: PORTABLE_RUN }");
  });

  it("tells the page where the portable data lives", () => {
    expect(main).toContain('portableHome: portableMode.home || "",');
  });
});
