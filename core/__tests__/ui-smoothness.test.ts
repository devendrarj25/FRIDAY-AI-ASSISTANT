import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("the title strip does not loop animations under its backdrop blur", () => {
  it("draws the small orb still", () => {
    expect(read("src/components/friday/TitleStrip.tsx")).toMatch(/<FridayOrb[^>]*\bstill\b/);
  });

  it("keeps every looping orb layer behind the still switch", () => {
    const orb = read("src/components/friday/FridayOrb.tsx");
    expect(orb).toContain("const moving = live && !still;");
    for (const layer of ["orb-halo", "orb-spin-slow", "orb-sweep", "orb-breathe"]) {
      const line = orb.split("\n").find((l) => l.includes(layer)) ?? "";
      expect(line, layer).toBeTruthy();
    }
    expect(orb).not.toMatch(
      /live \? "orb-|live && "orb-|\{live \? \(\s*<span\s+className="orb-sweep/,
    );
  });
});
