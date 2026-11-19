/**
 * The folder the setup CMD runs in is the FRIDAY folder, so the owner's own settings and keys can sit in
 * `<checkout>\config`. They must stay out of git and out of the installer, and the Python environment must land
 * where the installed app looks for it. Text-level checks; nothing is packed or run.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const STATE_FILES = [
  "build-root",
  "capabilities",
  "connectors",
  "dev-changesets",
  "first-run",
  "friday-camera",
  "friday-preferences",
  "friday-screen-vision",
  "friday-settings",
  "friday-storage",
  "github",
  "install-extensions.user",
  "provider-access",
  "provider-endpoints",
  "provider-keys",
].map((n) => `${n}.json`);

describe("owner state in a checkout used as the FRIDAY folder", () => {
  const yml = read("electron-builder.yml");
  const configBlock = yml.slice(
    yml.indexOf("  - from: config\n"),
    yml.indexOf("  # Product What's New"),
  );
  const ignore = read(".gitignore");

  it("keeps every state file out of the installer", () => {
    for (const file of STATE_FILES) expect(configBlock, file).toContain(`"!${file}"`);
    expect(configBlock).toContain('"!user/**"');
    expect(configBlock).toContain('"!security/**"');
  });

  it("keeps every state file out of git, while the tracked config stays tracked", () => {
    for (const file of STATE_FILES) expect(ignore, file).toContain(`/config/${file}`);
    expect(ignore).toContain("!/config/user/.gitkeep");
    expect(ignore).toContain("!/config/security/.gitkeep");
    for (const tracked of [
      "kernel.yaml",
      "friday-version.json",
      "toolchain-versions.json",
      "download-hosts.json",
    ]) {
      expect(ignore).not.toContain(`/config/${tracked}`);
      expect(configBlock).not.toContain(`"!${tracked}"`);
    }
  });

  it("names every config file the app writes (the list cannot drift from the code)", () => {
    const code = [
      "credentials",
      "capabilities",
      "connectors",
      "dev-workflow",
      "friday-paths",
      "build-channel",
    ]
      .map((n) => read(`electron/${n}.cjs`))
      .join("\n");
    for (const file of [
      "provider-keys.json",
      "friday-settings.json",
      "friday-preferences.json",
      "capabilities.json",
      "connectors.json",
    ]) {
      expect(code, file).toContain(file.replace(".json", ""));
      expect(STATE_FILES).toContain(file);
    }
  });
});

describe("the Python environment follows the same folder", () => {
  it("is placed in <folder>\\runtime\\.venv for the setup CMD folder, not only for a recorded one", () => {
    const src = read("scripts/python-runtime.cjs");
    const fn = src.slice(
      src.indexOf("function selectedRuntimeParent"),
      src.indexOf("function targetVenvParent"),
    );
    expect(fn).toContain("workspaceRootOrDev({ record: false })");
    expect(fn).toContain("layout(picked.root).runtime");
  });
});
