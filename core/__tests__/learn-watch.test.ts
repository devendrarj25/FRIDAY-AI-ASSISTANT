import { describe, expect, it } from "vitest";
import { graphFromWatch, openWatch, pushWatch, revokeWatch } from "../../src/lib/friday/flow-graph";
import { createFakeDesktop, runComputerUse } from "../../src/lib/friday/self/computer-use";

describe("learn by watching", () => {
  it("refuses without consent, drops secrets, and replays the rest", async () => {
    const steps = [
      { kind: "click" as const, target: "Save" },
      { kind: "type" as const, target: "Password", payload: "hunter2", role: "password" },
      { kind: "type" as const, target: "Body", payload: "hello" },
    ];
    expect(graphFromWatch(steps, { consent: false }).ok).toBe(false);
    const built = graphFromWatch(steps, { consent: true, title: "Notes save" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.graph.trusted).toBe(false);
    expect(built.graph.nodes).toHaveLength(2);
    expect(built.graph.edges).toHaveLength(1);
    expect(built.graph.nodes.every((node) => node.source.adapter === "demonstration")).toBe(true);
    const packed = JSON.stringify(built);
    expect(packed).not.toContain("hunter2");
    expect(packed).not.toContain("Password");
    expect(built.request).toBe("click Save\ntype hello into Body");

    const desktop = createFakeDesktop({
      windows: [
        {
          id: "notes",
          title: "Notes",
          monitor: 1,
          dpi: 96,
          crashed: false,
          sight: "uia",
          controls: [
            {
              id: "save",
              role: "button",
              name: "Save",
              value: "",
              bounds: { x: 1, y: 1, w: 10, h: 10 },
            },
            {
              id: "body",
              role: "edit",
              name: "Body",
              value: "",
              bounds: { x: 1, y: 20, w: 40, h: 10 },
            },
          ],
        },
      ],
      focusedId: "notes",
    });
    const report = await runComputerUse({
      request: built.request,
      level: "full",
      halted: false,
      source: "flow",
      desktop,
      now: () => 10,
      sleep: async () => undefined,
    });
    expect(report.ok).toBe(true);
    expect(report.evidence.every((row) => row.checked)).toBe(true);
    expect(
      desktop.state.windows[0]?.controls.find((control) => control.name === "Body")?.value,
    ).toBe("hello");
  });

  it("drops the recording when consent is revoked, and omits secret steps", () => {
    let session = openWatch();
    session = pushWatch(session, { kind: "click", target: "Save" });
    session = pushWatch(session, {
      kind: "type",
      target: "Password",
      payload: "hunter2",
      role: "password",
    });
    session = revokeWatch(session);
    session = pushWatch(session, { kind: "type", target: "Body", payload: "later" });
    expect(session.consent).toBe(false);
    expect(session.steps).toEqual([]);
    expect(graphFromWatch(session.steps, { consent: session.consent }).ok).toBe(false);
    expect(JSON.stringify(session)).not.toContain("hunter2");

    const built = graphFromWatch(
      [
        { kind: "click", target: "Save" },
        { kind: "type", target: "Card number", payload: "4242", role: "payment" },
        { kind: "click", target: "Captcha", role: "captcha" },
        { kind: "type", target: "Body", payload: "api key: abcdefghijklmnop" },
        { kind: "type", target: "Body", payload: "token: abcdef" },
      ],
      { consent: true },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const packed = JSON.stringify(built);
    expect(packed).not.toContain("4242");
    expect(packed).not.toContain("abcdefghijklmnop");
    expect(packed).not.toContain("abcdef");
    expect(packed).toContain("[redacted]");
    expect(built.graph.nodes).toHaveLength(2);
  });

  it("stops a replay when the world changed, and when stop everything flips on", async () => {
    const built = graphFromWatch(
      [
        { kind: "click", target: "Save" },
        { kind: "type", target: "Body", payload: "hello" },
      ],
      { consent: true },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const missing = createFakeDesktop({
      windows: [
        {
          id: "notes",
          title: "Notes",
          monitor: 1,
          dpi: 96,
          crashed: false,
          sight: "uia",
          controls: [
            {
              id: "body",
              role: "edit",
              name: "Body",
              value: "",
              bounds: { x: 1, y: 20, w: 40, h: 10 },
            },
          ],
        },
      ],
      focusedId: "notes",
    });
    const changed = await runComputerUse({
      request: built.request,
      level: "full",
      halted: false,
      source: "flow",
      desktop: missing,
      now: () => 10,
      sleep: async () => undefined,
    });
    expect(changed.ok).toBe(false);
    expect(changed.stoppedReason).toBe("verify-failed");
    expect(
      missing.state.windows[0]?.controls.find((control) => control.name === "Body")?.value,
    ).toBe("");

    const desktop = createFakeDesktop({
      windows: [
        {
          id: "notes",
          title: "Notes",
          monitor: 1,
          dpi: 96,
          crashed: false,
          sight: "uia",
          controls: [
            {
              id: "save",
              role: "button",
              name: "Save",
              value: "",
              bounds: { x: 1, y: 1, w: 10, h: 10 },
            },
            {
              id: "body",
              role: "edit",
              name: "Body",
              value: "",
              bounds: { x: 1, y: 20, w: 40, h: 10 },
            },
          ],
        },
      ],
      focusedId: "notes",
    });
    let stop = false;
    const stopped = await runComputerUse({
      request: built.request,
      level: "full",
      halted: false,
      isHalted: () => stop,
      source: "flow",
      desktop: {
        state: desktop.state,
        perceive: (at) => desktop.perceive(at),
        act: async (action, at) => {
          const outcome = await desktop.act(action, at);
          stop = true;
          return outcome;
        },
      },
      now: () => 10,
      sleep: async () => undefined,
    });
    expect(stopped.ok).toBe(false);
    expect(stopped.stoppedReason).toBe("halted");
    expect(
      desktop.state.windows[0]?.controls.find((control) => control.name === "Body")?.value,
    ).toBe("");
  });
});
