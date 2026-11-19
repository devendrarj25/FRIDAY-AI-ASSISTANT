/**
 * Install Manager: updates are read fresh when asked, a finished update that still reads older is not offered again
 * and again, a cancelled job frees the queue, a silent job is stopped, and a new tool is one JSON entry.
 * No network, no installer and no Windows: the store is driven with injected state.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installer } from "../../src/lib/friday/installer-engine";
import { catalog } from "../../src/lib/friday/catalog";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const toolchain = require_("../../electron/toolchain.cjs") as {
  TOOLS: Array<Record<string, any>>;
  syncExtensions: (root: string) => {
    tools: string[];
    problems: Array<{ id: string | null; reason: string }>;
  };
  toolById: (id: string) => Record<string, any> | null;
  installIdleMs: (elevated: boolean, env?: Record<string, string>) => number;
  idleWatchdog: (
    ms: number,
    onIdle: () => void,
    timers: { set: (f: () => void, ms: number) => unknown; clear: (h: unknown) => void },
  ) => { poke: () => void; stop: () => void };
};
const ext = require_("../../electron/install-extensions.cjs") as {
  validate: (
    entry: unknown,
    o?: { categories?: string[]; taken?: Set<string> },
  ) => { tool?: Record<string, any>; reason?: string };
  loadExtensions: (o: {
    shippedFile: string | null;
    root: string;
    categories: string[];
    taken: Set<string>;
  }) => { tools: Array<Record<string, any>>; problems: Array<{ reason: string }>; stamp: string };
};

const store = installer as unknown as {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  updateTried: Record<string, string>;
  noteUpdateOutcome: (pkg: string) => void;
  enqueue: (pkg: string, action: string) => unknown;
  cancel: (id: string) => void;
  pumpDesktopQueue: () => void;
  desktopApi: () => unknown;
  desktopActive: boolean;
  desktopJobId: string | null;
  released: Set<string>;
};
const pkg = catalog[0]!.pkg;

afterEach(() => {
  vi.restoreAllMocks();
  store.updateTried = {};
  store.state.bridge = "simulated";
  store.state.latest = {};
  store.state.installed = {};
  store.state.jobs = [];
});

describe("an update that finished but still reads older", () => {
  const desktopWith = (installed: string, latest: string) => {
    store.state.bridge = "desktop";
    store.state.installed = { [pkg]: installed };
    store.state.latest = { [pkg]: latest };
    store.state.probed = [pkg];
  };

  it("is offered by Update all once, then left alone until a version changes", () => {
    const enqueue = vi.spyOn(store, "enqueue").mockReturnValue(null);
    desktopWith("1.0.0", "2.0.0");
    expect(installer.updateAll()).toBeGreaterThan(0);
    expect(enqueue).toHaveBeenCalledWith(pkg, "update");

    store.noteUpdateOutcome(pkg); // the update ran, the row still reads 1.0.0 against 2.0.0
    enqueue.mockClear();
    expect(installer.updateAll()).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();

    store.state.latest = { [pkg]: "2.1.0" }; // the vendor published something newer: offered again
    expect(installer.updateAll()).toBeGreaterThan(0);
  });

  it("is forgotten once the row reads current", () => {
    desktopWith("1.0.0", "2.0.0");
    store.noteUpdateOutcome(pkg);
    expect(store.updateTried[pkg]).toBeTruthy();
    store.state.installed = { [pkg]: "2.0.0" };
    store.noteUpdateOutcome(pkg);
    expect(store.updateTried[pkg]).toBeUndefined();
  });
});

describe("cancelling the running job", () => {
  it("frees the queue at once, even if the main process is slow to answer", () => {
    const pump = vi.spyOn(store, "pumpDesktopQueue").mockImplementation(() => undefined);
    vi.spyOn(store, "desktopApi").mockReturnValue({ cancelToolJob: vi.fn() });
    store.state.bridge = "desktop";
    store.state.jobs = [
      { id: "job-1", pkg, action: "update", phase: "Installing", progress: 40 },
      { id: "job-2", pkg: "other", action: "install", phase: "Queued", progress: 0 },
    ];
    store.desktopActive = true;
    store.desktopJobId = "job-1";
    store.cancel("job-1");
    expect(store.state.jobs[0].phase).toBe("Cancelled");
    expect(store.desktopActive).toBe(false);
    expect(store.released.has("job-1")).toBe(true);
    expect(pump).toHaveBeenCalledTimes(1);
  });

  it("does nothing special for a job that is only queued", () => {
    const pump = vi.spyOn(store, "pumpDesktopQueue").mockImplementation(() => undefined);
    vi.spyOn(store, "desktopApi").mockReturnValue({ cancelToolJob: vi.fn() });
    store.state.bridge = "desktop";
    store.state.jobs = [{ id: "job-9", pkg, action: "install", phase: "Queued", progress: 0 }];
    store.desktopActive = true;
    store.desktopJobId = "job-1";
    store.cancel("job-9");
    expect(store.desktopActive).toBe(true);
    expect(pump).not.toHaveBeenCalled();
    store.desktopActive = false;
  });
});

describe("a refresh reads the sources again", () => {
  it("passes the owner's refresh through to the latest-version lookup and treats an empty answer as a failure", () => {
    expect(readFileSync(path.join(root, "electron/preload.cjs"), "utf8")).toContain(
      'latestToolVersions: (force) => ipcRenderer.invoke("tools:latest", Boolean(force))',
    );
    const main = readFileSync(path.join(root, "electron/main.cjs"), "utf8");
    expect(main).toContain("toolchain.latestVersions({ force: Boolean(force) })");
    const tc = readFileSync(path.join(root, "electron/toolchain.cjs"), "utf8");
    expect(tc).toMatch(/if \(force\) \{\s*latestCache\.clear\(\);\s*wingetUpgradeCache = /);
    const engine = readFileSync(path.join(root, "src/lib/friday/installer-engine.ts"), "utf8");
    expect(engine).toContain("desktop.latestToolVersions?.(force)");
    expect(engine).toMatch(
      /Object\.keys\(latest as object\)\.length === 0[\s\S]{0,40}latestFailed = true/,
    );
  });
});

describe("a job that prints nothing", () => {
  it("is stopped after the idle limit and not before; output keeps it alive", () => {
    let fired = 0;
    let pending: { f: () => void; ms: number } | null = null;
    const timers = {
      set: (f: () => void, ms: number) => {
        pending = { f, ms };
        return pending;
      },
      clear: (h: unknown) => {
        if (pending === h) pending = null;
      },
    };
    const dog = toolchain.idleWatchdog(1000, () => (fired += 1), timers);
    expect(pending!.ms).toBe(1000);
    dog.poke();
    expect(fired).toBe(0);
    pending!.f();
    expect(fired).toBe(1);
    dog.stop();
    dog.poke();
    expect(pending).toBeNull();
  });

  it("allows longer for an elevated installer, and the owner can change the limit within bounds", () => {
    expect(toolchain.installIdleMs(false, {})).toBe(45 * 60_000);
    expect(toolchain.installIdleMs(true, {})).toBe(90 * 60_000);
    expect(toolchain.installIdleMs(false, { FRIDAY_INSTALL_IDLE_MINUTES: "10" })).toBe(10 * 60_000);
    expect(toolchain.installIdleMs(false, { FRIDAY_INSTALL_IDLE_MINUTES: "1" })).toBe(45 * 60_000);
    expect(toolchain.installIdleMs(false, { FRIDAY_INSTALL_IDLE_MINUTES: "9999" })).toBe(
      45 * 60_000,
    );
  });

  it("watches the real install attempt", () => {
    const tc = readFileSync(path.join(root, "electron/toolchain.cjs"), "utf8");
    expect(tc).toContain("const dog = idleWatchdog(idleMs");
    expect(tc.match(/dog\.stop\(\)/g)?.length).toBe(2);
    expect(tc).toContain("dog.poke();");
  });
});

describe("a new tool is one JSON entry", () => {
  const categories = ["Developer Tools", "Media Tools"];
  const good = {
    id: "Hugo",
    category: "Media Tools",
    cmd: "hugo",
    args: ["version"],
    winget: "Hugo.Hugo.Extended",
    url: "https://gohugo.io/",
    latest: { kind: "github", ref: "gohugoio/hugo" },
  };
  const folders: string[] = [];
  const folder = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "friday-ext-"));
    folders.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
    toolchain.syncExtensions("");
  });

  it("accepts a complete entry and never makes it required", () => {
    const result = ext.validate({ ...good, required: true } as never, { categories });
    expect(result.reason).toMatch(/not allowed: required/);
    const ok = ext.validate(good, { categories });
    expect(ok.tool).toMatchObject({
      id: "Hugo",
      category: "Media Tools",
      winget: "Hugo.Hugo.Extended",
      required: false,
    });
    expect(ok.tool!["source"]).toBe("gohugo.io");
  });

  it("derives the version lookup from an npm or pip package when none is written", () => {
    expect(
      ext.validate({
        id: "Prettier",
        cmd: "prettier",
        npm: "prettier",
        url: "https://prettier.io/",
      }).tool!["latest"],
    ).toEqual({ kind: "npm", ref: "prettier" });
    expect(
      ext.validate({ id: "Rich", pip: "rich", url: "https://rich.readthedocs.io/" }).tool![
        "latest"
      ],
    ).toEqual({ kind: "pypi", ref: "rich" });
  });

  it.each([
    [{ ...good, startAfter: ["cmd", ["/c", "calc"]] }, /not allowed: startAfter/],
    [{ ...good, installerUrl: "https://x.com/a.exe" }, /not allowed: installerUrl/],
    [{ ...good, elevate: true }, /not allowed: elevate/],
    [{ ...good, url: "http://gohugo.io/" }, /https/],
    [{ ...good, cmd: "..\\evil" }, /cmd is not valid/],
    [{ ...good, cmd: "a b" }, /cmd is not valid/],
    [{ ...good, args: ["--x; calc"] }, /args/],
    [{ ...good, args: ["a", "b", "c", "d", "e"] }, /args/],
    [{ ...good, winget: "not a winget id" }, /winget is not valid/],
    [{ ...good, latest: { kind: "url", ref: "https://x" } }, /latest/],
    [{ id: "x" }, /id must be/],
    [{ ...good, winget: undefined, cmd: "hugo" }, /needs winget, npm, pip or a manual note/],
    ["not an object", /not an object/],
  ])("skips a bad entry with its reason", (entry, reason) => {
    expect(ext.validate(entry as never, { categories }).reason).toMatch(reason as RegExp);
  });

  it("falls back to Developer Tools for an unknown category and refuses a taken id", () => {
    expect(ext.validate({ ...good, category: "Whatever" }, { categories }).tool!["category"]).toBe(
      "Developer Tools",
    );
    expect(ext.validate(good, { categories, taken: new Set(["hugo"]) }).reason).toMatch(
      /already used/,
    );
  });

  it("reads the shipped file then the owner's file; the first id wins; a bad file costs only itself", () => {
    const dir = folder();
    const shipped = path.join(dir, "install-extensions.json");
    writeFileSync(shipped, JSON.stringify({ tools: [good] }));
    mkdirSync(path.join(dir, "config"));
    writeFileSync(
      path.join(dir, "config", "install-extensions.user.json"),
      JSON.stringify({
        tools: [
          { ...good, winget: "Other.Hugo" },
          { id: "Mine", cmd: "mine", winget: "A.Mine", url: "https://example.com/" },
        ],
      }),
    );
    const loaded = ext.loadExtensions({
      shippedFile: shipped,
      root: dir,
      categories,
      taken: new Set(),
    });
    expect(loaded.tools.map((t) => t["id"])).toEqual(["Hugo", "Mine"]);
    expect(loaded.tools[0]!["winget"]).toBe("Hugo.Hugo.Extended");
    expect(loaded.problems.map((p) => p.reason)).toEqual(["id already used"]);

    writeFileSync(path.join(dir, "config", "install-extensions.user.json"), "{ not json");
    const broken = ext.loadExtensions({
      shippedFile: shipped,
      root: dir,
      categories,
      taken: new Set(),
    });
    expect(broken.tools.map((t) => t["id"])).toEqual(["Hugo"]);
    expect(broken.problems[0]!.reason).toMatch(/not valid JSON/);
  });

  it("joins the real catalog on the next scan, leaves the built-in tools alone, and leaves again when removed", () => {
    const builtIn = toolchain.TOOLS.length;
    const dir = folder();
    mkdirSync(path.join(dir, "config"));
    const file = path.join(dir, "config", "install-extensions.user.json");
    writeFileSync(file, JSON.stringify({ tools: [good, { ...good, id: "Node.js LTS" }] }));
    const report = toolchain.syncExtensions(dir);
    expect(report.tools).toEqual(["Hugo"]);
    expect(report.problems.some((p) => /already used/.test(p.reason))).toBe(true);
    expect(toolchain.toolById("Hugo")).toMatchObject({
      winget: "Hugo.Hugo.Extended",
      required: false,
    });
    expect(toolchain.TOOLS.length).toBe(builtIn + 1);
    expect(toolchain.toolById("Node.js LTS")!["winget"]).toBe("OpenJS.NodeJS.LTS");

    writeFileSync(file, JSON.stringify({ tools: [] }));
    toolchain.syncExtensions(dir);
    expect(toolchain.toolById("Hugo")).toBeNull();
    expect(toolchain.TOOLS.length).toBe(builtIn);
  });

  it("ships an empty list the owner can fill, and keeps the owner's file out of git and the installer", () => {
    const shipped = JSON.parse(
      readFileSync(path.join(root, "config/install-extensions.json"), "utf8"),
    );
    expect(shipped.tools).toEqual([]);
    expect(readFileSync(path.join(root, ".gitignore"), "utf8")).toContain(
      "/config/install-extensions.user.json",
    );
    expect(readFileSync(path.join(root, "electron-builder.yml"), "utf8")).toContain(
      '"!install-extensions.user.json"',
    );
  });
});
