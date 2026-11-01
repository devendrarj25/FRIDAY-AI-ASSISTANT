import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx$/.test(name) ? [full] : [];
  });
}

describe("waiting is shown, not hidden", () => {
  it("shows a waiting state when a section is slow to arrive, in both routers", () => {
    for (const file of ["src/renderer/App.tsx", "src/router.tsx"]) {
      const source = read(file);
      expect(source, file).toContain("defaultPendingComponent: RoutePending");
      expect(source, file).toMatch(/defaultPendingMs: 200/);
      expect(source, file).toMatch(/defaultPendingMinMs: 300/);
      expect(source, file).toContain("defaultErrorComponent: RouteError");
    }
    expect(read("src/components/friday/PageStates.tsx")).toContain("export function RoutePending");
  });

  it("does not open the heavy Flow Studio onto an empty screen", () => {
    const source = read("src/components/friday/FlowStudioLazy.tsx");
    expect(source).not.toContain("fallback={null}");
    expect(source).toContain("Opening Flow Studio");
  });

  it("lets the shared Button see the promise a click handler returns", () => {
    // `void` throws the promise away, so the button would never show its spinner or lock out a second click.
    const opener = /<([A-Za-z][\w.]*)\b/g;
    const offenders: string[] = [];
    for (const file of walk("src")) {
      if (file.includes("components/ui/")) continue;
      const source = read(file);
      for (const match of source.matchAll(/onClick=\{\(\) =>\s+void /g)) {
        let tag = "";
        for (const found of source.slice(0, match.index).matchAll(opener)) tag = found[1] ?? "";
        if (tag === "Button")
          offenders.push(`${file}:${source.slice(0, match.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
