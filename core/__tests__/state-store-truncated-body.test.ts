/**
 * A state file that starts and ends like JSON can still be a cut-off body (a write that stopped inside a nested value
 * and happens to end in a closing brace). It is parsed before it may replace the good `.bak`; a body that does not parse
 * never does.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const store = createRequire(import.meta.url)("../../electron/state-store.cjs") as {
  commitStateAsync: (file: string, value: unknown) => Promise<{ ok: boolean }>;
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-state-trunc-"));
  dirs.push(dir);
  return path.join(dir, "state.json");
};

describe("the rolling backup is taken only from a body that parses", () => {
  it("a cut-off body that ends in a closing brace does not replace a good backup", async () => {
    const file = scratch();
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ good: 1 }));
    fs.writeFileSync(file, '{"a":{"b":1}');
    expect((await store.commitStateAsync(file, { next: 2 })).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"))).toEqual({ good: 1 });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ next: 2 });
  });

  it("a cut-off array that ends in a closing bracket does not either", async () => {
    const file = scratch();
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ good: 1 }));
    fs.writeFileSync(file, '[{"a":[1,2]');
    await store.commitStateAsync(file, { next: 3 });
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"))).toEqual({ good: 1 });
  });

  it("a whole body still becomes the backup", async () => {
    const file = scratch();
    fs.writeFileSync(file, JSON.stringify({ old: { nested: [1, 2] } }));
    await store.commitStateAsync(file, { next: 4 });
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"))).toEqual({ old: { nested: [1, 2] } });
  });
});
