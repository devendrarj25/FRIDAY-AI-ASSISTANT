/**
 * Chat and the Agents page must actually plan()/run() shipped packs, and
 * marketplace persona manifests must keep skills/role through discovery.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import {
  routeAgents,
  setAgentInvokeHost,
  resetAgentIndex,
} from "../../src/lib/friday/brain/agent-router";
import {
  capabilityRegistry,
  type CapabilityResource,
} from "../../src/lib/friday/brain/capability-registry";
import { packsForTree } from "../../src/lib/friday/marketplace";

const require = createRequire(import.meta.url);
const capabilities = require("../../electron/capabilities.cjs") as {
  list: (roots: { appRoot?: string | null; workspaceRoot?: string | null }) => {
    items: {
      id: string;
      tree: string;
      name: string;
      description: string;
      category: string;
      risk: "safe" | "write" | "exec";
      enabled: boolean;
      origin: string;
      entry: string | null;
      role?: string;
      skills?: string[];
    }[];
  };
  setEnabled: (roots: { workspaceRoot: string }, id: string, enabled: boolean) => { ok: boolean };
  installPack: (
    roots: { workspaceRoot: string },
    pack: unknown,
    hint?: string,
  ) => { ok: boolean; id?: string; error?: string };
};
const agents = require("../../electron/agents.cjs") as {
  plan: (
    roots: { appRoot?: string | null; workspaceRoot?: string | null },
    id: string,
    input?: unknown,
    ctx?: { allowDisabled?: boolean },
  ) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
  run: (
    roots: { appRoot?: string | null; workspaceRoot?: string | null },
    id: string,
    input?: unknown,
    ctx?: { allowDisabled?: boolean },
  ) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
};

const APP = process.cwd();
const temps: string[] = [];
const unsub: Array<() => void> = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-agent-wire-"));
  temps.push(dir);
  return dir;
};

afterEach(() => {
  setAgentInvokeHost(null);
  for (const fn of unsub.splice(0)) fn();
  capabilityRegistry.refresh();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  resetAgentIndex();
});

function resourceFromItem(item: {
  id: string;
  name: string;
  description: string;
  category: string;
  risk: "safe" | "write" | "exec";
  enabled: boolean;
  role?: string;
  skills?: string[];
}): CapabilityResource {
  const skills = item.skills ?? [];
  const role = item.role || "";
  return {
    id: `agent:${item.id}`,
    type: "agent",
    name: item.name,
    ref: item.id,
    capabilities: ["agents", item.category, role, item.name.toLowerCase(), ...skills].filter(
      Boolean,
    ),
    skills,
    role,
    available: item.enabled,
    health: item.enabled ? "ready" : "offline",
    reliability: null,
    latencyMs: null,
    cost: "free",
    permission: item.risk === "safe" ? "open" : item.risk === "exec" ? "owner-only" : "ask",
    detail: item.description,
  };
}

describe("agents discovery skills/role", () => {
  it("lifts marketplace manifest skills and role through installPack", () => {
    const workspaceRoot = temp();
    const pack = packsForTree("agents").find((item) => item.slug === "tender-analysis-agent");
    expect(pack).toBeTruthy();
    const installed = capabilities.installPack({ workspaceRoot }, pack, "agents");
    expect(installed.ok).toBe(true);
    const item = capabilities
      .list({ workspaceRoot })
      .items.find((entry) => entry.id.endsWith("tender-analysis-agent"));
    expect(item?.role).toBe("tender-analysis");
    expect(item?.skills).toEqual(["tender.read", "docs.extract", "csv.parse", "text.summarise"]);
  });
});

describe("chat invoke of shipped plan/run packs", () => {
  it("disk-space-watcher plan() then dry-run run() from cycle-shaped chat", async () => {
    const workspaceRoot = temp();
    expect(
      capabilities.setEnabled({ workspaceRoot }, "agents/core/disk-space-watcher", true).ok,
    ).toBe(true);
    const item = capabilities
      .list({ appRoot: APP, workspaceRoot })
      .items.find((entry) => entry.id === "agents/core/disk-space-watcher");
    expect(item?.enabled).toBe(true);
    expect(item?.risk).toBe("safe");
    expect(item?.entry).toBe("index.cjs");

    setAgentInvokeHost({
      plan: (id, input) => agents.plan({ appRoot: APP, workspaceRoot }, id, input),
      run: (id, input) => agents.run({ appRoot: APP, workspaceRoot }, id, input),
    });
    unsub.push(capabilityRegistry.registerProvider(() => [resourceFromItem(item!)]));
    resetAgentIndex();

    const runs = await routeAgents("use the disk-space-watcher agent please");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(true);
    expect(runs[0]!.detail).toMatch(/planned then dry-ran/);
    expect(runs[0]!.value).toMatchObject({ plan: expect.anything() });
  });
});
