import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "../..");
const models = require_(path.join(root, "electron", "models.cjs"));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fr-root-"));

/**
 * Credentials, endpoints and caches live in the selected FRIDAY folder only.
 * Without a root there is no second store anywhere on the machine.
 */
describe("root-only credential storage", () => {
  it("refuses to store provider keys before a FRIDAY folder is selected", () => {
    expect(models.readKeys(null)).toEqual({});
    expect(models.writeKey(null, "groq", "secret").ok).toBe(false);
    expect(models.readEndpoints(null)).toEqual({});
    expect(models.writeEndpoint(null, "groq", "https://x.dev").ok).toBe(false);
    expect(models.readAccessTiers(null)).toEqual({});
    expect(models.writeAccessTier(null, "groq", "free").ok).toBe(false);
  });

  it("keeps keys inside <root>/config", () => {
    const dir = tmp();
    models.writeKey(dir, "groq", "k-1");
    expect(fs.existsSync(path.join(dir, "config", "provider-keys.json"))).toBe(true);
    expect(models.readKeys(dir).groq).toBe("k-1");
  });

  it("refuses plaintext keys when Settings encryption is on and OS encryption is missing", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config", "friday-preferences.json"),
      JSON.stringify({ toggles: { encryption: true } }),
    );
    const result = models.writeKey(dir, "groq", "secret-key");
    if (result.ok) {
      expect(result.encrypted).toBe(true);
    } else {
      expect(result.error).toMatch(/secure storage/i);
    }
  });

  it("folds a legacy root-level key file into the canonical store once", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "provider-keys.json"), JSON.stringify({ groq: "legacy" }));
    const result = models.migrateCredentials(dir, []);
    expect(result.ok).toBe(true);
    expect(result.migrated).toBe(1);
    expect(models.readKeys(dir).groq).toBe("legacy");
    expect(fs.existsSync(path.join(dir, "provider-keys.json"))).toBe(false);
  });

  it("never falls back to a temp folder for persistent data", () => {
    const source = readFileSync(path.join(root, "electron", "models.cjs"), "utf8");
    expect(source).not.toMatch(/root \|\| os\.tmpdir\(\)/);
  });

  it("only reports CHAT ready when the pipeline actually answered", () => {
    const source = readFileSync(path.join(root, "electron", "readiness.cjs"), "utf8");
    expect(source).not.toContain("/model/i.test(String(chat.error");
    expect(source).toContain("modelList.ok && available.length > 0");
  });

  it("reads models.yaml from the FRIDAY root, not a source checkout", () => {
    const source = readFileSync(path.join(root, "kernel", "main.py"), "utf8");
    expect(source).toContain("FRIDAY_CONFIG_DIR");
    expect(source).toContain('Path(WORKSPACE_ROOT) / "config"');
  });
});
