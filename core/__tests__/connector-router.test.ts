import { describe, expect, it } from "vitest";
import { chooseConnectors, connectorMentioned } from "../../src/lib/friday/brain/connector-router";
import type { ConnectorTool } from "../../src/lib/friday/connectors";

const tool = (
  connectorId: string,
  connectorName: string,
  action: { id: string; label: string; risk: "safe" | "write" | "exec" },
  connected = true,
): ConnectorTool => ({
  tool: `connector.${connectorId}.${action.id}`,
  connectorId,
  connectorName,
  action: { ...action, inputs: action.risk === "write" ? ["message"] : [] },
  connected,
});

const catalog: ConnectorTool[] = [
  tool("microsoft-teams", "Microsoft Teams", { id: "chats", label: "List chats", risk: "safe" }),
  tool("microsoft-teams", "Microsoft Teams", {
    id: "post",
    label: "Send a chat message",
    risk: "write",
  }),
  tool("slack", "Slack", { id: "channels", label: "List channels", risk: "safe" }),
  tool("slack", "Slack", { id: "post", label: "Post a message", risk: "write" }),
  tool("github", "GitHub", { id: "repos", label: "List my repositories", risk: "safe" }, false),
];

describe("connector router", () => {
  it("treats Teams as Microsoft Teams even when the full name is not typed", () => {
    expect(
      connectorMentioned("post to teams", { id: "microsoft-teams", name: "Microsoft Teams" }),
    ).toBe(true);
    expect(
      connectorMentioned("list teams chats", { id: "microsoft-teams", name: "Microsoft Teams" }),
    ).toBe(true);
    expect(
      connectorMentioned("good morning", { id: "microsoft-teams", name: "Microsoft Teams" }),
    ).toBe(false);
  });

  it("auto-picks only safe connected actions that the prompt names", () => {
    const picked = chooseConnectors("list teams chats", catalog);
    expect(picked.map((row) => row.tool)).toEqual(["connector.microsoft-teams.chats"]);
  });

  it("never auto-picks write actions or disconnected services", () => {
    expect(chooseConnectors("post a message to Slack", catalog)).toEqual([]);
    expect(chooseConnectors("list my github repositories", catalog)).toEqual([]);
  });
});
