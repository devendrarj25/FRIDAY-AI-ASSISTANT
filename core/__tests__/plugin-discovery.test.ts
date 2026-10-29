import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const plugins = require(path.resolve("electron/plugins.cjs"));

const root = mkdtempSync(path.join(tmpdir(), "friday-plugins-"));
const dir = path.join(root, "plugins");

const folder = (...parts: string[]) => {
  const target = path.join(dir, ...parts);
  mkdirSync(target, { recursive: true });
  return target;
};

// Organisational folders that ship with the workspace layout — no manifests.
for (const name of ["disabled", "installed", "manifests", "marketplace", "sandbox", "updates"]) {
  folder(name);
}
// One real top-level plugin and one installed inside a container folder.
writeFileSync(
  path.join(folder("hello-world"), "manifest.json"),
  JSON.stringify({ id: "hello-world", name: "Hello World", version: "1.0.0" }),
);
writeFileSync(
  path.join(folder("installed", "notes-sync"), "plugin.json"),
  JSON.stringify({ id: "notes-sync", name: "Notes Sync", version: "0.2.0" }),
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("workspace plugin discovery", () => {
  it("never treats organisational folders as plugins", () => {
    const ids = plugins.list(root).map((p: { id: string }) => p.id);
    expect(ids).not.toContain("disabled");
    expect(ids).not.toContain("installed");
    expect(ids).not.toContain("manifests");
    expect(ids).not.toContain("marketplace");
  });

  it("finds real plugins at the top level and inside container folders", () => {
    const ids = plugins.list(root).map((p: { id: string }) => p.id);
    expect(ids).toEqual(["hello-world", "notes-sync"]);
  });

  it("resolves a nested plugin folder by id", () => {
    expect(plugins.findDir?.(root, "notes-sync") ?? null).toBeNull(); // findDir stays internal
    const nested = plugins.list(root).find((p: { id: string }) => p.id === "notes-sync");
    expect(nested.path).toContain(path.join("installed", "notes-sync"));
  });

  it("loads only manifest-bearing plugins, so boot reports no phantom failures", async () => {
    const services = {
      log: () => {},
      emit: () => {},
      on: () => () => {},
      kernel: async () => ({}),
      workspaceRoot: () => root,
    };
    const results = await plugins.loadEnabled(root, services);
    expect(results.map((r: { id: string }) => r.id)).toEqual(["hello-world", "notes-sync"]);
    // Both fail only because their entry file is absent in this fixture —
    // never because a container folder was mistaken for a plugin.
    for (const result of results) expect(String(result.error)).toMatch(/entry is missing/);
  });
});
