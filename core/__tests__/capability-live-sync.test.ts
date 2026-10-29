/**
 * Drift guard: every capability section renders from the one shared registry
 * hook (which re-reads on the `capabilities:changed` event), never from a
 * private hardcoded list — so an install shows up instantly on every page,
 * and the brain registry refreshes on the same event for chat/voice/phone.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SECTIONS = ["agents", "skills", "tools", "modules", "workflows", "plugins"] as const;
const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("capability live sync", () => {
  it.each(SECTIONS)("%s page reads the shared capability registry", (section) => {
    const source = read(`src/routes/${section}.tsx`);
    expect(source).toContain('from "@/lib/friday/capability-trees"');
    expect(source).toContain(`useCapabilities("${section}")`);
  });

  it("the shared hook re-lists on the capabilities:changed event", () => {
    const source = read("src/lib/friday/capability-trees.ts");
    expect(source).toContain("onCapabilitiesChanged");
    expect(source).toMatch(/onCapabilitiesChanged\?\.\(\(\) => void refresh\(\)\)/);
  });

  it("the brain registry follows the same event so chat/voice/phone stay current", () => {
    const source = read("src/lib/friday/runtime.ts");
    expect(source).toContain("reloadInstalledCapabilities");
    expect(source).toContain("onCapabilitiesChanged");
    expect(source).toContain("capabilityRegistry.registerProvider");
    expect(source).toContain("modelRegistry.subscribe");
    expect(source).toContain("void listConnectors()");
    expect(source).toContain("onConnectorsChanged");
  });

  it("connector connect/disconnect re-reads the shared registry", () => {
    const source = read("src/lib/friday/connectors.ts");
    expect(source).toContain("capabilityRegistry.refresh()");
    expect(source).toMatch(/export async function connectConnector[\s\S]*await listConnectors\(\)/);
    expect(source).toMatch(
      /export async function disconnectConnector[\s\S]*await listConnectors\(\)/,
    );
  });
});
