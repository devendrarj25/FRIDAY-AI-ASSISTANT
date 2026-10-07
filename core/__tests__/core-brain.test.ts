import { describe, expect, it } from "vitest";
import { coreBrain, taskKind } from "../../src/lib/friday/brain/core-brain";
import { capabilityMatrix } from "../../src/lib/friday/self/capability-matrix";

describe("FRIDAY Core Brain", () => {
  it("classifies task kinds it routes against", () => {
    expect(taskKind("fix this typescript error")).toBe("code");
    expect(taskKind("latest news about ollama")).toBe("research");
    expect(taskKind("open notepad")).toBe("system");
    expect(taskKind("hello")).toBe("chat");
  });

  it("only routes to the web when the request needs live facts", () => {
    expect(coreBrain.needsWeb("search the web for vite 7 release notes")).toBe(true);
    expect(coreBrain.needsWeb("what is the current ollama release")).toBe(true);
    expect(coreBrain.needsWeb("write a haiku about rain")).toBe(false);
  });

  it("prepares a turn with FRIDAY's own system prompt and never fakes tools", async () => {
    const cognition = await coreBrain.cognize("write a haiku about rain", {
      mode: "manual",
      allowTools: false,
    });
    expect(cognition.taskId).toMatch(/^brain-/);
    expect(cognition.system).toContain("FRIDAY");
    expect(cognition.routing).toMatch(/dispatchRole/);
    expect(cognition.tools).toHaveLength(0);
    expect(cognition.sources).toHaveLength(0);
    expect(cognition.understanding?.resolvedIntent.kind).toBeTruthy();
    expect(cognition.understanding?.understandingConfidence).toBeGreaterThan(0.5);
    expect(cognition.notes.join(" ")).toMatch(/understood as/);
  });

  it("reports that web search is unavailable instead of inventing results", async () => {
    const cognition = await coreBrain.cognize("what is the latest ollama version", {
      mode: "manual",
    });
    expect(cognition.sources).toHaveLength(0);
    expect(cognition.notes.join(" ")).toMatch(/unavailable|failed|nothing/i);
  });

  it("verifies answers honestly", async () => {
    const cognition = await coreBrain.cognize("explain closures", {
      mode: "manual",
      allowTools: false,
    });
    expect(coreBrain.verify(cognition, "A closure captures its scope.", true).ok).toBe(true);
    const empty = coreBrain.verify(cognition, "", true);
    expect(empty.ok).toBe(false);
    expect(empty.issues.join(" ")).toMatch(/no answer/i);
    const failed = coreBrain.verify(cognition, "here you go", false, "model offline");
    expect(failed.ok).toBe(false);
  });

  it("keeps measured routing preferences deterministic", () => {
    const ordered = coreBrain.preferred("code", ["a", "b"]);
    expect(ordered).toHaveLength(2);
    expect(new Set(ordered)).toEqual(new Set(["a", "b"]));
  });

  it("feeds live registries into self-status questions instead of a static string", async () => {
    capabilityMatrix.reset();
    const smart = await coreBrain.cognize("how smart are you right now", {
      mode: "manual",
      allowTools: false,
    });
    expect(smart.system).toMatch(/FRIDAY live registries/);
    expect(smart.system).toMatch(/capability matrix/i);
    expect(smart.system).toMatch(/provisional \(declared baseline, no measured runs yet\)/);
    expect(smart.system).toMatch(/Coding: 60\/100/);
    expect(smart.notes.join(" ")).toMatch(/live registries/i);

    const can = await coreBrain.cognize("what can you do", {
      mode: "manual",
      allowTools: false,
    });
    expect(can.system).toMatch(/model registry/i);
    expect(can.system).toMatch(/Setup & Doctor/);
    expect(can.system).toMatch(/FRIDAY live registries/);
  });

  it("consults stored knowledge so a later question actually uses the fact", async () => {
    const { brainKnowledge } = await import("../../src/lib/friday/brain/knowledge-base");
    brainKnowledge.remember({
      kind: "knowledge",
      title: "Zirconium teapot location",
      body: "The zirconium teapot-418 lives on the south shelf of the lab.",
      tags: ["zirconium", "teapot"],
      source: "owner",
      provenance: "user",
      confidence: 1,
    });
    const cognition = await coreBrain.cognize("where is the zirconium teapot", {
      mode: "manual",
      allowTools: false,
    });
    expect(cognition.system).toMatch(/zirconium teapot-418/i);
    expect(cognition.notes.join(" ")).toMatch(/recalled/i);
  });
});
