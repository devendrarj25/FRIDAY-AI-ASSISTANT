/**
 * The owner's rule for every outside tool FRIDAY downloads: several official sources, a latest-version check, reuse
 * when already latest, an install home and an index entry. This file measures the real catalogue (electron/toolchain.cjs
 * rows, the chains of electron/installer-catalog.cjs and electron/vendor-sources.cjs, the index of
 * electron/install-inventory.cjs and electron/managed-path.cjs) and pins what is true today.
 *
 * What is not true yet is named in KNOWN_GAPS with a reason. Both directions are enforced: a row that breaks the
 * rule and is not listed fails (no new gap), and a listed entry that no longer breaks the rule fails too (the list
 * can only shrink: delete the entry when the fix lands). No network, no clock.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const toolchain = require_(path.join(root, "electron/toolchain.cjs"));
const catalog = require_(path.join(root, "electron/installer-catalog.cjs"));
const vendor = require_(path.join(root, "electron/vendor-sources.cjs"));
const inventory = require_(path.join(root, "electron/install-inventory.cjs"));
const managedPath = require_(path.join(root, "electron/managed-path.cjs"));
const managedInstall = require_(path.join(root, "electron/managed-install.cjs"));
const engines = require_(path.join(root, "electron/engine-install.cjs"));

type Tool = Record<string, unknown> & { id: string };
type Source = { kind: string };

/* ----------------------------------------------------------------- known gaps */

/**
 * Every true gap, by kind, with the reason it exists today. The ids are catalogue row ids. A fix removes its entry.
 * `ids` entries are compared as sets against what the catalogue measures now.
 */
const KNOWN_GAPS = {
  /** Fewer than two sources in the row's chain (chainOfTool). Vendor-feed-only rows and rows with no chain at all. */
  singleSource: {
    reason:
      "the chain holds one vendor feed (or nothing): no second official source is wired in electron/vendor-sources.cjs yet",
    ids: [
      ".NET SDK",
      "7-Zip",
      "AWS CLI",
      "Android Platform Tools (adb)",
      "Android Studio",
      "CUDA Toolkit",
      "D2",
      "Docker Desktop",
      "FFmpeg",
      "FRIDAY GitHub CLI",
      "FRIDAY Node",
      "FRIDAY Python",
      "FRIDAY Python embed",
      "FRIDAY pip bootstrap",
      "Git",
      "Go",
      "Gradle",
      "Graphviz",
      "ImageMagick",
      "LLVM / Clang",
      "LM Studio",
      "Lua",
      "MSYS2",
      "Maven",
      "MariaDB",
      "MinGit",
      "MongoDB",
      "MySQL",
      "NSIS",
      "Node.js LTS",
      "OpenJDK (Temurin)",
      "PHP",
      "Pandoc",
      "Perl",
      "PostgreSQL",
      "Python",
      "QEMU",
      "Redis (Memurai)",
      "Ruby",
      "Rust",
      "SQLite",
      "Temurin JDK zip",
      "Tesseract OCR",
      "VC++ Redistributable",
      "VS Build Tools",
      "Visual Studio",
      "Visual Studio Code",
      "WebView2 Runtime",
      "Windows SDK",
      "Windows Terminal",
      "aria2",
      "ggml-base",
      "ggml-tiny",
      "w64devkit",
      "whisper.cpp",
    ],
  },
  /** No live (non-pinned) source at all: the row has an installer or a pin but nothing that reads the newest version. */
  noLatestCheck: {
    reason:
      "no vendor feed or registry source reads the newest version; only the installer or a pinned file is known",
    ids: [
      ".NET SDK",
      "AWS CLI",
      "Android Platform Tools (adb)",
      "Android Studio",
      "D2",
      "FFmpeg",
      "FRIDAY Python",
      "FRIDAY Python embed",
      "FRIDAY pip bootstrap",
      "Gradle",
      "ImageMagick",
      "LM Studio",
      "Lua",
      "MSYS2",
      "Maven",
      "MariaDB",
      "MongoDB",
      "MySQL",
      "NSIS",
      "PHP",
      "Perl",
      "PostgreSQL",
      "Python",
      "QEMU",
      "Redis (Memurai)",
      "Ruby",
      "SQLite",
      "VC++ Redistributable",
      "VS Build Tools",
      "Visual Studio",
      "WebView2 Runtime",
      "Windows SDK",
      "Windows Terminal",
      "ggml-base",
      "ggml-tiny",
      "w64devkit",
      "whisper.cpp",
    ],
  },
  /** The index files a row under the guessed home (vendor manager, no path yet) although its install route differs. */
  homeGuess: {
    reason:
      "install-inventory.homeOf files a vendor row with no path under friday-runtime, but the real route is a machine install or another tool",
    ids: ["Docker Compose", "Hugging Face runner", "Playwright browsers", "WSL 2", "dotnet-script"],
  },
  /** No catalogue row carries its own `home` field; the home is derived from the install route. */
  declaredHome: {
    reason:
      "rows declare no `home` (friday-root | machine | npm-global); it is derived from winget, npm, pip or the archive route",
    ids: ["(all rows)"],
  },
  /** Rows the owner wants notify-only (bundled in the EXE) that Full autonomy can still swap at run time. */
  notifyOnly: {
    reason:
      "planUpdate has no notify-only flag: Full autonomy may run installer:update on a bundled runtime (docs: D13)",
    ids: ["Electron", "FRIDAY Node"],
  },
  /** `releases/latest` strings outside vendor-sources.cjs that bypass the source chain (counts per file). */
  rawLatestUrl: {
    reason:
      "scripts/setup-windows.ps1 (PowerShell, locked CMD chain) reads FRIDAY's own repos with a direct releases/latest call; the four JS sites were routed through resolveLatest and left this list",
    files: {
      // The locked setup script (PowerShell, no access to the JS chain) reads FRIDAY's own two repos. Owner's call.
      "scripts/setup-windows.ps1": 1,
    } as Record<string, number>,
  },
};

/** Rows that download nothing the chain can version, with the named reason. Not a gap. */
const NOT_A_CHAIN_ROW: Record<string, string> = {
  "WSL 2": "a Windows optional feature installed by DISM; Windows is its only source",
  "Docker Compose": "ships inside Docker Desktop (installVia), versioned and updated with it",
};

/* ----------------------------------------------------------------- the catalogue */

const TOOLS = (toolchain.TOOLS as Tool[]).filter((t) => !t["aliasOf"]);

/** A row downloads or installs something from outside when it names one of these routes. */
const downloads = (t: Tool) =>
  Boolean(
    t["winget"] ||
    t["npm"] ||
    t["pip"] ||
    t["pipDist"] ||
    t["installerUrl"] ||
    t["engine"] ||
    t["pipBundle"] ||
    t["dotnetTool"] ||
    t["pharFile"] ||
    t["installVia"] ||
    t["customCommand"],
  );
const ROWS = TOOLS.filter(downloads);
const sourcesOf = (t: Tool): Source[] => catalog.chainOfTool(t)?.sources ?? [];
const sortedIds = (rows: Tool[]) => rows.map((t) => t.id).sort();

/** The package manager a probe reports for a row (electron/toolchain.cjs probeTool). */
const managerOf = (t: Tool) =>
  t["winget"] ? "winget" : t["npm"] ? "npm" : t["pip"] || t["pipDist"] ? "pip" : "vendor";

/** The install home the row's own route implies. */
function routeHome(t: Tool): string {
  if (t["winget"]) return "machine";
  if (t["npm"]) return "npm-global";
  if (t["pip"] || t["pipDist"] || t["pipBundle"]) return "friday-python-env";
  if (t["installerUrl"] || t["engine"]) return "friday-runtime";
  if (t["installVia"]) return routeHome(toolchain.toolById(t["installVia"] as string) as Tool);
  return "machine"; // customCommand, optional Windows feature: Windows' own folders
}

const unlisted = (found: string[], known: string[], allowed: Set<string> = new Set()) => ({
  fresh: found.filter((id) => !known.includes(id) && !allowed.has(id)),
  stale: known.filter((id) => !found.includes(id)),
});

describe("source chain coverage: the catalogue", () => {
  it("measures a real catalogue (a vacuous scan would pass everything)", () => {
    expect(ROWS.length).toBeGreaterThan(150);
    expect(ROWS.some((t) => t["winget"])).toBe(true);
    expect(ROWS.some((t) => t["npm"])).toBe(true);
    expect(ROWS.some((t) => t["installerUrl"])).toBe(true);
    expect(ROWS.some((t) => t["engine"])).toBe(true);
    for (const id of Object.keys(NOT_A_CHAIN_ROW)) expect(ROWS.map((t) => t.id)).toContain(id);
  });

  it("every downloading row has two or more official sources, or is a listed gap", () => {
    const found = sortedIds(ROWS.filter((t) => sourcesOf(t).length < 2));
    const { fresh, stale } = unlisted(
      found,
      KNOWN_GAPS.singleSource.ids,
      new Set(Object.keys(NOT_A_CHAIN_ROW)),
    );
    expect(fresh, "a row has fewer than two sources and is not in KNOWN_GAPS.singleSource").toEqual(
      [],
    );
    expect(stale, "fixed: delete these from KNOWN_GAPS.singleSource").toEqual([]);
  });

  it("every downloading row has a live latest-version check, or is a listed gap", () => {
    const live = (t: Tool) => sourcesOf(t).some((s) => s.kind !== "pinned");
    const found = sortedIds(ROWS.filter((t) => !live(t)));
    const { fresh, stale } = unlisted(
      found,
      KNOWN_GAPS.noLatestCheck.ids,
      new Set(Object.keys(NOT_A_CHAIN_ROW)),
    );
    expect(
      fresh,
      "a row has no live version source and is not in KNOWN_GAPS.noLatestCheck",
    ).toEqual([]);
    expect(stale, "fixed: delete these from KNOWN_GAPS.noLatestCheck").toEqual([]);
  });

  it("every chain answers through the one source table, never an unknown reader", () => {
    const known = new Set(Object.keys(vendor.SOURCE_READERS || {}));
    const kinds = new Set(ROWS.flatMap((t) => sourcesOf(t).map((s) => s.kind)));
    // the table is internal to vendor-sources.cjs: the kinds in use are the contract, each one named and non-empty
    expect(kinds.size).toBeGreaterThanOrEqual(6);
    for (const kind of kinds) {
      expect(kind).toMatch(/^[a-z][a-z-]*$/);
      if (known.size) expect(known.has(kind), `unknown source kind ${kind}`).toBe(true);
    }
    // an engine row's chain is the engine's own list, ending in its pin when it has one
    const llama = sourcesOf(ROWS.find((t) => t["engine"] === "llama.cpp") as Tool).map(
      (s) => s.kind,
    );
    expect(llama[0]).toBe("github-list");
    expect(llama.at(-1)).toBe("pinned");
  });
});

describe("source chain coverage: install home and index entry", () => {
  it("every downloading row has a derivable home that the inventory knows", () => {
    for (const t of ROWS) {
      expect(Object.keys(inventory.HOMES), t.id).toContain(routeHome(t));
      expect(Object.keys(inventory.HOMES), t.id).toContain(
        inventory.homeOf({ manager: managerOf(t) }),
      );
    }
  });

  it("a home the row declares must be valid, and until one does the gap stays listed", () => {
    const declared = ROWS.filter((t) => t["home"] !== undefined);
    for (const t of declared) {
      expect(
        ["friday-root", "machine", "npm-global", ...Object.keys(inventory.HOMES)],
        t.id,
      ).toContain(t["home"]);
    }
    if (declared.length === ROWS.length) {
      throw new Error("every row declares a home: delete KNOWN_GAPS.declaredHome");
    }
    expect(KNOWN_GAPS.declaredHome.ids).toEqual(["(all rows)"]);
    expect(declared.length, "partial declaration: list the rest or finish it").toBe(0);
  });

  it("the inventory indexes every downloading row under a home in or out of the root", () => {
    const tools = ROWS.map((t) => ({
      id: t.id,
      installed: true,
      manager: managerOf(t),
      version: "1.0.0",
    }));
    const built = inventory.buildInventory("/friday-root", { tools });
    const byId = new Map<string, { home: string; removedByDeleteAllData: boolean }>(
      built.items.map((i: { id: string; home: string; removedByDeleteAllData: boolean }) => [
        i.id,
        i,
      ]),
    );
    for (const t of ROWS) {
      const item = byId.get(t.id);
      expect(item, `${t.id} is missing from the inventory`).toBeTruthy();
      expect(item!.removedByDeleteAllData).toBe(inventory.HOMES[item!.home].inRoot);
    }
    // a machine install is recorded but never removed by "delete all FRIDAY data"
    const git = byId.get("Git");
    expect(git).toMatchObject({ home: "machine", removedByDeleteAllData: false });
  });

  it("the home the inventory guesses matches the install route, except the listed gaps", () => {
    const wrong = sortedIds(
      ROWS.filter((t) => inventory.homeOf({ manager: managerOf(t) }) !== routeHome(t)),
    );
    const { fresh, stale } = unlisted(wrong, KNOWN_GAPS.homeGuess.ids);
    expect(fresh, "a new row is filed under the wrong home").toEqual([]);
    expect(stale, "fixed: delete these from KNOWN_GAPS.homeGuess").toEqual([]);
  });

  it("an archive tool FRIDAY unpacks lands in its own runtime folder and on the managed PATH", () => {
    const dir = "/friday-root";
    const archive = ROWS.filter((t) => t["archiveBin"] && !t["storeOnly"]);
    expect(archive.length).toBeGreaterThan(5);
    const dirs: string[] = managedPath.managedBinDirs(dir, archive, () => true);
    for (const t of archive) {
      const bin = path.join(
        dir,
        "runtime",
        managedInstall.toolDir(t.id),
        ...String(t["archiveBin"]).split("/"),
      );
      expect(dirs, t.id).toContain(path.dirname(bin));
      expect(inventory.homeOf({ manager: "vendor", path: bin }, dir)).toBe("friday-runtime");
    }
  });
});

describe("source chain coverage: no bypass of the source chain", () => {
  const SKIP_DIRS = new Set(["node_modules", ".git"]);
  const ALLOWED = new Set(["electron/vendor-sources.cjs", "electron/connectors.cjs"]);
  const TEXT = /\.(cjs|js|mjs|ts|tsx|json|ps1|cmd|py|md)$/i;

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full, out);
      else if (TEXT.test(name) && stat.size < 5_000_000) out.push(full);
    }
    return out;
  }

  it("`releases/latest` is read only by the chain, the connectors tool, and the listed bypasses", () => {
    const found: Record<string, number> = {};
    for (const top of ["electron", "scripts"]) {
      for (const file of walk(path.join(root, top))) {
        const rel = path.relative(root, file).split(path.sep).join("/");
        if (ALLOWED.has(rel)) continue;
        const count = readFileSync(file, "utf8").split("releases/latest").length - 1;
        if (count) found[rel] = count;
      }
    }
    expect(found).toEqual(KNOWN_GAPS.rawLatestUrl.files);
  });

  it("the chain file itself and the allowlisted tool still own a releases/latest call", () => {
    expect(readFileSync(path.join(root, "electron/vendor-sources.cjs"), "utf8")).toContain(
      "releases/latest",
    );
    // connectors.cjs reads a user's own repo for the Connectors page: a user tool, not an install source
    expect(readFileSync(path.join(root, "electron/connectors.cjs"), "utf8")).toContain(
      "releases/latest",
    );
  });
});

describe("source chain coverage: reuse when latest (D3)", () => {
  const dials = ["ask", "balanced", "full"];

  it("installed at or above the latest means current, so no dial allows an update", () => {
    const cases = [
      { installedVersion: "2.5.0", latest: { ok: true, version: "2.5.0" } },
      { installedVersion: "2.6.1", latest: { ok: true, version: "2.5.0" } },
      { installedVersion: "v2.5.0", latest: { ok: true, version: "2.5" } },
    ];
    let installerCalls = 0;
    const fakeInstaller = () => (installerCalls += 1);
    for (const c of cases) {
      const updateStatus = catalog.updateStatusOf({ installed: true, ...c });
      expect(updateStatus).toBe("current");
      for (const autonomy of dials) {
        const plan = catalog.planUpdate({
          row: { id: "x", updateStatus },
          autonomy,
          consent: { granted: true },
        });
        expect(plan.allowed).toBe(false);
        if (plan.allowed) fakeInstaller();
      }
    }
    expect(installerCalls).toBe(0);
  });

  it("a newer latest is an update, and Balanced and Ask still need the owner's consent", () => {
    const status = catalog.updateStatusOf({
      installed: true,
      installedVersion: "1.0.0",
      latest: { ok: true, version: "1.1.0" },
    });
    expect(status).toBe("update");
    const row = { id: "x", updateStatus: status, fit: { state: "supported" } };
    expect(catalog.planUpdate({ row, autonomy: "ask" })).toMatchObject({
      allowed: false,
      needsConsent: true,
    });
    expect(catalog.planUpdate({ row, autonomy: "balanced" })).toMatchObject({
      allowed: false,
      needsConsent: true,
    });
    expect(catalog.planUpdate({ row, autonomy: "full" })).toMatchObject({ allowed: true });
    // a machine-home installer (winget) is a real row of this kind: the consent rule applies to it too
    expect(ROWS.find((t) => t.id === "Git")?.["winget"]).toBeTruthy();
  });

  it("a pinned answer cannot call a tool current, so it never skips a check it cannot make", () => {
    const status = catalog.updateStatusOf({
      installed: true,
      installedVersion: "1.0.0",
      latest: { ok: true, version: "1.0.0", pinned: true },
    });
    expect(status).toBe("unknown");
  });

  describe("an engine that is latest and healthy is never downloaded again", () => {
    let dir = "";
    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "friday-chain-coverage-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const FACTS = {
      ramGb: 16,
      gpus: [],
      gpuVendor: null,
      vramFreeGb: null,
      cudaReady: false,
      vulkan: false,
      cpu: { avx2: true, avx512: false },
      cuda: { driverCuda: null },
    };
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const CASES = [
      {
        id: "llama.cpp",
        tag: "b12774",
        asset: "llama-b12774-bin-win-cpu-x64.zip",
        version: "12774",
      },
      {
        id: "stable-diffusion.cpp",
        tag: "master-504-abc",
        asset: "sd-master-abc-bin-win-avx2-x64.zip",
        version: "master-504-abc",
      },
      {
        id: "FFmpeg (LGPL, portable)",
        tag: "latest",
        asset: "ffmpeg-n7.1-latest-win64-lgpl-shared-7.1.zip",
        version: "7.1",
      },
    ];

    for (const c of CASES) {
      it(`${c.id}: the second install of the same release downloads nothing`, async () => {
        const spec = engines.ENGINES[c.id];
        const downloaded: string[] = [];
        const deps = {
          download: async (url: string, dest: string) => {
            downloaded.push(url);
            mkdirSync(path.dirname(dest), { recursive: true });
            writeFileSync(dest, path.basename(dest));
          },
          extract: async (_zip: string, to: string) => {
            mkdirSync(to, { recursive: true });
            writeFileSync(path.join(to, spec.binNames[0]), "bin");
            return { ok: true };
          },
          health: async () => ({ ok: true }),
          diskFree: () => 50 * 1024 ** 3,
          now: () => 1_800_000_000_000,
        };
        const release = {
          ok: true,
          version: c.version,
          tag: c.tag,
          source: "github-api",
          assets: [{ name: c.asset, url: `https://x/${c.asset}`, bytes: 10, sha256: sha(c.asset) }],
        };
        const first = await engines.installEngine(dir, spec, { release, facts: FACTS }, deps);
        expect(first, JSON.stringify(first.attempts)).toMatchObject({ ok: true });
        const after = downloaded.length;
        expect(after).toBeGreaterThan(0);
        const again = await engines.installEngine(dir, spec, { release, facts: FACTS }, deps);
        expect(again).toMatchObject({ ok: true, reused: true });
        expect(downloaded.length).toBe(after);
      });
    }
  });
});

describe("source chain coverage: bundled runtimes are notify-only (D13)", () => {
  it("a bundled pack is a pinned row the installer cannot swap", () => {
    const packs = (
      require_(path.join(root, "config/toolchain-manifest.json")).packs as {
        id: string;
        tier: string;
        version: string;
      }[]
    ).filter((p) => p.tier === "bundled");
    const node = packs.find((p) => p.id === "node-win");
    expect(node).toBeTruthy();
    const rows = catalog.packRows(packs, TOOLS, { tools: [] });
    for (const row of rows) {
      expect(
        row.chain.sources.map((s: Source) => s.kind),
        row.id,
      ).toEqual(["pinned"]);
      // the row id is not a toolchain tool, so installer:update answers "updates through its own installer"
      expect(toolchain.toolById(row.id), row.id).toBeFalsy();
    }
  });

  it("which runtime rows Full autonomy could still swap is exactly the listed gap", () => {
    const swappable = ["Electron", "FRIDAY Node"].filter((id) => {
      const tool = toolchain.toolById(id) as Tool;
      const row = catalog.toolRows([tool], { tools: [] })[0];
      const plan = catalog.planUpdate({
        row: { ...row, updateStatus: "update", fit: { state: "supported" } },
        autonomy: "full",
      });
      return plan.allowed === true;
    });
    const { fresh, stale } = unlisted(swappable.sort(), KNOWN_GAPS.notifyOnly.ids);
    expect(fresh).toEqual([]);
    expect(stale, "fixed: delete these from KNOWN_GAPS.notifyOnly").toEqual([]);
  });

  it("every KNOWN_GAPS entry carries a reason, so the list explains itself", () => {
    for (const [name, gap] of Object.entries(KNOWN_GAPS)) {
      expect(gap.reason.length, name).toBeGreaterThan(20);
    }
  });
});
