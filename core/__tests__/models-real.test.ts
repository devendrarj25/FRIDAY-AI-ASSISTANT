import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";
import { modelByTag, modelCatalog, registryTag } from "@/lib/friday/model-catalog";

const require = createRequire(import.meta.url);
const models = require(path.resolve(__dirname, "..", "..", "electron", "models.cjs"));

describe("registry tags", () => {
  it("derives the real Ollama tag from the library URL and parameter size", () => {
    const llama = modelCatalog.find((m) => m.id === "llama3.1-8b")!;
    expect(registryTag(llama)).toBe("llama3.1:8b");
    expect(modelByTag("llama3.1:8b")?.id).toBe("llama3.1-8b");
    expect(modelByTag("llama3.1:latest")?.id).toBe("llama3.1-8b");
  });

  it("returns no tag for cloud models — they are addressed by API id", () => {
    const cloud = modelCatalog.find((m) => m.kind === "cloud")!;
    expect(registryTag(cloud)).toBeNull();
  });
});

describe("real model operations", () => {
  it("reports every provider honestly when nothing is running", async () => {
    const inv = await models.inventory({ userData: fs.mkdtempSync(path.join(os.tmpdir(), "fr-")) });
    expect(inv.providers.length).toBeGreaterThan(5);
    for (const p of inv.providers) {
      expect(typeof p.online).toBe("boolean");
      if (!p.online) expect(p.error).toBeTruthy(); // never a silent fake "online"
      expect(Array.isArray(p.models)).toBe(true);
    }
    expect(inv.totals.models).toBe(
      inv.providers.reduce((n: number, p: { models: [] }) => n + p.models.length, 0),
    );
  }, 60_000);

  it("fails a cloud probe with a real rejection instead of pretending", async () => {
    const probe = await models.testProvider("openai", { apiKey: "sk-definitely-not-valid" });
    expect(probe.online).toBe(false);
    expect(probe.error).toBeTruthy();
  }, 30_000);

  it("stores and clears provider keys on disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-keys-"));
    models.writeKey(dir, "groq", "test-key-123");
    expect(models.readKeys(dir).groq).toBe("test-key-123");
    models.writeKey(dir, "groq", null);
    expect(models.readKeys(dir).groq).toBeUndefined();
  });
});
