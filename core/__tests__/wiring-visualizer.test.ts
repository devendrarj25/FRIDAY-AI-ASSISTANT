/**
 * Live wiring visualizer: FLOW_CHART is the only map; locked nodes cannot
 * grow a switch; a real switch goes through governance and re-probes.
 */
import { describe, expect, it } from "vitest";
import { FLOW_CHART, flowNodes } from "../../src/lib/friday/flow-chart";
import { autonomy } from "../../src/lib/friday/self/autonomy";
import { governance } from "../../src/lib/friday/self/governance";
import {
  capabilityRegistry,
  resourceRunnable,
} from "../../src/lib/friday/brain/capability-registry";
import {
  LOCKED_WIRING_NODE_IDS,
  describeWiringLive,
  probeWiring,
  requestWiringSwitch,
  wiringNodeLocked,
  wiringPanel,
  wiringSwitchable,
} from "../../src/lib/friday/wiring";
import {
  looksLikeLockedWiringSwitch,
  looksLikeWiringQuestion,
} from "../../src/lib/friday/wiring-ask";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const wait = async (predicate: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("wiring visualizer", () => {
  it("probes every FLOW_CHART node and never invents a second map", () => {
    const report = probeWiring();
    expect(report.nodes.length).toBe(flowNodes().length);
    expect(report.nodes.every((node) => node.status.trim().length > 0)).toBe(true);
    expect(report.nodes.every((node) => node.module.trim().length > 0)).toBe(true);
  });

  it("locks the permission layer plus billing and tool-authority in code", () => {
    const permission = FLOW_CHART.find((layer) => layer.id === "permission");
    expect(permission).toBeDefined();
    for (const node of permission!.nodes) {
      expect(wiringNodeLocked(node.id), node.id).toBe(true);
      expect(wiringSwitchable(node.id), node.id).toBe(false);
    }
    for (const id of LOCKED_WIRING_NODE_IDS) {
      expect(
        flowNodes().some((node) => node.id === id),
        id,
      ).toBe(true);
      expect(wiringSwitchable(id), id).toBe(false);
    }
    expect(wiringNodeLocked("owner.identity")).toBe(true);
    expect(wiringNodeLocked("improve.approval")).toBe(true);
    expect(wiringNodeLocked("supervisor.approval")).toBe(true);
    expect(wiringSwitchable("owner.autonomy")).toBe(true);
  });

  it("refuses a locked switch without filing governance", () => {
    const before = governance.pending().length;
    const refused = requestWiringSwitch("permission.broker", false);
    expect(refused.submitted).toBe(false);
    expect(refused.detail).toMatch(/locked/i);
    expect(governance.pending().length).toBe(before);
    expect(requestWiringSwitch("permission.billing", false).submitted).toBe(false);
    expect(requestWiringSwitch("permission.authority", false).submitted).toBe(false);
  });

  it("applies a non-locked switch only after approval, then re-probes", async () => {
    wiringPanel.reset();
    const original = autonomy.getSnapshot().autonomyEnabled;
    autonomy.update({ autonomyEnabled: true });
    const requested = requestWiringSwitch("owner.autonomy", false);
    expect(requested.submitted).toBe(true);
    await wait(() =>
      governance.pending().some((item) => item.title === "Wiring: Background autonomy off"),
    );
    expect(autonomy.getSnapshot().autonomyEnabled).toBe(true);
    const item = governance
      .pending()
      .find((entry) => entry.title === "Wiring: Background autonomy off");
    expect(item?.kind).toBe("system");
    expect(item?.stage).toBe("waiting-approval");
    governance.approve(item!.id);
    await wait(() => autonomy.getSnapshot().autonomyEnabled === false);
    await wait(() => (wiringPanel.getSnapshot().lastResult?.detail ?? "").includes("now off"));
    const probe = probeWiring().nodes.find((node) => node.id === "owner.autonomy");
    expect(probe?.switchOn).toBe(false);
    expect(probe?.status).toMatch(/off/i);
    autonomy.update({ autonomyEnabled: original });
  });

  it("opens the panel and quotes real node errors from the probe, not a generic line", () => {
    wiringPanel.reset();
    const text = describeWiringLive();
    expect(wiringPanel.getSnapshot().open).toBe(true);
    expect(text).toMatch(/FLOW_CHART/);
    expect(text).toMatch(/locked/);
    expect(text.includes("something's wrong")).toBe(false);
  });

  it("recognises the voice/chat phrase and refuses locked-path wording", () => {
    expect(looksLikeWiringQuestion("show me the system wiring")).toBe(true);
    expect(
      looksLikeWiringQuestion('Tell me about your system "System wiring" and its current state.'),
    ).toBe(true);
    expect(looksLikeWiringQuestion("write me a poem")).toBe(false);
    expect(looksLikeLockedWiringSwitch("disable the privacy firewall")).toBe(true);
    expect(looksLikeLockedWiringSwitch("show me the system wiring")).toBe(false);
  });
});

describe("cross-surface capability registry", () => {
  it("registers system wiring once so Manual, Auto, and the phone see the same row", () => {
    const snapshot = capabilityRegistry.refresh();
    const wiring = snapshot.resources.find((resource) => resource.ref === "system-wiring");
    expect(wiring).toBeDefined();
    expect(wiring?.type).toBe("system");
    expect(resourceRunnable(wiring!)).toBe(false);
    expect(wiring?.detail).toMatch(/approval/i);
  });

  it("publishes the per-resource runnable flag from the one registry, not a phone allowlist", () => {
    const shell = readFileSync(
      resolve(process.cwd(), "src/components/friday/AppShell.tsx"),
      "utf8",
    );
    expect(shell).toContain("capabilityRegistry.getSnapshot()");
    expect(shell).toContain("resourceRunnable(r)");
    expect(shell).not.toContain("const RUNNABLE");
    const companion = readFileSync(resolve(process.cwd(), "kernel/companion.py"), "utf8");
    expect(companion).toContain("typeof c.runnable==='boolean'");
    expect(companion).not.toContain("const RUNNABLE=");
  });
});
