/**
 * The folder setup runs in is the FRIDAY folder, so FRIDAY's first launch from a source checkout writes the starter
 * kit and its runtime files into the working tree: 69 untracked entries on the first run of a real pack, and a failing
 * duplicate-file-names test. They are gitignored, and this keeps that list equal to what the app really installs.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { essentialPacks } from "../../src/lib/friday/capability-seed";

const root = path.resolve(__dirname, "..", "..");
const hasGit = existsSync(path.join(root, ".git"));

function git(args: string[], input = "") {
  return spawnSync("git", args, { cwd: root, input, encoding: "utf8" });
}

describe.skipIf(!hasGit)("a checkout used as the FRIDAY folder stays clean in git", () => {
  const tracked = new Set(git(["ls-files"]).stdout.split(/\r?\n/).filter(Boolean));
  const isTracked = (dir: string) => [...tracked].some((file) => file.startsWith(`${dir}/`));
  const ignored = (paths: string[]) =>
    new Set(
      git(["check-ignore", "--stdin"], paths.join("\n")).stdout.split(/\r?\n/).filter(Boolean),
    );

  it("ignores every starter-kit pack the app installs on first launch (unless the repo already tracks it)", () => {
    const dirs = essentialPacks()
      .filter((pack) => pack.risk !== "exec")
      .map((pack) => `${pack.tree}/${pack.segment}/${pack.slug}`);
    expect(dirs.length).toBeGreaterThan(40);
    const probe = dirs.filter((dir) => !isTracked(dir)).map((dir) => `${dir}/manifest.json`);
    const hidden = ignored(probe);
    const missing = probe.filter((file) => !hidden.has(file));
    expect(missing).toEqual([]);
  });

  it("ignores the runtime files the app writes into the folder", () => {
    const files = [
      "boot.json",
      "friday.json",
      "manifest.json",
      "permissions.json",
      "registry.json",
      "root.json",
      "storage.json",
      "version.json",
      "workspace.json",
      "workspace.json.bak",
      "config/.seed-state.json",
      "config/companion-features.json",
      "config/friday.json",
      "config/models.json",
      "config/paths.json",
      "config/permissions.json",
      "config/providers.json",
      "config/friday-settings.json.bak",
      "database/self-maintenance.json",
      "database/friday.sqlite3-wal",
      "database/friday.sqlite3-shm",
      "brain-data/personality/identity.txt",
      "plugins/data/state.json",
      "projects/notes.md",
      "models/moonshine-en/tokenizer.json",
      "models/friday-core/friday-core-e4b.gguf",
      "models/supertonic-3/config.json",
      "models/hindi-ear/tokenizer.json",
      "models/wake/hey-friday.onnx",
      "models/hindi-ear.source.json",
      "models/hindi-ear.prev/config.json",
      "models/friday-core/friday-core-e4b.gguf.part",
      "security/credentials/secrets.json",
      "backups/pending/friday-1.0.0.zip",
    ];
    const hidden = ignored(files);
    expect(files.filter((file) => !hidden.has(file))).toEqual([]);
  });

  it("hides none of the tracked sources under models, security and backups (models/*/index.ts included)", () => {
    const sources = [...tracked].filter((file) => /^(models|security|backups)\//.test(file));
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.filter((file) => ignored([file]).size > 0)).toEqual([]);
  });

  it("still tracks the files the repository owns", () => {
    for (const file of [
      "package.json",
      "README.md",
      "CHANGELOG.md",
      "config/kernel.yaml",
      "config/friday-version.json",
      "kernel/main.py",
    ]) {
      expect(tracked.has(file), file).toBe(true);
      expect(ignored([file]).size, `${file} must not be ignored`).toBe(0);
    }
  });
});
