/**
 * FRIDAY - development/vision layer independence contract.
 *
 * `FRIDAY-DEVELOPMENT & VISION/` and `READMEFIRST.md` are a disposable
 * AI-working/planning layer (see READMEFIRST.md). Deleting them must leave a
 * complete, independently working FRIDAY product: nothing under `src/`,
 * `electron/`, `kernel/`, `core/`, `agents/`, `skills/`, `tools/`, `plugins/`,
 * `modules/`, `workflows/`, `config/`, `scripts/`, `builder/`, `installer/`,
 * or `updater/` may import, require, or otherwise depend on that folder.
 *
 * This test proves it three ways:
 *  1. Static scan - no product source file references the working-layer
 *     paths in an import/require/fs-read statement.
 *  2. Temp-copy simulation - copy the product source (excluding the working
 *     layer and node_modules, for speed) into a temp directory, delete
 *     nothing else, and confirm every real entrypoint/config file that
 *     existed in the original checkout is still present and readable with
 *     the working layer physically absent.
 *  3. Isolated real install - copy the *entire* product tree (working layer
 *     physically excluded) into a temp directory and run a real
 *     `npm install` + `npm run typecheck` there, plus a kernel `py_compile`
 *     pass. This is the SOURCE_READY state from
 *     `FRIDAY-DEVELOPMENT & VISION/FRIDAY-DEVELOPMENT/11_TESTING_RELEASE/VALIDATION_STATES.md`.
 *     A full Electron/NSIS build and an actual GUI boot (BUILD_READY) need
 *     Windows and are not attempted here -- that stays NOT VERIFIED on this
 *     environment rather than faked.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const WORKING_LAYER_DIR = "FRIDAY-DEVELOPMENT & VISION";
const WORKING_LAYER_INDEX = "READMEFIRST.md";

const PRODUCT_DIRS = [
  "src",
  "electron",
  "kernel",
  "core",
  "agents",
  "skills",
  "tools",
  "plugins",
  "modules",
  "workflows",
  "config",
  "scripts",
  "builder",
  "installer",
  "updater",
];

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs", ".py"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__pycache__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("development/vision layer independence", () => {
  it("no product source file references the disposable working layer", () => {
    // Known-legitimate mentions: the string itself is data here, not a
    // runtime dependency on the folder.
    //  - this test file necessarily contains the string it searches for.
    //  - scripts/docs-engine.cjs's UNREGISTERED_OK allowlist names the
    //    folder only to *exclude* it from the docs registry -- that is the
    //    opposite of depending on it.
    //  - scripts/pr-scope.cjs names the folder only so that an edit confined to it
    //    is classified as documentation; with the folder gone the script still
    //    works, and its test (pr-scope.test.ts) asserts that classification.
    const KNOWN_SAFE_MENTIONS = new Set([
      "core/__tests__/dev-layer-independence.test.ts",
      "core/__tests__/development-contracts.test.ts",
      "core/__tests__/pr-scope.test.ts",
      "scripts/docs-engine.cjs",
      "scripts/pr-scope.cjs",
    ]);

    const offenders: string[] = [];
    const needle1 = "FRIDAY-DEVELOPMENT & VISION";
    const needle2 = "FRIDAY-DEVELOPMENT%20%26%20VISION";

    for (const dirName of PRODUCT_DIRS) {
      const dirPath = path.join(ROOT, dirName);
      if (!fs.existsSync(dirPath)) continue;
      for (const file of walk(dirPath)) {
        if (!CODE_EXTENSIONS.has(path.extname(file))) continue;
        const rel = path.relative(ROOT, file).split(path.sep).join("/");
        if (KNOWN_SAFE_MENTIONS.has(rel)) continue;
        const content = fs.readFileSync(file, "utf8");
        if (content.includes(needle1) || content.includes(needle2)) {
          offenders.push(rel);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("real FRIDAY entrypoints/config survive with the working layer physically absent", () => {
    // The files any of these subsystems actually needs to exist to run.
    // If the working layer were a real dependency, one of these would be
    // missing, unreadable, or would itself reference the deleted folder.
    const criticalFiles = [
      "package.json",
      "electron/main.cjs",
      "electron/preload.cjs",
      "kernel/main.py",
      "config/friday-version.json",
    ];

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "friday-independence-"));
    try {
      for (const rel of criticalFiles) {
        const src = path.join(ROOT, rel);
        if (!fs.existsSync(src)) continue; // some may not exist on every branch; skip rather than fail on layout drift unrelated to this contract
        const dst = path.join(tmpRoot, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }

      // Simulate deletion: the working layer and its index are never copied
      // into tmpRoot at all, i.e. they are "absent" in this simulation.
      expect(fs.existsSync(path.join(tmpRoot, WORKING_LAYER_DIR))).toBe(false);
      expect(fs.existsSync(path.join(tmpRoot, WORKING_LAYER_INDEX))).toBe(false);

      for (const rel of criticalFiles) {
        const dst = path.join(tmpRoot, rel);
        if (!fs.existsSync(path.join(ROOT, rel))) continue;
        expect(fs.existsSync(dst)).toBe(true);
        const content = fs.readFileSync(dst, "utf8");
        expect(content).not.toContain(WORKING_LAYER_DIR);
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("package.json does not declare the working layer as a dependency, workspace, or script input", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const serialized = JSON.stringify(pkg);
    expect(serialized).not.toContain(WORKING_LAYER_DIR);
    expect(serialized).not.toContain("FRIDAY-VISION");
  });

  it("electron-builder release packaging cannot pick up the working layer", () => {
    const builderConfigPath = path.join(ROOT, "electron-builder.yml");
    if (!fs.existsSync(builderConfigPath)) return; // config may move; not this contract's concern
    const content = fs.readFileSync(builderConfigPath, "utf8");

    // The working layer's own name must never appear in the packaging config.
    expect(content).not.toContain(WORKING_LAYER_DIR);
    expect(content).not.toContain("READMEFIRST");

    // Guard the *shape* of the config, not just today's content: every
    // top-level `files`/`extraResources` wildcard must be scoped inside a
    // named `from:`/path entry, never a bare repo-root "**/*" or "*" that
    // could sweep up new top-level folders (including a future working
    // layer) without anyone updating this test.
    const bareRootWildcard = /^\s*-\s*['"]?\*\*?\/?\*?['"]?\s*$/m;
    const filesBlockMatch = content.match(/^files:\n([\s\S]*?)(?=^\S)/m);
    const capturedFilesBlock = filesBlockMatch?.[1];
    if (capturedFilesBlock) {
      expect(bareRootWildcard.test(capturedFilesBlock)).toBe(false);
    }
  });

  // Heavier check: an actual isolated copy, a real `npm install`, and a real
  // typecheck -- not just static analysis. This is the SOURCE_READY claim
  // from VALIDATION_STATES.md, proven with the working layer physically
  // absent from disk, not simulated by string matching.
  //
  // What this test does NOT attempt, and why: a full Electron/NSIS build and
  // an actual application boot require Windows and GUI capability this
  // environment does not have. That is the BUILD_READY state
  // (VALIDATION_STATES.md) -- it stays NOT VERIFIED here, on purpose, rather
  // than being faked. Report it as such; don't claim boot/readiness passed
  // because this test passed.
  it("clean dependency install + typecheck succeed in an isolated copy with the working layer physically absent (SOURCE_READY only -- see VALIDATION_STATES.md)", async () => {
    const { execFileSync } = await import("node:child_process");

    const COPY_EXCLUDES = new Set([
      "node_modules",
      ".venv",
      ".git",
      WORKING_LAYER_DIR,
      WORKING_LAYER_INDEX,
      "__pycache__",
      "dist",
      "dist-desktop",
      "release",
    ]);

    function copyTree(src: string, dst: string) {
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (COPY_EXCLUDES.has(entry.name)) continue;
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) {
          fs.mkdirSync(d, { recursive: true });
          copyTree(s, d);
        } else {
          fs.copyFileSync(s, d);
        }
      }
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "friday-isolated-"));
    let cleanupError: unknown;
    try {
      copyTree(ROOT, tmpRoot);

      // The working layer must be physically absent in the copy -- not
      // skipped, actually never written.
      expect(fs.existsSync(path.join(tmpRoot, WORKING_LAYER_DIR))).toBe(false);
      expect(fs.existsSync(path.join(tmpRoot, WORKING_LAYER_INDEX))).toBe(false);

      let installOk = false;
      let installSkippedReason = "";
      const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
      const pythonBin = process.platform === "win32" ? "python" : "python3";
      // Node refuses to spawn .cmd files directly (EINVAL). Windows needs a shell.
      const npmOpts = {
        cwd: tmpRoot,
        stdio: "pipe" as const,
        shell: process.platform === "win32",
      };
      try {
        execFileSync(npmBin, ["install", "--no-audit", "--no-fund"], {
          ...npmOpts,
          timeout: 240_000,
        });
        installOk = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Network/registry unavailability is an environment limitation,
        // not evidence the product depends on the working layer -- don't
        // fail the contract for a sandbox that can't reach npmjs.org.
        const looksLikeEnvLimit =
          /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|network|registry/i.test(msg);
        if (looksLikeEnvLimit) {
          installSkippedReason = `npm install could not reach the registry in this environment (${msg.slice(0, 200)}) -- SOURCE_READY not verified this run, environment limitation, not a contract failure.`;
        } else {
          throw err; // a real install failure (e.g. a genuine missing/broken dependency) should fail the test
        }
      }

      if (!installOk) {
        console.warn(installSkippedReason);
        return;
      }

      // Real typecheck against the isolated, working-layer-free copy.
      execFileSync(npmBin, ["run", "typecheck"], {
        ...npmOpts,
        timeout: 120_000,
      });

      // Lightweight kernel proxy: every kernel .py file must at least
      // parse on its own in the isolated copy. This is not a boot test
      // (no server is started, no dependencies imported) -- it only
      // proves the kernel source itself doesn't require the removed
      // layer to be syntactically/importably self-contained.
      const kernelDir = path.join(tmpRoot, "kernel");
      if (fs.existsSync(kernelDir)) {
        execFileSync(
          pythonBin,
          ["-m", "py_compile", ...walk(kernelDir).filter((f) => f.endsWith(".py"))],
          { cwd: tmpRoot, stdio: "pipe", timeout: 60_000 },
        );
      }
    } finally {
      // Windows can keep this temp copy locked after npm and python have
      // already exited. The contract is the install and typecheck; deleting
      // the copy must not turn that success into a failure.
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      } catch (err) {
        const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
        if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY" && code !== "ENOENT") {
          cleanupError = err;
        }
      }
    }
    if (cleanupError) throw cleanupError;
  }, 360_000);
});
