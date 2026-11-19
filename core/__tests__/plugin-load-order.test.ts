/**
 * Plugins load four at a time at boot (a PC with twenty plugins used to wait for them one by one before FRIDAY
 * called itself ready), and the results still come back in plugin order, with one entry for every plugin.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const plugins = require_(path.resolve("electron/plugins.cjs"));

const root = mkdtempSync(path.join(tmpdir(), "friday-plugin-order-"));
const ids = Array.from({ length: 11 }, (_, i) => `plugin-${String(i).padStart(2, "0")}`);
for (const id of ids) {
  const dir = path.join(root, "plugins", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ id, name: id, version: "1.0.0" }),
  );
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

const services = {
  log: () => {},
  emit: () => {},
  on: () => () => {},
  kernel: async () => ({}),
  workspaceRoot: () => root,
};

describe("loading every enabled plugin", () => {
  it("returns one result per plugin, in plugin order, however many there are", async () => {
    const results = await plugins.loadEnabled(root, services);
    expect(results.map((r: { id: string }) => r.id)).toEqual(ids);
    for (const r of results) expect(r).toHaveProperty("ok");
  });

  it("runs four loads at once and reports a load that throws instead of dropping it", () => {
    const source = readFileSync(path.resolve("electron/plugins.cjs"), "utf8");
    expect(source).toContain("const LOAD_CONCURRENCY = 4;");
    const fn = source.slice(
      source.indexOf("async function loadEnabled"),
      source.indexOf("/* ----", source.indexOf("async function loadEnabled")),
    );
    expect(fn).toContain("Promise.all");
    expect(fn).toContain("results[at] = { id: plugin.id, ...outcome }");
    expect(fn).toMatch(/catch \(error\)[\s\S]*ok: false/);
  });
});
