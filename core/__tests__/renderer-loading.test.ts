import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
// Source text is compared, not its newline style: a Windows checkout can hold
// CRLF, which must never change what the file means.
const read = (file: string) => readFileSync(resolve(root, file), "utf8").replace(/\r\n/g, "\n");

describe("packaged renderer loading", () => {
  it("has exactly one renderer loader and it resolves through app.getAppPath()", () => {
    const loader = read("electron/renderer.cjs");
    const main = read("electron/main.cjs");

    expect(loader).toMatch(/path\.join\(app\.getAppPath\(\), "dist-desktop"\)/);
    // No hardcoded install/release locations, ever.
    expect(loader).not.toMatch(/resources[\\/]app[\\/]dist-desktop/);
    expect(loader).not.toMatch(/[A-Z]:\\/);
    // The main process must not keep a second, competing load path.
    expect(main).not.toMatch(/win\.loadFile\(/);
    expect(main).toMatch(/renderer\.load\(win, \{/);
  });

  it("serves the bundle over a privileged standard scheme registered before ready", () => {
    const loader = read("electron/renderer.cjs");
    const main = read("electron/main.cjs");

    expect(loader).toMatch(/registerSchemesAsPrivileged/);
    expect(loader).toMatch(/standard: true/);
    expect(loader).toMatch(/supportFetchAPI: true/);
    expect(loader).toMatch(/protocol\.handle\(SCHEME/);
    // registerScheme() runs at module scope, i.e. before app.whenReady().
    const declare = main.indexOf("renderer.registerScheme()");
    const ready = main.indexOf("app\n  .whenReady()");
    expect(declare).toBeGreaterThan(-1);
    expect(declare).toBeLessThan(ready);
  });

  it("keeps the desktop bundle relative-path and self-contained", () => {
    const config = read("vite.electron.config.ts");
    expect(config).toMatch(/base: "\.\/"/);
    expect(config).toMatch(/outDir: resolve\(import\.meta\.dirname, "dist-desktop"\)/);
    // Stale chunks from a previous build must never survive into app.asar.
    expect(config).toMatch(/emptyOutDir: true/);
  });

  it("packages and verifies dist-desktop in the Windows build", () => {
    const builder = read("electron-builder.yml");
    const verify = read("scripts/verify-build.cjs");
    expect(builder).toMatch(/-\s*dist-desktop\/\*\*/);
    expect(verify).toMatch(/\/dist-desktop\/index\.html/);
  });

  it("logs the packaged renderer diagnostics before loading", () => {
    const loader = read("electron/renderer.cjs");
    expect(loader).toMatch(/packaged=\$\{app\.isPackaged\}/);
    expect(loader).toMatch(/appPath=\$\{appPath\}/);
    expect(loader).toMatch(/rendererExists=\$\{exists\}/);
  });
});
