/**
 * Names that were never defined are ReferenceErrors that only show up when the feature runs. The CommonJS main
 * process, scripts and tools used to be formatted but not checked, so these two went unseen:
 *  - the plugin import path called `pluginPack`, which main.cjs never loaded (every plugin import threw);
 *  - the Algolia connector read `fields` inside a callback that did not receive it (verifying a key on an
 *    account with no indexes failed with "fields is not defined").
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("references that must exist at run time", () => {
  it("main.cjs loads the plugin pack it uses, and the pack has what is called on it", () => {
    const main = read("electron/main.cjs");
    expect(main).toMatch(
      /const pluginPack = loadNamed\("plugin-pack", \(\) => require\("\.\/plugin-pack\.cjs"\)\);/,
    );
    const pack = require(path.join(root, "electron", "plugin-pack.cjs"));
    for (const name of main.matchAll(/\bpluginPack\.(\w+)/g)) {
      expect(typeof pack[name[1]!], `pluginPack.${name[1]}`).toBe("function");
    }
  });

  it("every connector verify callback gets the saved fields it may read", () => {
    const connectors = require(path.join(root, "electron", "connectors.cjs"));
    const algolia = connectors.CONNECTORS.algolia.verify;
    // An empty index list used to fall through to `fields.appId` with no `fields` in scope.
    expect(algolia.account({ items: [] }, { appId: "APP123" })).toBe("APP123");
    expect(algolia.account({ items: [{ name: "products" }] }, { appId: "APP123" })).toBe(
      "products",
    );
    expect(read("electron/connectors.cjs")).toContain("spec.verify.account?.(body, fields)");
  });

  it("the CommonJS and module files are linted for undefined names", () => {
    const config = read("eslint.config.js");
    expect(config).toContain('files: ["**/*.cjs", "**/*.mjs"]');
    expect(config).toContain("...js.configs.recommended.rules");
  });
});
