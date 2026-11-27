/**
 * One build, three callers. The CMD pack, FRIDAY Release and FRIDAY Test Build
 * run scripts/build-pipeline.cjs; PR Validation's package-windows job runs a
 * subset of the same commands. A green PR only means something for the phases it
 * actually runs, so every phase of the shared pipeline is listed here with how
 * PR Validation covers it, or why it does not yet. Adding a phase (or covering
 * one) fails this test until the table says so, so the gap can never grow quietly.
 * The workflow files are only read here.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { phasesRunByPr, pipeline } from "./helpers/pr-validation";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const pr = read(".github/workflows/pr-validation.yml");
const packageJob = pr.slice(pr.indexOf("\n  package-windows:\n"), pr.indexOf("\n  validate:\n"));

describe("PR Validation runs every phase of the shared build", () => {
  it("calls the shared pipeline with the production channel, exactly as FRIDAY Release does", () => {
    expect(packageJob).toContain(
      "node scripts/build-pipeline.cjs --channel production --caller pr-validation --through verify-versions",
    );
    expect(packageJob).toContain(
      "node scripts/build-pipeline.cjs --channel production --caller pr-validation --from stage-toolchain",
    );
    const release = read(".github/workflows/release.yml");
    expect(release).toContain(
      "node scripts/build-pipeline.cjs --channel production --caller release --through verify-versions",
    );
    expect(release).toContain(
      "node scripts/build-pipeline.cjs --channel production --caller release --from stage-toolchain",
    );
  });

  it("covers every phase of the pipeline: no gap between a green PR and a release build", () => {
    expect(phasesRunByPr()).toEqual(pipeline.PHASES);
  });

  it("builds both deliverables, unsigned and unpublished", () => {
    const parsed = pipeline.parseArgs([
      "node",
      "build-pipeline.cjs",
      "--channel",
      "production",
      "--caller",
      "pr-validation",
    ]);
    expect(parsed.targets).toEqual(["nsis", "portable"]);
    expect(packageJob).not.toContain("--publish");
    expect(packageJob).not.toContain("CSC_");
    expect(packageJob).not.toContain("WINDOWS_SIGNING");
  });

  it("keeps the old separate Windows steps out, so there is one way to build", () => {
    for (const old of [
      "node scripts/electron-pack.cjs",
      "node scripts/verify-build.cjs",
      "-File scripts/windows-installer-smoke.ps1",
      "run: npm run build:desktop",
    ]) {
      expect(packageJob, old).not.toContain(old);
    }
  });
});

describe("the update path is proven by every caller", () => {
  it("runs from verify-build, which PR Validation, FRIDAY Release and the CMD pack all run", () => {
    expect(read("scripts/verify-build.cjs")).toContain("verify-update-path.cjs");
    expect(pipeline.PHASE_COMMANDS["verify-artifacts"]).toContain("scripts/verify-build.cjs");
    expect(phasesRunByPr()).toContain("verify-artifacts");
    const release = read(".github/workflows/release.yml");
    expect(release).toContain("scripts/build-pipeline.cjs --channel production --caller release");
  });

  it("checks that every electron module is inside the package, from verify-build as well as its own phase", () => {
    const verify = read("scripts/verify-build.cjs");
    expect(verify).toContain("packaged-requires.cjs");
    expect(verify).toContain('"--asar", asar');
    expect(pipeline.PHASE_COMMANDS["packaged-requires"]).toContain("scripts/packaged-requires.cjs");
  });

  it("is exercised by the installer smoke too: install, boot, reinstall, silent update, uninstall", () => {
    const smoke = read("scripts/windows-installer-smoke.ps1");
    for (const step of ["Run-Setup", "Verify-Boot", '"--updated", "--force-run"', "/DELETEDATA"]) {
      expect(smoke).toContain(step);
    }
    expect(phasesRunByPr()).toContain("installer-smoke");
  });
});

describe("the CMD pack is the same build as Release", () => {
  it("is a thin wrapper over the shared pipeline with the production channel", () => {
    const cmd = read("scripts/build-windows.cmd");
    expect(cmd).toContain('scripts\\build-pipeline.cjs" --channel production --caller cmd');
    expect(cmd).not.toContain("electron-pack.cjs");
    expect(cmd).not.toContain("release-manifest.cjs");
  });

  it("builds the same two deliverables and the same manifest as Release", () => {
    const parsed = (
      require_(path.join(ROOT, "scripts/build-pipeline.cjs")) as {
        parseArgs: (argv: string[]) => { targets: string[]; channel: string };
      }
    ).parseArgs(["node", "build-pipeline.cjs", "--channel", "production", "--caller", "cmd"]);
    expect(parsed.targets).toEqual(["nsis", "portable"]);
    expect(pipeline.PHASE_COMMANDS["manifest"]).toEqual(["scripts/release-manifest.cjs"]);
    // Release attaches exactly what the pipeline produces: the installer's block map included.
    const release = read(".github/workflows/release.yml");
    expect(release).toContain('exe.blockmap" \\');
  });
});

describe("builtins.json and the wheelhouse ride the one shared build", () => {
  type Api = {
    PHASES: string[];
    PHASE_COMMANDS: Record<string, string[]>;
    parseArgs: (argv: string[]) => { from: string; through: string; targets: string[] };
    selectedPhases: (options: { from: string; through: string }) => string[];
    installerBounds: (manifest: unknown) => { ceiling: number; floor: number };
    assertPackagedLayout: (input: {
      releaseDir: string;
      manifest: unknown;
      targets: string[];
      env?: Record<string, string | undefined>;
      wheels?: unknown[];
    }) => { ok: boolean };
    writeBuiltins: (input: { root: string; outFile?: string; version?: string }) => {
      schema: number;
      release: string;
      trees: Record<string, unknown[]>;
    };
    assertBuiltins: (resourcesDir: string) => { ok: boolean };
  };
  const api = require_(path.join(ROOT, "scripts/build-pipeline.cjs")) as Api;
  const stripComments = (text: string) =>
    text
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
  const workflowFiles = fs
    .readdirSync(path.join(ROOT, ".github/workflows"))
    .filter((name) => name.endsWith(".yml"));

  it("is invoked by Release, Test Build, PR Validation and the CMD wrapper, and by nothing else", () => {
    const callers = workflowFiles.filter((name) =>
      stripComments(read(`.github/workflows/${name}`)).includes("scripts/build-pipeline.cjs"),
    );
    expect(callers.sort()).toEqual(["pr-validation.yml", "release.yml", "test-build.yml"]);
    expect(stripComments(read("scripts/build-windows.cmd"))).toContain("build-pipeline.cjs");
  });

  it("is never bypassed: no workflow and not the CMD wrapper calls electron-builder or the pack wrapper", () => {
    const texts = [
      ...workflowFiles.map((name) => [name, read(`.github/workflows/${name}`)] as const),
      ["build-windows.cmd", read("scripts/build-windows.cmd")] as const,
    ];
    for (const [name, text] of texts) {
      const live = text
        .split("\n")
        .filter((line) => !/^\s*(#|REM\b)/i.test(line))
        .join("\n");
      expect(live, name).not.toMatch(/electron-builder|electron-pack\.cjs/);
    }
  });

  it("gives every build invocation the package phase, where builtins.json is written", () => {
    const invocations: string[] = [];
    for (const name of ["release.yml", "test-build.yml", "pr-validation.yml"]) {
      for (const match of stripComments(read(`.github/workflows/${name}`)).matchAll(
        /build-pipeline\.cjs([^\n]*--from stage-toolchain[^\n]*)/g,
      ))
        invocations.push(match[1] ?? "");
    }
    invocations.push(" --channel production --caller cmd");
    expect(invocations.length).toBeGreaterThanOrEqual(5);
    for (const line of invocations) {
      const tokens = line
        .replace(/"[^"]*"/g, "x")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const options = api.parseArgs(["node", "build-pipeline.cjs", ...tokens]);
      expect(api.selectedPhases(options), line).toContain("package");
    }
    const commands = api.PHASE_COMMANDS["package"] ?? [];
    expect(commands.indexOf("scripts/builtins-manifest.cjs")).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf("scripts/builtins-manifest.cjs")).toBeLessThan(
      commands.indexOf("scripts/electron-pack.cjs"),
    );
    expect(api.PHASE_COMMANDS["verify-artifacts"]).toContain("scripts/builtins-manifest.cjs");
    const source = read("scripts/build-pipeline.cjs");
    const packBranch = source.slice(
      source.indexOf('if (phase === "package")'),
      source.indexOf('if (phase === "packaged-requires")'),
    );
    expect(packBranch).toContain("writeBuiltins(");
    expect(packBranch.indexOf("writeBuiltins(")).toBeLessThan(
      packBranch.indexOf('runNode("scripts/electron-pack.cjs"'),
    );
    const verifyBranch = source.slice(
      source.indexOf('if (phase === "verify-artifacts")'),
      source.indexOf('if (phase === "verify-boot")'),
    );
    expect(verifyBranch).toContain("assertBuiltins(");
  });

  it("publishes exactly the assets the release manifest writes, plus the changelog", () => {
    const release = read(".github/workflows/release.yml");
    const loop = /for asset in \\\n([\s\S]*?); do/.exec(release)?.[1] ?? "";
    const listed = [...loop.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(listed.length).toBeGreaterThan(4);
    expect(listed).toContain("CHANGELOG.md");
    const uploaded = listed
      .filter((entry) => entry !== "CHANGELOG.md")
      .map((entry) =>
        path.posix.basename(entry.replace("${{ steps.plan.outputs.version }}", "9.9.9.9")),
      )
      .sort();
    const dir = fs.mkdtempSync(path.join(require_("node:os").tmpdir(), "friday-parity-"));
    try {
      for (const name of [
        "FRIDAY-Setup-9.9.9.9.exe",
        "FRIDAY-Portable-9.9.9.9.exe",
        "FRIDAY-Setup-9.9.9.9.exe.blockmap",
        "latest.yml",
      ])
        fs.writeFileSync(path.join(dir, name), name);
      const manifest = (
        require_(path.join(ROOT, "scripts/release-manifest.cjs")) as {
          build: (input: Record<string, unknown>) => { assets: { name: string }[] };
        }
      ).build({ version: "9.9.9.9", releaseDir: dir, outDir: dir, syncLatest: false });
      const written = [
        ...manifest.assets.map((asset) => asset.name),
        ...["SHA256SUMS.txt", "friday-update.json"].filter((name) =>
          fs.existsSync(path.join(dir, name)),
        ),
      ].sort();
      expect(written).toEqual(uploaded);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the packaging settings and drops only the owner's workflow runs from the pack", () => {
    type Builder = {
      nsis: { perMachine: boolean; deleteAppDataOnUninstall: boolean; guid?: string };
      win: { signExecutable: boolean };
      differentialPackage?: unknown;
      extraResources: { from: string; to?: string; filter?: string[] }[];
    };
    const yaml = require_("js-yaml") as { load: (text: string) => Builder };
    const config = yaml.load(read("electron-builder.yml"));
    expect(config.nsis.perMachine).toBe(false);
    expect(config.nsis.deleteAppDataOnUninstall).toBe(false);
    expect(config.win.signExecutable).toBe(false);
    expect(config.nsis.guid).toBeUndefined();
    expect(config.differentialPackage).toBeUndefined();
    const entry = config.extraResources.find((item) => item.from === "workflows");
    expect(entry?.to).toBe("workflows");
    expect(entry?.filter).toEqual([
      "**/*",
      "!active/**",
      "!history/**",
      "!schedules/**",
      "!**/__pycache__/**",
      "!**/*.pyc",
    ]);
    for (const tree of ["modules", "skills", "tools", "agents", "plugins"])
      expect(config.extraResources.find((item) => item.from === tree)?.filter, tree).toEqual([
        "**/*",
        "!**/__pycache__/**",
        "!**/*.pyc",
      ]);
  });

  it("writes builtins.json from the tree that is packed and fails the build when the pack differs", async () => {
    const yaml = require_("js-yaml") as { load: (text: string) => unknown };
    const { getFileMatchers } = require_("app-builder-lib/out/fileMatcher.js") as {
      getFileMatchers: (
        config: unknown,
        name: string,
        destination: string,
        options: Record<string, unknown>,
      ) => Array<{
        from: string;
        isEmpty: () => boolean;
        prependPattern: (pattern: string) => void;
        createFilter: () => (file: string, stat: { isDirectory: () => boolean }) => boolean;
      }>;
    };
    const { copyDir } = require_("builder-util/out/fs.js") as {
      copyDir: (
        src: string,
        destination: string,
        options?: { filter?: (file: string, stat: { isDirectory: () => boolean }) => boolean },
      ) => Promise<void>;
    };
    const os = require_("node:os") as typeof import("node:os");
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "friday-builtins-pack-"));
    try {
      const resources = path.join(work, "win-unpacked", "resources");
      const config = yaml.load(read("electron-builder.yml"));
      const matchers = getFileMatchers(config, "extraResources", resources, {
        macroExpander: (value: string) => value,
        customBuildOptions: {},
        globalOutDir: path.join(work, "out"),
        defaultSrc: ROOT,
      });
      for (const tree of ["agents", "skills", "tools", "modules", "plugins", "workflows"]) {
        const matcher = matchers.find((m) => m.from === path.join(ROOT, tree));
        expect(matcher, tree).toBeTruthy();
        if (!matcher) continue;
        if (matcher.isEmpty()) matcher.prependPattern("**/*");
        await copyDir(matcher.from, path.join(resources, tree), { filter: matcher.createFilter() });
      }
      for (const dropped of ["active", "history", "schedules"])
        expect(fs.existsSync(path.join(resources, "workflows", dropped)), dropped).toBe(false);
      expect(fs.existsSync(path.join(resources, "workflows", "index.ts"))).toBe(true);
      expect(fs.readdirSync(path.join(resources, "workflows", "saved")).length).toBeGreaterThan(5);

      const manifest = api.writeBuiltins({
        root: ROOT,
        outFile: path.join(resources, "builtins.json"),
        version: "9.9.9.9",
      });
      expect(manifest.release).toBe("9.9.9.9");
      expect(Object.values(manifest.trees).flat().length).toBeGreaterThan(50);
      expect(api.assertBuiltins(resources).ok).toBe(true);

      const first = manifest.trees["skills"]?.[0] as { path: string } | undefined;
      expect(first).toBeTruthy();
      fs.writeFileSync(path.join(resources, first?.path ?? "", "added-after-build.txt"), "x");
      expect(() => api.assertBuiltins(resources)).toThrow(/content differs/);
      fs.rmSync(path.join(resources, "builtins.json"));
      expect(() => api.assertBuiltins(resources)).toThrow(/builtins\.json/);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it("raises the installer ceiling by the wheelhouse budget and keeps it under 2 GiB", () => {
    const manifest = JSON.parse(read("config/toolchain-manifest.json")) as {
      budgetBytes: number;
      wheelhouse: { budgetBytes: number };
    };
    const bounds = api.installerBounds(manifest);
    expect(bounds.ceiling).toBe(
      manifest.budgetBytes + manifest.wheelhouse.budgetBytes + 800 * 1024 * 1024,
    );
    expect(bounds.ceiling).toBe(1288860800);
    expect(bounds.ceiling).toBeLessThan(2147483648);
  });

  it("requires the staged wheelhouse in the packed app unless FRIDAY_WHEELHOUSE=0", () => {
    const os = require_("node:os") as typeof import("node:os");
    const stageApi = require_(path.join(ROOT, "scripts/stage-toolchain.cjs")) as {
      stagePlan: (manifest: unknown) => { packs: { id: string; dest: string }[] };
    };
    const wheelhouse = require_(path.join(ROOT, "scripts/wheelhouse.cjs")) as {
      writeStoredZip: (file: string, entries: { name: string; body: Buffer }[]) => void;
    };
    const manifest = JSON.parse(read("config/toolchain-manifest.json"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-wheel-layout-"));
    try {
      const release = path.join(root, "release");
      fs.mkdirSync(release, { recursive: true });
      for (const pack of stageApi.stagePlan(manifest).packs) {
        const dir = path.join(release, "win-unpacked", "resources", pack.dest, pack.id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "pack.bin"), Buffer.alloc(8));
      }
      const floor = api.installerBounds(manifest).floor;
      const big = Buffer.alloc(floor, 2);
      fs.writeFileSync(path.join(release, "FRIDAY-Setup-1.0.1.2.exe"), big);
      fs.writeFileSync(path.join(release, "FRIDAY-Portable-1.0.1.2.exe"), big);
      const input = { releaseDir: release, manifest, targets: ["nsis", "portable"] };
      expect(() => api.assertPackagedLayout({ ...input, env: {} })).toThrow(/wheelhouse/i);
      expect(api.assertPackagedLayout({ ...input, env: { FRIDAY_WHEELHOUSE: "0" } }).ok).toBe(true);

      const pack = path.join(release, "win-unpacked", "resources", "toolchain", "wheelhouse");
      fs.mkdirSync(pack, { recursive: true });
      const wheel = Buffer.from("not a real wheel");
      wheelhouse.writeStoredZip(path.join(pack, "pack.bin"), [
        { name: "demo-1.0-py3-none-any.whl", body: wheel },
      ]);
      expect(api.assertPackagedLayout({ ...input, env: {} }).ok).toBe(true);
      const sha = require_("node:crypto").createHash("sha256").update(wheel).digest("hex");
      const good = { filename: "demo-1.0-py3-none-any.whl", sha256: sha, bytes: wheel.length };
      expect(api.assertPackagedLayout({ ...input, env: {}, wheels: [good] }).ok).toBe(true);
      expect(() =>
        api.assertPackagedLayout({
          ...input,
          env: {},
          wheels: [{ ...good, sha256: "0".repeat(64) }],
        }),
      ).toThrow(/SHA-256/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the generator and the runtime share one ignore list", () => {
  it("takes its ignore rule from electron/builtins-sync.cjs instead of keeping a second list", () => {
    const generator = read("scripts/builtins-manifest.cjs");
    expect(generator).toContain('require("../electron/builtins-sync.cjs")');
    expect(generator).toContain("builtinsSync.isIgnored(entry.name)");
    const runtime = read("electron/builtins-sync.cjs");
    expect(runtime).toContain("if (isIgnored(entry.name)) continue;");
    const sync = require_(path.join(ROOT, "electron/builtins-sync.cjs")) as {
      IGNORED_NAMES: string[];
      isIgnored: (name: string) => boolean;
    };
    for (const name of [
      "__pycache__",
      "node_modules",
      ".git",
      "Thumbs.db",
      "desktop.ini",
      ".DS_Store",
      "x.pyc",
    ])
      expect(sync.isIgnored(name), name).toBe(true);
    expect(sync.isIgnored("main.py")).toBe(false);
    expect(sync.IGNORED_NAMES.every((name) => name === name.toLowerCase())).toBe(true);
  });
});

describe("the build record is one of the published files", () => {
  it("is written beside the update manifest, named by it, and picked up by the publish script", () => {
    const dir = fs.mkdtempSync(path.join(require_("node:os").tmpdir(), "friday-parity-bundle-"));
    const res = fs.mkdtempSync(path.join(require_("node:os").tmpdir(), "friday-parity-res-"));
    try {
      for (const name of ["FRIDAY-Setup-9.9.9.9.exe", "FRIDAY-Portable-9.9.9.9.exe", "latest.yml"])
        fs.writeFileSync(path.join(dir, name), name);
      fs.writeFileSync(path.join(res, "builtins.json"), "{}");
      const manifest = (
        require_(path.join(ROOT, "scripts/release-manifest.cjs")) as {
          build: (input: Record<string, unknown>) => { bundle?: { name: string } };
        }
      ).build({
        version: "9.9.9.9",
        releaseDir: dir,
        outDir: dir,
        syncLatest: false,
        resourcesDir: res,
        caller: "release",
        commit: null,
        env: {},
      });
      const written = fs.readdirSync(dir).sort();
      expect(written).toEqual(
        expect.arrayContaining(["SHA256SUMS.txt", "friday-bundle.json", "friday-update.json"]),
      );
      expect(manifest.bundle?.name).toBe("friday-bundle.json");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(res, { recursive: true, force: true });
    }
    const publish = read("scripts/ci-publish-release.sh");
    expect(publish).toContain("friday-bundle.json");
    expect(publish).toContain("2147483648");
  });
});
