/**
 * The GitHub token must live in the canonical credential store only — never in
 * config/github.json, and never handed back to the renderer.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const credentials = require("../../electron/credentials.cjs");
const sync = require("../../electron/github-sync.cjs");

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cred-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const githubConfig = () =>
  JSON.parse(fs.readFileSync(path.join(root, "config", "github.json"), "utf8"));

describe("GitHub credential storage", () => {
  it("stores the token outside config.json, under security/credentials", () => {
    const saved = sync.writeConfig(root, { repo: "owner/name", token: "ghp_secret" });
    expect(saved.ok).toBe(true);
    expect(githubConfig().token).toBeUndefined();
    expect(JSON.stringify(githubConfig())).not.toContain("ghp_secret");
    expect(fs.existsSync(credentials.secretsFile(root))).toBe(true);
    expect(sync.readConfig(root).token).toBe("ghp_secret");
  });

  it("never exposes the token to the renderer, only whether one is stored", () => {
    sync.writeConfig(root, { repo: "owner/name", token: "ghp_secret" });
    const shown = sync.publicConfig(sync.readConfig(root));
    expect(shown.hasToken).toBe(true);
    expect((shown as Record<string, unknown>)["token"]).toBeUndefined();
  });

  it("migrates a token found in a historical config file and erases it there", () => {
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "config", "github.json"),
      JSON.stringify({ repo: "owner/name", token: "ghp_legacy" }),
    );
    expect(sync.readConfig(root).token).toBe("ghp_legacy");
    expect(githubConfig().token).toBeUndefined();
    expect(credentials.getSecret(root, "github.token")).toBe("ghp_legacy");
  });

  it("clears the token when an empty value is saved", () => {
    sync.writeConfig(root, { repo: "owner/name", token: "ghp_secret" });
    sync.writeConfig(root, { token: "" });
    expect(sync.readConfig(root).token).toBe("");
    expect(sync.publicConfig(sync.readConfig(root)).hasToken).toBe(false);
  });

  it("keeps Settings → General GitHub token on the same credential store", () => {
    const general = fs.readFileSync(
      path.join(process.cwd(), "src/components/friday/settings/GeneralSettings.tsx"),
      "utf8",
    );
    const updates = fs.readFileSync(
      path.join(process.cwd(), "src/components/friday/settings/GithubUpdates.tsx"),
      "utf8",
    );
    expect(general).toContain("githubSetConfig");
    expect(general).not.toContain('setField("githubToken")');
    expect(updates).toContain("githubSetConfig");
    expect(updates).toContain("patch({ token }");
  });
});
