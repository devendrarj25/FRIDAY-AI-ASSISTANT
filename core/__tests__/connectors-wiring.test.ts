/**
 * Connectors section wiring: boot loads the live list, Core Brain routes
 * connected+safe actions, composer chips do not invent fake services.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildCapabilityGroups } from "../../src/lib/friday/capabilities";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const scan = {
  root: "C:/FRIDAY",
  exists: true,
  valid: true,
  present: [],
  missing: [],
  scannedAt: Date.now(),
  skills: [],
  plugins: [],
  agents: [],
  workflows: [],
  tools: [],
  modules: [],
} as never;

describe("connectors system wiring", () => {
  it("boots the live connector list so chat does not wait for /connectors", () => {
    const runtime = read("src/lib/friday/runtime.ts");
    expect(runtime).toContain("void listConnectors()");
    expect(runtime).toContain("onConnectorsChanged");
  });

  it("Core Brain routes connectors through the one router and FLOW_CHART node", () => {
    const core = read("src/lib/friday/brain/core-brain.ts");
    const chart = read("src/lib/friday/flow-chart.ts");
    expect(core).toContain("routeConnectors");
    expect(core).toContain('stage?.("agents.connectors"');
    expect(core).toContain('tool: "connector"');
    expect(core).toContain("!connectorRuns.length");
    expect(chart).toContain("agents.connectors");
    expect(chart).toContain("bus.connectors");
    expect(chart).toContain("src/lib/friday/brain/connector-router.ts");
  });

  it("composer chips do not invent Ollama or Hugging Face as connectors", () => {
    const groups = buildCapabilityGroups(null, scan);
    const connectors = groups.find((group) => group.kind === "connectors");
    expect(connectors).toBeUndefined();
    const capabilities = read("src/lib/friday/capabilities.ts");
    expect(capabilities).not.toContain("BUILTIN_CONNECTORS");
    expect(capabilities).toContain("knownConnectors()");
  });

  it("Disconnect is available after a failed probe, not only when Connected", () => {
    const page = read("src/routes/connectors.tsx");
    expect(page).toContain(
      "connector.connected || connector.configured || Boolean(connector.lastError)",
    );
    expect(page).toContain("seenFields !== fieldKey");
    expect(page).toContain(
      "setValues(Object.fromEntries(connector.fields.map((f) => [f.id, f.value])))",
    );
  });
});
