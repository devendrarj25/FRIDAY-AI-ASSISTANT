import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { load as parseYaml } from "js-yaml";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
const paths = require_(path.join(ROOT, "electron/resource-paths.cjs")) as {
  WATCHED: string[];
  configHealth: () => { name: string; degraded: boolean; error: string }[];
  clearConfigCache: () => void;
};
const TABLES = ["sensitive-markers.json", "hinglish-lexicon.json"];
const proc = process as unknown as { resourcesPath?: string };
const saved = proc.resourcesPath;

afterEach(() => {
  proc.resourcesPath = saved as string;
  paths.clearConfigCache();
});

describe("run-time config tables are watched and shipped", () => {
  it("watches both tables and finds them in the checkout", () => {
    for (const name of TABLES) {
      expect(paths.WATCHED).toContain(name);
      expect(fs.existsSync(path.join(ROOT, "config", name))).toBe(true);
    }
  });

  it("ships config/ whole, with neither table filtered out", () => {
    const spec = parseYaml(fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8")) as {
      extraResources: ({ from: string; to?: string; filter?: string[] } | string)[];
    };
    const config = spec.extraResources.find(
      (item) => typeof item !== "string" && item.from === "config",
    ) as { filter?: string[] };
    expect(config).toBeTruthy();
    const filter = config.filter || ["**/*"];
    expect(filter).toContain("**/*");
    for (const name of TABLES) expect(filter).not.toContain(`!${name}`);
  });

  it("reports a missing table as a degraded row that Doctor turns into a repair hint", () => {
    const rows = paths.configHealth();
    expect(TABLES.every((name) => rows.some((row) => row.name === name && !row.degraded))).toBe(
      true,
    );
    const hidden = fs.mkdtempSync(path.join(os.tmpdir(), "friday-hidden-"));
    const reader = require_(path.join(ROOT, "electron/resource-paths.cjs")) as {
      inspectConfig: (name: string) => { degraded: boolean; error: string };
    };
    paths.clearConfigCache();
    const gone = reader.inspectConfig("sensitive-markers-missing.json");
    expect(gone.degraded).toBe(true);
    expect(gone.error).toBe("not found");
    fs.rmSync(hidden, { recursive: true, force: true });
    const doctor = fs.readFileSync(path.join(ROOT, "electron/diagnostics.cjs"), "utf8");
    expect(doctor).toMatch(/Reinstall FRIDAY\. Setup copies config next to the app\./);
    expect(doctor).toMatch(/\$\{row\.name\}: \$\{row\.error \|\| "missing"\}/);
  });
});
