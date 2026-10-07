/**
 * FRIDAY · secret storage safety
 *
 * Tokens and API keys live in exactly two canonical, encrypted places inside
 * the selected FRIDAY root:
 *   <FRIDAY_ROOT>/config/provider-keys.json      — model provider keys
 *   <FRIDAY_ROOT>/security/credentials/secrets.json — every other secret
 *
 * They are never written to browser storage, never logged and never handed
 * back to the renderer. This test keeps that contract mechanical.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const sources = walk(path.join(ROOT, "src"));

describe("no secret ever reaches browser storage", () => {
  it("never writes a key/token/secret/password into localStorage or sessionStorage", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const text = fs.readFileSync(file, "utf8");
      const writes = text.match(/(local|session)Storage\.setItem\([^)]*\)/g) ?? [];
      for (const call of writes) {
        // The stored VALUE must not be a credential. Names such as
        // "friday.n8n" or a storage KEY constant are fine.
        if (/\b(apiKey|api_key|token|secret|password|credential)\b/i.test(call))
          offenders.push(`${path.relative(ROOT, file)} → ${call}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the n8n API key out of the persisted connection record", () => {
    const text = fs.readFileSync(path.join(ROOT, "src/routes/n8n.tsx"), "utf8");
    // The saved record carries the endpoint and webhook only.
    expect(text).toContain("JSON.stringify({ base, hook: webhook })");
    expect(text).not.toContain("JSON.stringify({ base, key, hook: webhook })");
    // A key written by an older build is purged instead of being read back.
    expect(text).not.toContain("if (s.key) setKey(s.key)");
  });
});

describe("canonical credential stores", () => {
  const credentials = fs.readFileSync(path.join(ROOT, "electron/credentials.cjs"), "utf8");
  const models = fs.readFileSync(path.join(ROOT, "electron/models.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(ROOT, "electron/preload.cjs"), "utf8");

  it("encrypts with the OS store and refuses plain text in a packaged app", () => {
    expect(credentials).toContain("safeStorage.encryptString");
    expect(credentials).toContain("productionMode()");
    expect(models).toContain("productionMode()");
    expect(models).toContain("safeStorage.encryptString");
    expect(models).toMatch(/refuses to save this credential/);
  });

  it("stores secrets only inside the selected FRIDAY root", () => {
    expect(credentials).toContain('path.join(root, "security", "credentials")');
    expect(models).toContain('path.join(root, "config", "provider-keys.json")');
    expect(credentials).not.toMatch(/app\.getPath\("userData"\)/);
  });

  it("never exposes a stored secret over the preload bridge", () => {
    // Presence only: `models:keys` maps ids → true; there is no getter that
    // returns a key, and no generic secret read channel.
    expect(preload).toContain('ipcRenderer.invoke("models:keys")');
    expect(preload).not.toMatch(/getProviderKey|readSecret|secrets:get/);
  });
});
