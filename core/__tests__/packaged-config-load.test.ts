import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { load as parseYaml } from "js-yaml";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
const paths = require_(path.join(ROOT, "electron/resource-paths.cjs")) as {
  resolveConfigFile: (name: string) => string | null;
  resolveResourceFile: (relative: string) => string | null;
  readConfigJson: (name: string, fallback: unknown) => { degraded: boolean; value: unknown };
  configHealth: () => { name: string; degraded: boolean }[];
  clearConfigCache: () => void;
};
const checker = require_(path.join(ROOT, "scripts/packaged-requires.cjs")) as {
  LAZY_GUARDED: { file: string; spec: string }[];
  checkRequires: (input: { root: string; asarFiles: string[] }) => {
    file: string;
    spec: string;
    tried: string[];
  }[];
  filesFromPatterns: (root: string, patterns: string[]) => string[];
  matcherFrom: (
    loaded: unknown,
  ) => (file: string, pattern: string, options: { dot: true }) => boolean;
  formatFailure: (row: { file: string; spec: string; tried: string[] }) => string;
  listAsar: (file: string) => string[];
};
const readiness = require_(path.join(ROOT, "scripts/readiness-test.cjs")) as {
  CEILING_MS: number;
  LOAD_STALL_MS: number;
  stallVerdict: (input: {
    events: { milestone: string; t?: string; message?: string }[];
    startedAt: number;
    now: number;
  }) => { fail: boolean; reason: string; milestone: string };
};

type FileSet = { from: string; to?: string; filter?: string[] };
type Builder = { files?: string[]; extraResources?: (string | FileSet)[] };

type Proc = NodeJS.Process & { resourcesPath?: string };
const proc = process as Proc;

function setResourcesPath(value: string | undefined) {
  if (value === undefined) delete proc.resourcesPath;
  else proc.resourcesPath = value;
}

const savedResourcesPath = proc.resourcesPath;

afterEach(() => {
  setResourcesPath(savedResourcesPath);
  paths.clearConfigCache();
});

function builder(): Builder {
  return parseYaml(fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8")) as Builder;
}

function copyFile(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyTree(from: string, to: string, filters?: string[]) {
  const positive = (filters || ["**/*"]).filter((item) => !item.startsWith("!"));
  const negative = (filters || [])
    .filter((item) => item.startsWith("!"))
    .map((item) => item.slice(1));
  const minimatch = checker.matcherFrom(require_("minimatch"));
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(from, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      const yes =
        positive.length === 0 ||
        positive.some((pattern) => minimatch(rel, pattern, { dot: true }) || rel === pattern);
      const no = negative.some(
        (pattern) => minimatch(rel, pattern, { dot: true }) || rel === pattern,
      );
      if (yes && !no) copyFile(full, path.join(to, rel));
    }
  };
  visit(from);
}

function placeExtra(resourcesDir: string, item: string | FileSet) {
  const spec = typeof item === "string" ? { from: item } : item;
  const from = path.join(ROOT, spec.from);
  if (!fs.existsSync(from)) return;
  const destination = spec.to ? path.join(resourcesDir, spec.to) : resourcesDir;
  if (fs.statSync(from).isFile()) {
    copyFile(from, destination);
    return;
  }
  if (spec.to) copyTree(from, destination, spec.filter);
  else copyTree(from, resourcesDir, spec.filter);
}

function packagedLayout() {
  const spec = builder();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-packaged-"));
  const appDir = path.join(dir, "app");
  const resourcesDir = path.join(dir, "resources");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });
  const patterns = (spec.files || []).filter((item) => typeof item === "string");
  for (const rel of checker.filesFromPatterns(ROOT, patterns)) {
    copyFile(path.join(ROOT, rel), path.join(appDir, rel));
  }
  for (const item of spec.extraResources || []) placeExtra(resourcesDir, item);
  return { dir, appDir, resourcesDir };
}

describe("packaged config load", () => {
  it("reads config from resources before the checkout and degrades when the file is missing", () => {
    const dev = paths.resolveConfigFile("download-hosts.json");
    expect(dev && dev.endsWith(path.join("config", "download-hosts.json"))).toBe(true);
    const hosts = paths.readConfigJson("download-hosts.json", { hosts: [], loopbackHttp: [] }) as {
      degraded: boolean;
      value: { hosts?: string[] };
    };
    expect(hosts.degraded).toBe(false);
    expect(hosts.value.hosts).toContain("github.com");

    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "friday-config-"));
    const previous = proc.resourcesPath;
    setResourcesPath(isolated);
    paths.clearConfigCache();
    const missing = paths.readConfigJson("not-shipped.json", {
      hosts: [],
      loopbackHttp: ["127.0.0.1"],
    }) as { degraded: boolean; value: { hosts: string[] } };
    expect(missing.degraded).toBe(true);
    expect(missing.value.hosts).toEqual([]);
    fs.mkdirSync(path.join(isolated, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(isolated, "config", "download-hosts.json"),
      JSON.stringify({ hosts: ["example.test"], loopbackHttp: ["127.0.0.1"] }),
    );
    paths.clearConfigCache();
    const packed = paths.readConfigJson("download-hosts.json", { hosts: [], loopbackHttp: [] }) as {
      value: { hosts: string[] };
      degraded: boolean;
      file: string | null;
    };
    expect(packed.degraded).toBe(false);
    expect(packed.file && packed.file.startsWith(isolated)).toBe(true);
    expect(packed.value.hosts).toEqual(["example.test"]);
    setResourcesPath(previous);
    paths.clearConfigCache();
    const health = paths.configHealth();
    expect(health.every((row) => row.degraded === false)).toBe(true);
  });

  it("reads config from above app.asar.unpacked when the resolver itself was extracted", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-unpacked-"));
    const electronDir = path.join(dir, "resources", "app.asar.unpacked", "electron");
    fs.mkdirSync(electronDir, { recursive: true });
    fs.mkdirSync(path.join(dir, "resources", "config"), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, "electron", "resource-paths.cjs"),
      path.join(electronDir, "resource-paths.cjs"),
    );
    fs.writeFileSync(
      path.join(dir, "resources", "config", "unpacked-probe.json"),
      JSON.stringify({ ok: true }),
    );
    const extracted = require_(path.join(electronDir, "resource-paths.cjs")) as {
      readConfigJson: (
        name: string,
        fallback: unknown,
      ) => { degraded: boolean; file: string | null; value: { ok?: boolean } };
    };
    const previous = proc.resourcesPath;
    setResourcesPath(undefined);
    const row = extracted.readConfigJson("unpacked-probe.json", null);
    setResourcesPath(previous);
    expect(row.degraded).toBe(false);
    expect(row.value.ok).toBe(true);
    expect(row.file).toBe(path.join(dir, "resources", "config", "unpacked-probe.json"));
  });

  it("fails a require that escapes the packaged file set and names the module", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-require-"));
    const electron = path.join(dir, "electron");
    fs.mkdirSync(electron, { recursive: true });
    fs.writeFileSync(
      path.join(electron, "sample.cjs"),
      'require("../config/download-hosts.json");\n',
    );
    const failures = checker.checkRequires({
      root: dir,
      asarFiles: ["electron/sample.cjs", "package.json", "scripts/release-engine.cjs"],
    });
    expect(failures).toEqual([
      {
        file: "electron/sample.cjs",
        spec: "../config/download-hosts.json",
        tried: ["config/download-hosts.json"],
      },
    ]);
    const row = failures[0];
    if (!row) throw new Error("expected one packaged require failure");
    expect(checker.formatFailure(row)).toContain("electron/sample.cjs");
    expect(checker.formatFailure(row)).toContain("config/download-hosts.json");
    expect(checker.LAZY_GUARDED).toEqual([]);
  });

  it("reads the glob matcher from both minimatch export shapes", () => {
    // minimatch 3 exports the matcher itself, minimatch 10 as `minimatch`.
    // Which one is hoisted to the top level is electron-builder's choice.
    const match = (file: string) => file.startsWith("electron/");
    expect(checker.matcherFrom(match)).toBe(match);
    expect(checker.matcherFrom({ minimatch: match })).toBe(match);
    const real = checker.matcherFrom(require_("minimatch"));
    expect(real("electron/main.cjs", "electron/**", { dot: true })).toBe(true);
    expect(real("config/kernel.yaml", "electron/**", { dot: true })).toBe(false);
  });

  it("keeps every electron relative require inside the packaged files set", () => {
    const spec = builder();
    const patterns = (spec.files || []).filter((item) => typeof item === "string");
    const listed = checker.filesFromPatterns(ROOT, patterns);
    expect(listed.some((file) => file.startsWith("config/"))).toBe(false);
    expect(listed).toContain("scripts/release-engine.cjs");
    expect(listed).toContain("electron/main.cjs");
    const failures = checker.checkRequires({ root: ROOT, asarFiles: listed });
    expect(failures.map(checker.formatFailure)).toEqual([]);
  });

  it("loads the main-process graph from a files-only layout with config beside the asar", () => {
    const layout = packagedLayout();
    expect(fs.existsSync(path.join(layout.appDir, "config", "download-hosts.json"))).toBe(false);
    expect(fs.existsSync(path.join(layout.appDir, "config", "local-runners.json"))).toBe(false);
    expect(fs.existsSync(path.join(layout.resourcesDir, "config", "download-hosts.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(layout.resourcesDir, "config", "local-runners.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(layout.resourcesDir, "kernel", "main.py"))).toBe(true);
    expect(fs.existsSync(path.join(layout.appDir, "electron", "friday-mcp.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(layout.resourcesDir, "scripts", "env-registry.cjs"))).toBe(true);

    const probe = path.join(layout.appDir, "electron", "probe-missing-config.cjs");
    fs.writeFileSync(probe, "module.exports = require('../config/download-hosts.json');\n");
    let missing: NodeJS.ErrnoException | null = null;
    try {
      require_(probe);
    } catch (error) {
      missing = error as NodeJS.ErrnoException;
    }
    expect(missing && missing.code).toBe("MODULE_NOT_FOUND");
    expect(String(missing && missing.message)).toContain("download-hosts.json");

    const asarFile = path.join(layout.dir, "app.asar");
    const asar = require_("@electron/asar") as {
      createPackage: (src: string, dest: string) => Promise<void>;
    };
    return asar.createPackage(layout.appDir, asarFile).then(() => {
      const listed = checker.listAsar(asarFile);
      expect(listed.some((file) => file.startsWith("config/"))).toBe(false);
      expect(listed).toContain("electron/download-safety.cjs");
      expect(listed).toContain("scripts/release-engine.cjs");
      const failures = checker.checkRequires({ root: ROOT, asarFiles: listed });
      expect(failures.map(checker.formatFailure)).toEqual([]);
    });
  });

  it("requires the copied main process without a missing module", () => {
    const layout = packagedLayout();
    const stubFile = path.join(layout.dir, "electron-stub.cjs");
    fs.writeFileSync(
      stubFile,
      `function bag(base) {
        return new Proxy(base, {
          get(target, prop) {
            if (prop in target) return target[prop];
            if (prop === "then" || typeof prop === "symbol") return undefined;
            return () => undefined;
          },
        });
      }
      const app = bag({
        isReady: () => false,
        isPackaged: true,
        getAppPath: () => ${JSON.stringify(layout.appDir)},
        getPath: () => ${JSON.stringify(path.join(layout.dir, "user-data"))},
        disableHardwareAcceleration() {},
        commandLine: { appendSwitch() {} },
        setAppUserModelId() {},
        requestSingleInstanceLock: () => true,
        releaseSingleInstanceLock() {},
        whenReady: () => new Promise(() => {}),
        on() {},
        once() {},
        exit() {},
        quit() {},
        relaunch() {},
        getLoginItemSettings: () => ({ openAtLogin: false, wasOpenedAtLogin: false }),
        setLoginItemSettings() {},
      });
      const ipcMain = bag({ handle() {}, on() {}, removeHandler() {}, removeAllListeners() {} });
      const dialog = bag({ showErrorBox() {}, showMessageBox: async () => ({ response: 0 }) });
      const protocol = bag({ registerSchemesAsPrivileged() {}, handle() {} });
      const session = bag({ defaultSession: bag({ webRequest: bag({ onHeadersReceived() {} }), setPermissionRequestHandler() {} }) });
      const screen = bag({ on() {}, getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 }, bounds: {}, scaleFactor: 1 }) });
      function BrowserWindow() { return bag({ loadURL() {}, on() {}, webContents: bag({ on() {}, send() {}, setWindowOpenHandler() {} }), isDestroyed: () => false }); }
      BrowserWindow.getAllWindows = () => [];
      module.exports = bag({
        app, ipcMain, dialog, protocol, session, screen, shell: bag({}), Menu: bag({ setApplicationMenu() {}, buildFromTemplate: () => ({}) }),
        BrowserWindow, powerMonitor: bag({ on() {} }), Tray: function Tray() { return bag({ on() {}, setToolTip() {}, setContextMenu() {} }); },
        nativeImage: bag({ createFromPath: () => bag({}) }), safeStorage: bag({ isEncryptionAvailable: () => false }),
        globalShortcut: bag({ register() {}, unregisterAll() {} }), net: bag({ isOnline: () => false }),
      });
      `,
    );

    const Module = require_("module") as {
      _resolveFilename: (
        request: string,
        parent: NodeModule,
        isMain: boolean,
        options: unknown,
      ) => string;
      _nodeModulePaths: (from: string) => string[];
    };
    const original = Module._resolveFilename;
    const repoMain = path.join(ROOT, "electron", "main.cjs");
    const repoPaths = Module._nodeModulePaths(ROOT);
    setResourcesPath(layout.resourcesDir);
    const previousExit = process.exit;
    process.exit = ((code?: number) => {
      const error = new Error(`process.exit(${code}) during packaged load`);
      throw error;
    }) as typeof process.exit;
    Module._resolveFilename = function resolve(request, parent, isMain, options) {
      if (request === "electron") return stubFile;
      if (request.startsWith(".") || path.isAbsolute(request)) {
        return original.call(this, request, parent, isMain, options);
      }
      try {
        return original.call(this, request, parent, isMain, options);
      } catch (error) {
        const missing = error as NodeJS.ErrnoException;
        if (missing.code !== "MODULE_NOT_FOUND") throw error;
        const fallback = { id: repoMain, filename: repoMain, paths: repoPaths } as NodeModule;
        return original.call(this, request, fallback, isMain, options);
      }
    };
    const mainFile = path.join(layout.appDir, "electron", "main.cjs");
    try {
      require_(mainFile);
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { requireStack?: string[] };
      const chain = Array.isArray(err.requireStack) ? err.requireStack.join(" <- ") : err.stack;
      throw new Error(`${err.code || "ERR"} ${err.message}\n${chain}`, { cause: error });
    } finally {
      Module._resolveFilename = original;
      process.exit = previousExit;
      setResourcesPath(savedResourcesPath);
    }
  }, 60000);
});

describe("readiness stall", () => {
  it("fails a quiet require well under the five minute ceiling and keeps a live kernel wait", () => {
    expect(readiness.CEILING_MS).toBe(300000);
    expect(readiness.LOAD_STALL_MS).toBeLessThan(30000);
    const startedAt = 1_000;
    const quiet = readiness.stallVerdict({
      events: [{ milestone: "load:model-download", t: new Date(startedAt).toISOString() }],
      startedAt,
      now: startedAt + readiness.LOAD_STALL_MS,
    });
    expect(quiet.fail).toBe(true);
    expect(quiet.reason).toBe("stall");
    expect(quiet.milestone).toBe("load:model-download");
    const moving = readiness.stallVerdict({
      events: [{ milestone: "load:model-download", t: new Date(startedAt).toISOString() }],
      startedAt,
      now: startedAt + 1000,
    });
    expect(moving.fail).toBe(false);
    const kernel = readiness.stallVerdict({
      events: [{ milestone: "kernel-spawn", t: new Date(startedAt).toISOString() }],
      startedAt,
      now: startedAt + 30000,
    });
    expect(kernel.fail).toBe(false);
    const failed = readiness.stallVerdict({
      events: [
        {
          milestone: "load-failed:model-download",
          t: new Date(startedAt).toISOString(),
          message: "Cannot find module '../config/download-hosts.json'",
        },
      ],
      startedAt,
      now: startedAt,
    });
    expect(failed.fail).toBe(true);
    expect(failed.reason).toBe("load-failed");
  });
});
