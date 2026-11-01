import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const text = fs.readFileSync(path.join(root, "SECURITY.md"), "utf8");
const section = text.slice(text.indexOf("## Agent risks"), text.indexOf("## GitHub Secrets"));
const rows = section.split("\n").filter((line) => /^\| ASI\d\d /.test(line));

describe("agent risk table in SECURITY.md", () => {
  it("covers all ten risks once each", () => {
    expect(rows.map((row) => /ASI\d\d/.exec(row)?.[0])).toEqual(
      Array.from({ length: 10 }, (_, i) => `ASI${String(i + 1).padStart(2, "0")}`),
    );
  });

  it("names a control and at least one test file for every risk, and every named test exists", () => {
    for (const row of rows) {
      const cells = row.split("|").map((cell) => cell.trim());
      const [, risk, control, tests] = cells;
      expect(control && control.length > 20, risk).toBe(true);
      const files = [...(tests ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
      expect(files.length, risk).toBeGreaterThan(0);
      for (const file of files)
        expect(fs.existsSync(path.join(root, file)), `${risk}: ${file}`).toBe(true);
    }
  });
});
