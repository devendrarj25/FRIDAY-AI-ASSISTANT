import { describe, expect, it } from "vitest";
import { graphFromWatch } from "../../src/lib/friday/flow-graph";
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
});
