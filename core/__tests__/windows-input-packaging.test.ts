import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const require_ = createRequire(import.meta.url);
const { TREES } = require_(resolve(root, "electron/friday-contract.cjs")) as {
  TREES: Record<string, unknown>;
};

/** Packed with the EXE. `models` is owner-downloaded under FRIDAY_ROOT, not extraResources. */
const PACKED_TREES = Object.keys(TREES).filter((tree) => tree !== "models");

describe("Windows input-safe packaging", () => {
  it("keeps both packaged application targets at normal-user execution", () => {
    const builder = read("electron-builder.yml");
    const brander = read("scripts/brand-windows.cjs");

    expect(builder).toMatch(/requestedExecutionLevel:\s*asInvoker/);
    expect(builder).toMatch(/requestExecutionLevel:\s*user/);
    expect(brander).toMatch(/"requested-execution-level":\s*"asInvoker"/);
    expect(brander).not.toMatch(/"requested-execution-level":\s*"requireAdministrator"/);
  });

  it("preserves Windows text services and the frameless no-drag boundary", () => {
    const main = read("electron/main.cjs");
    const styles = read("src/styles.css");
    const shell = read("src/components/friday/AppShell.tsx");

    expect(main).not.toMatch(/disable-features[\s\S]{0,300}TSFImeSupport/);
    expect(styles).toMatch(/\.friday-interactive-region,[\s\S]*-webkit-app-region:\s*no-drag/);
    expect(shell).toContain('className="friday-interactive-region flex min-h-0 flex-1"');
    expect(styles).toMatch(/body\s*\{[\s\S]*-webkit-app-region:\s*no-drag/);
    expect(styles).toMatch(/input,[\s\S]*pointer-events:\s*auto[\s\S]*app-region:\s*no-drag/);
  });
  it("mounts the desktop renderer without a nested document shell", () => {
    const config = read("vite.electron.config.ts");
    const rootRoute = read("src/routes/__root.tsx");

    // A second <html>/<body> inside #root makes React resolve selectionchange
    // against the wrong container and hard-locks the renderer.
    expect(config).toMatch(/"import\.meta\.env\.VITE_DESKTOP_SHELL":\s*JSON\.stringify\("1"\)/);
    expect(rootRoute).toMatch(/VITE_DESKTOP_SHELL"\]\s*===\s*"1"/);
    expect(rootRoute).toMatch(/if \(DESKTOP_SHELL\)/);
  });

  it("packs every capability tree as extraResources and discovers them from process.resourcesPath", () => {
    const builder = read("electron-builder.yml");
    const main = read("electron/main.cjs");
    for (const tree of PACKED_TREES) {
      expect(builder).toContain(`from: ${tree}`);
      expect(builder).toContain(`to: ${tree}`);
    }
    expect(main).toContain("packagedCapabilityRoot");
    expect(main).toContain("process.resourcesPath");
  });

  it("allows session media on a normal launch and disables GPU only for the boot self-test", () => {
    const main = read("electron/main.cjs");
    expect(main).toMatch(/if \(permission === "media"\)/);
    expect(main).toContain("callback(false)");
    expect(main).toMatch(
      /if \(process\.env\.FRIDAY_BOOT_SELFTEST\) \{[\s\S]*disableHardwareAcceleration/,
    );
    const beforeSelftest = main.slice(0, main.indexOf("if (process.env.FRIDAY_BOOT_SELFTEST)"));
    expect(beforeSelftest).not.toContain("disableHardwareAcceleration");
  });
});
