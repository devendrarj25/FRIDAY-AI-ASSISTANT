import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the bundled fonts survive the build", () => {
  it("package.json does not let the bundler drop the font imports as side-effect free", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      sideEffects?: boolean | string[];
    };
    // `sideEffects: false` removed src/lib/friday/fonts.ts, so the installed app silently used system fonts.
    expect(Array.isArray(pkg.sideEffects)).toBe(true);
    expect(pkg.sideEffects).toContain("**/*.css");
    expect(pkg.sideEffects).toContain("./src/lib/friday/fonts.ts");
  });

  it("the packaged-app check names the font files it requires", () => {
    const script = readFileSync("scripts/verify-build.cjs", "utf8");
    for (const name of [
      "orbitron-latin",
      "rajdhani-latin-400",
      "rajdhani-devanagari-400",
      "jetbrains-mono-latin",
    ]) {
      expect(script, name).toContain(name);
    }
  });

  // The renderer build runs after the unit tests, so this only checks a build that already exists (and says so when skipped).
  const assets = "dist-desktop/assets";
  it.skipIf(!existsSync(assets))(
    "a built renderer declares an @font-face for every bundled family",
    () => {
      const css = readdirSync(assets)
        .filter((name) => name.endsWith(".css"))
        .map((name) => readFileSync(`${assets}/${name}`, "utf8"))
        .join("\n");
      for (const family of [
        "Orbitron Variable",
        "Exo 2 Variable",
        "Inter Tight Variable",
        "Lexend Variable",
        "JetBrains Mono Variable",
        "Rajdhani",
        "Atkinson Hyperlegible",
      ]) {
        expect(css, family).toMatch(new RegExp(`@font-face\\{[^}]*font-family:["']?${family}`));
      }
      expect(css).toMatch(/unicode-range:[^;}]*u\+0?900-0?97f/i);
    },
  );
});
