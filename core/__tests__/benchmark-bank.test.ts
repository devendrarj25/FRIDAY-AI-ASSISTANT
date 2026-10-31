import { describe, expect, it } from "vitest";
import { CATEGORIES, coverage, runBank } from "../../src/lib/friday/self/benchmark-bank";
import { DOMAIN_WEIGHTS } from "../../src/lib/friday/self/eval-stats";

describe("Brain Benchmark 1.0 category bank", () => {
  it("has twelve domains with at least five categories each and unique ids", () => {
    const ids = CATEGORIES.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
    const rows = coverage();
    expect(rows).toHaveLength(Object.keys(DOMAIN_WEIGHTS).length);
    for (const row of rows) {
      expect(row.total, row.domain).toBeGreaterThanOrEqual(5);
      expect(row.app + row.tests + row.model + row.desktop + row.external).toBe(row.total);
    }
  });

  it("says where every category that is not scored in the app is checked", () => {
    for (const category of CATEGORIES) {
      if (category.backing === "app") expect(category.run, category.id).toBeTypeOf("function");
      else expect(category.where?.length ?? 0, category.id).toBeGreaterThan(10);
    }
  });

  it("scores every in-app category and finds them all passing on the shipped code", async () => {
    const results = await runBank();
    const apps = CATEGORIES.filter((category) => category.backing === "app");
    expect(results).toHaveLength(apps.length);
    const floorOf = (id: string) => apps.find((category) => category.id === id)?.floor ?? 1;
    const failing = results
      .filter((row) => row.total === 0 || row.passed / row.total < floorOf(row.id))
      .map((row) => `${row.id} ${row.passed}/${row.total}`);
    expect(failing).toEqual([]);
  });

  it("points only at test files that exist", async () => {
    const { existsSync, readdirSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const root = resolve(__dirname, "../..");
    const core = readdirSync(resolve(root, "core/__tests__"));
    for (const category of CATEGORIES.filter((c) => c.backing === "tests")) {
      const named = [
        ...(category.where ?? "").matchAll(/((?:core\/__tests__|kernel\/tests)\/[\w*.-]+)/g),
      ].map((m) => m[1] as string);
      for (const file of named) {
        if (file.includes("*")) {
          const [dir, pattern] = [
            file.slice(0, file.lastIndexOf("/")),
            file.slice(file.lastIndexOf("/") + 1),
          ];
          const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
          const names = dir === "core/__tests__" ? core : readdirSync(resolve(root, dir));
          expect(
            names.some((n) => re.test(n)),
            `${category.id}: ${file}`,
          ).toBe(true);
        } else {
          expect(existsSync(resolve(root, file)), `${category.id}: ${file}`).toBe(true);
        }
      }
    }
  });
});
