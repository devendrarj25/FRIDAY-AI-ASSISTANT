/**
 * Proof for the two gaps closed in this pass:
 *
 *  1. a WSL / Windows Sandbox engine install that reports restartRequired now
 *     goes through the ONE persistent restart notice (noteRestartRequired →
 *     "app:restart-required" banner), the same path the phone-companion toggle
 *     uses — not a toast that disappears on navigation;
 *  2. a connected connector's declared actions are real, callable tools: a
 *     plain chat sentence resolves to a connector action, and a state-changing
 *     one is exec-tier so brain/action-risk.ts gates it exactly like any other
 *     write/exec tool call.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import {
  connectorTools,
  invokeApprovedConnectorAction,
  listConnectors,
  type Connector,
} from "../../src/lib/friday/connectors";
import { actionNeedsApproval } from "../../src/lib/friday/brain/action-risk";

const ROOT = path.resolve(__dirname, "..", "..");

const slack: Connector = {
  id: "slack",
  name: "Slack",
  category: "communication",
  description: "Post messages.",
  help: "",
  fields: [],
  actions: [
    { id: "channels", label: "List channels", risk: "safe", inputs: [] },
    { id: "post", label: "Post a message", risk: "write", inputs: ["channel", "message"] },
  ],
  configured: true,
  connected: true,
  account: "devendra",
  lastVerifiedAt: Date.now(),
  lastError: "",
};

describe("sandbox engine install uses the persistent restart notice", () => {
  it("routes a restartRequired engine install through noteRestartRequired", () => {
    const main = fs.readFileSync(path.join(ROOT, "electron/main.cjs"), "utf8");
    const handler = main.slice(main.indexOf('ipcMain.handle("sandbox-lab:install-engine"'));
    const body = handler.slice(0, handler.indexOf("ipcMain.handle", 10));
    expect(body).toContain("result.restartRequired");
    expect(body).toContain("noteRestartRequired(");
    // The notice must be the shared one that emits the persistent banner.
    expect(main).toContain('send("app:restart-required", state)');
  });
});

describe("connector actions are ordinary, gated tool calls", () => {
  const calls: { id: string; action: string; params: Record<string, unknown> }[] = [];

  beforeEach(async () => {
    (globalThis as { window?: unknown }).window = {
      friday: {
        isDesktop: true,
        listConnectors: async () => ({ ok: true, connectors: [slack] }),
        callConnector: async (id: string, action: string, params: Record<string, unknown>) => {
          calls.push({ id, action, params });
          return { ok: true, label: "Post a message", lines: ["posted to #general"], ms: 12 };
        },
      },
    };
    calls.length = 0;
    await listConnectors();
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("flattens every declared action into the shared tool list", () => {
    expect(connectorTools().map((t) => t.tool)).toEqual([
      "connector.slack.channels",
      "connector.slack.post",
    ]);
  });

  it("turns a plain chat request into an exec-tier connector tool call", () => {
    const reply = baselineRespond("post this message to Slack: ship it");
    expect(reply.handled).toBe(true);
    expect(reply.action?.kind).toBe("connector");
    expect(reply.action?.tool).toBe("connector.slack.post");
    expect(reply.action?.risk).toBe("exec");
    expect(reply.action?.args["message"]).toBe("ship it");
    // Same gate as every other write/exec tool: approval in manual AND auto.
    expect(actionNeedsApproval("exec", "manual")).toBe(true);
    expect(actionNeedsApproval("exec", "auto")).toBe(true);
  });

  it("read-only connector actions stay safe tier", () => {
    const reply = baselineRespond("list my Slack channels");
    expect(reply.action?.tool).toBe("connector.slack.channels");
    expect(reply.action?.risk).toBe("safe");
  });

  it("runs the approved action against the real connector bridge", async () => {
    const tool = connectorTools().find((t) => t.tool === "connector.slack.post")!;
    const result = await invokeApprovedConnectorAction(tool, { message: "ship it" });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ id: "slack", action: "post", params: { message: "ship it" } }]);
  });
});
