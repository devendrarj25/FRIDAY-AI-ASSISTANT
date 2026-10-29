import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(__dirname, "../..");
const require_ = createRequire(import.meta.url);
const project = require_(join(root, "electron/project.cjs"));
const models = require_(join(root, "electron/models.cjs"));

/**
 * The selected FRIDAY folder is the only authoritative store. Legacy/bootstrap
 * locations may seed it once, never act as a second live store.
 */
describe("single-root storage", () => {
  it("adopts a legacy database into the selected root instead of using it in place", async () => {
    const base = mkdtempSync(join(tmpdir(), "friday-root-"));
    const userData = join(base, "bootstrap");
    const fridayRoot = join(base, "MyFRIDAY");
    mkdirSync(join(userData, "data"), { recursive: true });
    const legacy = join(userData, "data", "friday.sqlite3");
    writeFileSync(legacy, "SQLite format 3\0legacy-marker");

    const report = await project.ensureDatabase({ userData, root: fridayRoot });

    expect(report.file).toBe(join(fridayRoot, "database", "friday.sqlite3"));
    expect(existsSync(report.file)).toBe(true);
    expect(readFileSync(report.file, "utf8")).toContain("legacy-marker");
    expect(report.log.join(" ")).toContain("migrated existing database");
  });

  it("keeps FRIDAY-managed models in the root and treats other caches as external", () => {
    const base = mkdtempSync(join(tmpdir(), "friday-models-"));
    const workspace = join(base, "MyFRIDAY");
    const userData = join(base, "bootstrap");
    mkdirSync(join(workspace, "models"), { recursive: true });
    mkdirSync(join(userData, "models"), { recursive: true });

    const { roots } = models.localFolders({ workspace, userData });

    expect(roots).toContain(join(workspace, "models"));
    expect(roots).not.toContain(join(userData, "models"));
    expect(new Set(roots).size).toBe(roots.length);
  });

  it("never guesses a FRIDAY folder in the user's home directory", () => {
    const source = readFileSync(join(root, "scripts/python-runtime.cjs"), "utf8");
    expect(source).not.toMatch(/homedir\(\),\s*"FRIDAY"/);
  });
});
