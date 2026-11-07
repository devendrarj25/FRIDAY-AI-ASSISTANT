/** Managing plugins by chat: reads are free, on/off goes through the approval gate, and only talk that names "plugin" counts. */
import { describe, expect, it } from "vitest";
import {
  managePlugins,
  parsePluginCommand,
  resolvePlugin,
  type ManagedPlugin,
  type PluginManagerHost,
} from "../../src/lib/friday/brain/plugin-manager";

const P = (
  id: string,
  name: string,
  enabled: boolean,
  permissions: string[] = [],
): ManagedPlugin => ({
  id: `plugins/installed/${id}`,
  name,
  category: "session",
  enabled,
  summary: `${name} summary`,
  shipped: true,
  permissions,
});
const PLUGINS = [
  P("break-reminder", "Break reminder", true),
  P("secret-leak-radar", "Secret leak radar", false, ["fs.read"]),
  P("error-digest", "Error digest", true),
  P("error-recovery-rate", "Error recovery rate", true),
];

function host(state: "done" | "waiting" | "rejected" = "done") {
  const calls: string[] = [];
  const h: PluginManagerHost = {
    list: async () => PLUGINS,
    insights: async () => [
      {
        id: PLUGINS[0]!.id,
        name: "Break reminder",
        enabled: true,
        level: "warn",
        title: "Take a break",
        text: "100 minutes.",
        metrics: {},
        at: 1,
      },
    ],
    setEnabled: async (p, e) => {
      calls.push(`${p.id}:${e}`);
      return { ok: true };
    },
    gate: async (_t, _r, _k, _e, apply) => {
      if (state === "done") await apply();
      return { state, detail: "x" };
    },
  };
  return { h, calls };
}

describe("plugin manager", () => {
  it("only plugin talk is a command", () => {
    expect(parsePluginCommand("turn off the break reminder plugin")).toEqual({
      kind: "disable",
      target: "break reminder",
    });
    expect(parsePluginCommand("secret leak radar plugin on karo")).toEqual({
      kind: "enable",
      target: "secret leak radar",
    });
    expect(parsePluginCommand("what did my plugins notice")).toEqual({ kind: "insights" });
    expect(parsePluginCommand("what plugins do you have")).toMatchObject({ kind: "list" });
    expect(parsePluginCommand("tell me about the error digest plugin")).toEqual({
      kind: "info",
      target: "error digest",
    });
    for (const p of [
      "turn off the lights",
      "good morning",
      "disable the secret scan skill",
      "I wrote a plugin for vscode yesterday and it was fun",
    ])
      expect(parsePluginCommand(p), p).toBeNull();
  });

  it("resolves exact, partial and ambiguous names", () => {
    expect(resolvePlugin("break reminder", PLUGINS)).toMatchObject({
      plugin: { name: "Break reminder" },
    });
    expect(resolvePlugin("leak", PLUGINS)).toMatchObject({ plugin: { name: "Secret leak radar" } });
    expect(resolvePlugin("error", PLUGINS)).toHaveProperty("candidates");
    expect(resolvePlugin("nope", PLUGINS)).toHaveProperty("none");
  });

  it("lists, reports insights and describes without changing anything", async () => {
    const { h, calls } = host();
    expect((await managePlugins("show my plugins", h))!.text).toMatch(/4 plugin\(s\): 3 on, 1 off/);
    expect((await managePlugins("what did my plugins notice", h))!.text).toMatch(
      /WARNING Break reminder/,
    );
    expect((await managePlugins("what does the secret leak radar plugin do", h))!.text).toMatch(
      /permissions: fs\.read/,
    );
    expect(calls).toEqual([]);
  });

  it("changes a plugin only through the gate, and says when it is still waiting", async () => {
    const done = host("done");
    const r = await managePlugins("enable the secret leak radar plugin", done.h);
    expect(r).toMatchObject({ ok: true });
    expect(done.calls).toEqual(["plugins/installed/secret-leak-radar:true"]);
    const waiting = host("waiting");
    const w = await managePlugins("disable the break reminder plugin", waiting.h);
    expect(w!.text).toMatch(/NOT been done/);
    expect(waiting.calls).toEqual([]);
    const no = await managePlugins("disable the break reminder plugin", host("rejected").h);
    expect(no!.ok).toBe(false);
    expect((await managePlugins("turn on the break reminder plugin", done.h))!.text).toMatch(
      /already on/,
    );
  });
});
