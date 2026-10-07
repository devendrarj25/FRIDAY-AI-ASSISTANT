import { describe, expect, it } from "vitest";
import { resolveRoutingTask } from "@/lib/friday/brain-engine";

const run = (task: string) => ({ agents: [{ task }] }) as never;

describe("routing task", () => {
  it("uses the agent task when no capability directive is attached", () => {
    expect(resolveRoutingTask(run("coding"))).toBe("coding");
  });

  it("never falls back to a generic chat task", () => {
    expect(resolveRoutingTask({ agents: [] } as never)).toBe("brain");
  });

  it("honours explicit owner directives", () => {
    expect(resolveRoutingTask(run("brain"), "Use Deep Research")).toBe("research");
    expect(resolveRoutingTask(run("brain"), "Analyse this screenshot (vision)")).toBe("vision");
    expect(resolveRoutingTask(run("brain"), "Deep Thinking")).toBe("reasoning");
  });
});
