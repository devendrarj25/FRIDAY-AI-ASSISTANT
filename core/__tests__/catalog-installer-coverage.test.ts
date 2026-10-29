/**
 * Every Install Manager row must reach a REAL installer.
 *
 * The renderer dispatches `runToolJob({ id: entry.pkg })`, and
 * electron/toolchain.cjs fails with `unknown package "<id>"` when no tool (or
 * catalog alias) answers for that id. This test locks that contract so a new
 * catalog row can never ship as an un-installable button again.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { catalog } from "../../src/lib/friday/catalog";

const require_ = createRequire(import.meta.url);
const toolchain = require_("../../electron/toolchain.cjs") as {
  TOOLS: Array<{ id: string }>;
  toolById?: (id: string) => unknown;
};

const ids = new Set(toolchain.TOOLS.map((t) => t.id));
const source = require_("node:fs").readFileSync(
  require_("node:path").join(process.cwd(), "electron", "toolchain.cjs"),
  "utf8",
) as string;
const aliasBlock = source.slice(
  source.indexOf("const CATALOG_ALIAS"),
  source.indexOf("const DISPLAY_IDS"),
);
const alias = new Map(
  [...aliasBlock.matchAll(/\[\s*"([^"]+)",\s*"([^"]+)"\s*\]/g)].map((m) => [
    m[1] as string,
    m[2] as string,
  ]),
);

const resolvable = (pkg: string) => ids.has(pkg) || ids.has(alias.get(pkg) ?? "");

describe("install manager catalog coverage", () => {
  it("backs every non-credential catalog row with a real installer", () => {
    const orphans = catalog
      .filter((e) => e.method !== "api-key")
      .map((e) => e.pkg)
      .filter((pkg) => !resolvable(pkg));
    expect(orphans).toEqual([]);
  });

  it("offers the dependencies real kernel code needs", () => {
    for (const pkg of [
      "datasets",
      "bleak (Bluetooth LE)",
      "zeroconf (mDNS discovery)",
      "edge-tts",
      "faster-whisper",
      "NumPy",
      "ChromaDB",
      "Deno",
      "TypeScript",
      "NSIS",
      "npm",
      "7-Zip",
      "Hugging Face CLI",
      "WebView2 Runtime",
      "ripgrep",
    ]) {
      expect(catalog.some((e) => e.pkg === pkg)).toBe(true);
      expect(resolvable(pkg)).toBe(true);
    }
  });
});
