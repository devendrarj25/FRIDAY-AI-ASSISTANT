#!/usr/bin/env node
/**
 * FRIDAY · release builder CLI.
 *
 * Usage:
 *   node builder/cli.mjs plan       # inspect sources + dependencies, no writes
 *   node builder/cli.mjs test       # sandbox/testing pass before packaging
 *   node builder/cli.mjs exe        # Windows NSIS installer -> release/
 *   node builder/cli.mjs zip        # source + data archive -> releases/installers
 *   node builder/cli.mjs release    # test -> exe -> zip -> manifest
 *
 * Nothing here overwrites the user's FRIDAY data folder; artifacts only ever
 * land in release/ and releases/.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const IDENTITY = require("../scripts/identity.cjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });

const steps = {
  plan() {
    const trees = ["core", "agents", "skills", "tools", "plugins", "modules", "workflows"];
    for (const t of trees) {
      const dirs = fs.existsSync(path.join(root, t))
        ? fs.readdirSync(path.join(root, t), { withFileTypes: true }).filter((d) => d.isDirectory())
        : [];
      console.log(`${t.padEnd(12)} ${dirs.length} modules`);
    }
    console.log(`dependencies  ${Object.keys(pkg.dependencies ?? {}).length}`);
  },
  test() {
    run("npm run lint");
    run("npx tsc --noEmit");
  },
  exe() {
    run("npm run build:desktop");
    run("node scripts/electron-pack.cjs --win nsis");
  },
  zip() {
    // A source archive must contain the whole buildable project and nothing
    // that is regenerated: node_modules, caches and previous artifacts. They
    // are excluded by staging a filtered copy first, because a bare
    // `Compress-Archive -Path *` pulls in node_modules and fails or produces a
    // multi-GB file that cannot be re-imported.
    const out = path.join(root, "releases", "installers");
    fs.mkdirSync(out, { recursive: true });
    const name = `FRIDAY-${pkg.version}-source.zip`;
    const archive = path.join(out, name);
    const stage = path.join(root, "releases", `.stage-${pkg.version}`);
    const SKIP = new Set([
      "node_modules",
      ".git",
      ".venv",
      ".cache",
      "release",
      "releases",
      "dist",
      "dist-desktop",
      "__pycache__",
      "temporary",
      "backups",
      "backup",
    ]);

    // Copy by hand rather than with cpSync: the project tree can contain
    // symlinks and Windows junctions (npm .bin shims, cached toolchains) and
    // following one that points at an excluded folder fails the whole archive
    // with ENOTDIR. Only real files and directories are staged.
    const copyTree = (src, dest) => {
      let entries;
      try {
        entries = fs.readdirSync(src, { withFileTypes: true });
      } catch {
        return;
      }
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const from = path.join(src, entry.name);
        const to = path.join(dest, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) copyTree(from, to);
        else if (entry.isFile()) {
          try {
            fs.copyFileSync(from, to);
          } catch {
            /* locked or vanished file — never fail the whole archive */
          }
        }
      }
    };

    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    copyTree(root, stage);
    fs.writeFileSync(
      path.join(stage, "FRIDAY-PACKAGE.json"),
      `${JSON.stringify(
        IDENTITY.archiveStamp({
          version: pkg.version,
          builtAt: new Date().toISOString(),
        }),
        null,
        2,
      )}\n`,
    );

    fs.rmSync(archive, { force: true });
    try {
      if (process.platform === "win32") {
        run(
          `powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '${stage}\\*' -DestinationPath '${archive}' -Force"`,
        );
      } else {
        run(`cd "${stage}" && zip -qr "${archive}" .`);
      }
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
    if (!fs.existsSync(archive)) throw new Error(`archive was not produced: ${archive}`);
    const mb = (fs.statSync(archive).size / 1024 / 1024).toFixed(1);
    console.log(`archive -> ${archive} (${mb} MB)`);
  },
  release() {
    steps.test();
    steps.exe();
    steps.zip();
    const manifests = path.join(root, "releases", "manifests");
    fs.mkdirSync(manifests, { recursive: true });
    fs.writeFileSync(
      path.join(manifests, `${pkg.version}.json`),
      `${JSON.stringify(
        IDENTITY.archiveStamp({
          version: pkg.version,
          builtAt: new Date().toISOString(),
        }),
        null,
        2,
      )}\n`,
    );
  },
};

const cmd = process.argv[2] ?? "plan";
if (!steps[cmd]) {
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}
steps[cmd]();
