import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ledger from "../../config/brain-wiring-ledger.json";

const ROOT = join(__dirname, "..", "..");
const walk = (dir: string, ok: (name: string) => boolean): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full, ok) : ok(name) ? [full] : [];
  });
const words = (text: string) => {
  const counts = new Map<string, number>();
  for (const word of text.match(/[A-Za-z_]\w*/g) ?? [])
    counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
};

const sources = [
  ...walk(join(ROOT, "src"), (n) => /\.(ts|tsx)$/.test(n) && !n.endsWith(".gen.ts")),
  ...walk(join(ROOT, "electron"), (n) => n.endsWith(".cjs")),
];
const sourceWords = words(sources.map((file) => readFileSync(file, "utf8")).join("\n"));
const testWords = words(
  walk(join(ROOT, "core"), (n) => /\.tsx?$/.test(n) && n !== "brain-wiring-ledger.test.ts")
    .map((file) => readFileSync(file, "utf8"))
    .join("\n"),
);
const EXPORT = /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_]\w*)/gm;

const unreferenced = sources
  .filter((file) => /src[\\/]lib[\\/]friday[\\/](brain|self)[\\/]/.test(file))
  .flatMap((file) => {
    const rel = relative(join(ROOT, "src", "lib", "friday"), file).replace(/\\/g, "/");
    return [...readFileSync(file, "utf8").matchAll(EXPORT)]
      .map((match) => match[1])
      .filter((name) => (sourceWords.get(name) ?? 0) <= 1)
      .map((name) => ({ key: `${rel}::${name}`, name }));
  });

describe("Brain wiring ledger", () => {
  const pending = ledger.pending as Record<string, string>;

  it("every export that no production file uses is pinned by a test or listed with a reason", () => {
    const loose = unreferenced.filter(
      (row) => !(testWords.get(row.name) ?? 0) && !pending[row.key],
    );
    expect(loose.map((row) => row.key)).toEqual([]);
  });

  it("the pending list only shrinks: nothing listed is already used or pinned", () => {
    const stale = Object.keys(pending).filter((key) => {
      const row = unreferenced.find((item) => item.key === key);
      return !row || (testWords.get(row.name) ?? 0) > 0;
    });
    expect(stale).toEqual([]);
  });

  it("each pending entry says why in a real sentence", () => {
    for (const reason of Object.values(pending)) expect(reason.length).toBeGreaterThan(20);
  });
});
